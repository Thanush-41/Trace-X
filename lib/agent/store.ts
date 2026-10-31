import { z } from "zod";
import { HttpError } from "@/lib/api";
import { all, getDb, one } from "@/lib/db/client";
import { getCase } from "@/lib/cases";
import { policy } from "@/lib/policy";
import { investigate, type Assessment } from "./investigate";
import { investigateLLM } from "./multi";
import { llmEnabled } from "./llm";
import { learnLesson, lessonsFor } from "./learn";
import { AGENT_CATEGORIES, computeTrust, learnFrom, levelFor, LEVEL_NAME, splitFor, trustFrom, type CategoryTrust, type FeedbackRow, type Level, type Thresholds } from "./trust";
import { CUSTOMER_IMPACTING, isCustomerImpacting } from "@/lib/actions";
import { resolveRefs } from "@/lib/queries";

export type StoredAssessment = { id: number; case_id: string; created_by: string; created_at: string; assessment: Assessment };

// ── Settings: kill switch and threshold overrides survive a workspace reset ──────────────────────────────
export async function getSettings(): Promise<{ kill_switch: boolean; thresholds: Thresholds; updated_by: string | null; updated_at: string | null }> {
  const rows = await all<{ key: string; value: string; updated_by: string; updated_at: string }>("SELECT * FROM agent_settings");
  const get = (key: string) => rows.find((r) => r.key === key);
  const override = get("thresholds") ? (JSON.parse(get("thresholds")!.value) as Partial<Thresholds>) : {};
  const t = policy.agent.levels;
  return {
    kill_switch: get("kill_switch")?.value === "1",
    thresholds: { L1: { ...t.L1, ...override.L1 }, L2: { ...t.L2, ...override.L2 }, L3: { ...t.L3, ...override.L3 } },
    updated_by: rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]?.updated_by ?? null,
    updated_at: rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]?.updated_at ?? null,
  };
}
async function setSetting(key: string, value: string, actor: string) {
  await (await getDb()).execute({ sql: "INSERT INTO agent_settings (key, value, updated_by, updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at", args: [key, value, actor, new Date().toISOString()] });
}
export const setKillSwitch = (on: boolean, actor: string) => setSetting("kill_switch", on ? "1" : "0", actor);
const thresholdsSchema = z.object({
  L2: z.object({ minFeedback: z.number().int().min(1), minTrust: z.number().min(0).max(1) }).partial().optional(),
  L3: z.object({ minFeedback: z.number().int().min(5), minTrust: z.number().min(0.5).max(1), minHoldout: z.number().int().min(3), minHoldoutAccuracy: z.number().min(0.5).max(1) }).partial().optional(),
});
/** Thresholds may only be made stricter than the safe floor in the schema; they can never disable the holdout requirement. */
export async function setThresholds(input: unknown, actor: string) {
  const parsed = thresholdsSchema.parse(input);
  await setSetting("thresholds", JSON.stringify(parsed), actor);
}

// ── Assessments ────────────────────────────────────────────────────────────────────────────────────────
export async function loadFeedback(): Promise<FeedbackRow[]> {
  return (await all<FeedbackRow>("SELECT * FROM agent_feedback ORDER BY id")).map((r) => ({ ...r, id: Number(r.id), grounding: Number(r.grounding) }));
}

export async function latestAssessment(caseId: string): Promise<StoredAssessment | null> {
  const r = await one<{ id: number; case_id: string; created_by: string; created_at: string; assessment_json: string }>("SELECT * FROM agent_assessments WHERE case_id = ? ORDER BY id DESC LIMIT 1", [caseId]);
  return r ? { id: Number(r.id), case_id: r.case_id, created_by: r.created_by, created_at: r.created_at, assessment: JSON.parse(r.assessment_json) } : null;
}
export async function listAssessments(caseId: string): Promise<StoredAssessment[]> {
  return (await all<{ id: number; case_id: string; created_by: string; created_at: string; assessment_json: string }>("SELECT * FROM agent_assessments WHERE case_id = ? ORDER BY id DESC", [caseId]))
    .map((r) => ({ id: Number(r.id), case_id: r.case_id, created_by: r.created_by, created_at: r.created_at, assessment: JSON.parse(r.assessment_json) }));
}

/** Runs the agent on a case, stores the assessment, and applies any permitted autonomous internal actions. */
export async function runAgent(caseId: string, actor: string, opts: { mode?: "auto" | "deterministic" } = {}) {
  const data = await getCase(caseId);
  if (!data) throw new HttpError(404, "Case not found");
  const feedback = await loadFeedback();
  const fallback = () => investigate(data.case, data.alerts, learnFrom(feedback));
  let assessment: Assessment;
  if (llmEnabled() && opts.mode !== "deterministic") {
    const signature = [...new Set(data.alerts.filter((a) => a.detector !== "FD-06").map((a) => a.detector))].sort().join("+") || "none";
    try {
      assessment = await investigateLLM(data.case, data.alerts, data.timeline, await lessonsFor(signature));
    } catch (e) {
      // Any model or network failure falls back to the deterministic agent, and says so.
      assessment = { ...(await fallback()), fallback_reason: `Language-model agents unavailable (${(e as Error).message.slice(0, 120)}); deterministic agent used` };
    }
  } else assessment = await fallback();
  const res = await (await getDb()).execute({
    sql: "INSERT INTO agent_assessments (case_id, mode, predicted_category, confidence, grounding, assessment_json, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)",
    args: [caseId, assessment.mode, assessment.predicted_category, assessment.confidence, assessment.verification.grounding, JSON.stringify(assessment), actor, assessment.generated_at],
  });
  const stored: StoredAssessment = { id: Number(res.lastInsertRowid), case_id: caseId, created_by: actor, created_at: assessment.generated_at, assessment };
  const autonomous = await applyAutonomy(stored, feedback);
  return { ...stored, autonomous };
}

// ── Feedback ───────────────────────────────────────────────────────────────────────────────────────────
const feedbackSchema = z.object({
  outcome: z.enum(["accepted", "corrected", "rejected"]),
  corrected_category: z.string().optional(),
  reasoning: z.string().trim().max(2000).optional().default(""),
  evidence: z.array(z.string()).max(20).optional().default([]),
  assessment_id: z.number().int().optional(),
});

/** Captures whether the analyst accepted, corrected or rejected the agent's recommendation, then reports the trust change. */
export async function recordFeedback(caseId: string, input: unknown, actor: string, source: "analyst" | "answer_key_replay" = "analyst") {
  const f = feedbackSchema.parse(input);
  const a = f.assessment_id ? (await listAssessments(caseId)).find((x) => x.id === f.assessment_id) : await latestAssessment(caseId);
  if (!a) throw new HttpError(409, "Run the agent on this case first: feedback is always attached to a specific assessment");
  if (f.outcome !== "accepted" && f.reasoning.length < 5) throw new HttpError(400, "Explain the correction or rejection (at least 5 characters)");
  if (f.outcome === "corrected") {
    if (!f.corrected_category || !(AGENT_CATEGORIES as readonly string[]).includes(f.corrected_category)) throw new HttpError(400, "Choose the corrected category");
    if (f.corrected_category === a.assessment.predicted_category) throw new HttpError(400, "The corrected category equals the agent's prediction; accept it instead");
  }
  const refs = f.evidence.map((e) => { const [table, ...id] = e.split(":"); return { table: table as never, id: id.join(":") }; });
  if (refs.length) {
    const found = await resolveRefs(refs);
    const bad = refs.filter((r) => !found.has(`${r.table}:${r.id}`));
    if (bad.length) throw new HttpError(400, `Evidence not found in the workspace: ${bad.map((b) => `${b.table}:${b.id}`).join(", ")}`);
  }
  const before = (await trustReport()).find((c) => c.category === a.assessment.predicted_category)!;
  const res = await (await getDb()).execute({
    sql: `INSERT INTO agent_feedback (assessment_id, case_id, predicted_category, outcome, corrected_category, reasoning, evidence_json, grounding, source, split, signature, actor, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [a.id, caseId, a.assessment.predicted_category, f.outcome, f.outcome === "corrected" ? f.corrected_category! : null, f.reasoning || null, JSON.stringify(f.evidence), a.assessment.verification.grounding, source, splitFor(caseId), a.assessment.learning.signature, actor, new Date().toISOString()],
  });
  const after = (await trustReport()).find((c) => c.category === a.assessment.predicted_category)!;
  const lesson = await learnLesson({ feedback_id: Number(res.lastInsertRowid), assessment: a.assessment, outcome: f.outcome, human_category: f.outcome === "corrected" ? f.corrected_category! : f.outcome === "accepted" ? a.assessment.predicted_category : "Not fraud", reasoning: f.reasoning, split: splitFor(caseId) });
  return {
    feedback_id: Number(res.lastInsertRowid), category: after.category, split: splitFor(caseId), lesson,
    before: { trust: before.trust, level: before.level, n: before.n }, after: { trust: after.trust, level: after.level, n: after.n },
    loop: `Assessment #${a.id} → ${f.outcome} by ${actor} → feedback #${res.lastInsertRowid} (${splitFor(caseId)}) → trust ${before.trust.toFixed(3)} → ${after.trust.toFixed(3)} → ${LEVEL_NAME[after.level]}`,
  };
}

export async function trustReport(opts: { includeSimulated?: boolean } = {}): Promise<CategoryTrust[]> {
  const s = await getSettings();
  return computeTrust(await loadFeedback(), s.thresholds, opts);
}

// ── Autonomy ───────────────────────────────────────────────────────────────────────────────────────────
/** Reversible, internal, low-impact actions only. Anything customer-impacting is refused here, whatever the trust. */
export const AUTONOMOUS_ALLOWLIST = policy.agent.autonomousAllowlist as readonly string[];
export function assertAgentMayPerform(action: string) {
  if (isCustomerImpacting(action) || (CUSTOMER_IMPACTING as readonly string[]).includes(action)) throw new HttpError(403, `"${action}" affects customers and always needs explicit human authorisation`);
  if (!AUTONOMOUS_ALLOWLIST.includes(action)) throw new HttpError(403, `"${action}" is not on the autonomous allowlist`);
}

const QUEUE: Record<string, string> = {
  "Account takeover": "Digital fraud desk", "Shared-device coordination": "Network analysis", "Identity fraud": "KYC review", "Loan fraud": "Credit fraud desk",
  "Insurance fraud": "Claims investigation", "Suspicious transfers": "Payments fraud desk", "Cross-system fraud": "Senior investigations",
};

async function applyAutonomy(a: StoredAssessment, feedback: FeedbackRow[]) {
  const settings = await getSettings();
  const cat = a.assessment.predicted_category;
  const stat = computeTrust(feedback, settings.thresholds).find((c) => c.category === cat)!;
  const out: { level: Level; performed: string[]; blocked: string | null } = { level: stat.level, performed: [], blocked: null };
  if (stat.level < 3) { out.blocked = `${LEVEL_NAME[stat.level]}: autonomy starts at L3`; return out; }
  if (settings.kill_switch) { out.blocked = "Global kill switch is on: no autonomous actions"; return out; }
  const db = await getDb();
  const now = new Date().toISOString();
  const actor = `TRACE X agent (${LEVEL_NAME[3]})`;
  const steps: [string, string][] = [
    ["LABEL_CASE", `Labelled "${cat}" with ${Math.round(a.assessment.confidence * 100)}% evidence confidence`],
    ["ROUTE_TO_QUEUE", `Routed to ${QUEUE[cat]}`],
    ["REQUEST_ANALYST_REVIEW", `Requested analyst review of assessment #${a.id}; no decision was taken`],
  ];
  for (const [action, detail] of steps) {
    assertAgentMayPerform(action);
    await db.execute({ sql: "INSERT INTO agent_actions (case_id, category, action, autonomy_level, detail, reversible, created_at) VALUES (?,?,?,?,?,1,?)", args: [a.case_id, cat, action, 3, detail, now] });
    await db.execute({ sql: "INSERT INTO case_actions (case_id, action, status, reason, actor, ref_id, created_at) VALUES (?,?,?,?,?,?,?)", args: [a.case_id, action, "recorded", detail, actor, a.id, now] });
    out.performed.push(action);
  }
  return out;
}

export async function listAgentActions(limit = 50) {
  return all<{ id: number; case_id: string; category: string; action: string; autonomy_level: number; detail: string; reversible: number; created_at: string }>("SELECT * FROM agent_actions ORDER BY id DESC LIMIT ?", [limit]);
}

export { levelFor, trustFrom };
