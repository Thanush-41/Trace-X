import { ACTIONS, isCustomerImpacting } from "@/lib/actions";
import type { TimelineEvent } from "@/lib/cases";
import type { Ref } from "@/lib/detect/types";
import { caseModelView } from "@/lib/ml/query";
import { scoreCase } from "@/lib/priority";
import { resolveRefs, type AlertRow } from "@/lib/queries";
import { chatJson } from "./llm";
import type { AgentStep, Assessment, Claim, Hypothesis, SqlRun, ToolCall } from "./investigate";
import { runAgentSql, SCHEMA_DOC } from "./sql-guard";
import { AGENT_CATEGORIES, type AgentCategory } from "./trust";

/**
 * Multi-agent investigation with an LLM:
 *   orchestrator → hypothesis agent → SQL agent (read-only, guarded, one self-repair) → reviewer agent → code verification.
 * The language model proposes; the code disposes. Every ID a reviewer cites must appear in a query result or in the
 * case's own records, otherwise the citation is dropped, and a "supported" verdict with no surviving citation is
 * downgraded to inconclusive. Customer-impacting actions are always marked as needing human approval.
 */
const PREFIX: [RegExp, Ref["table"]][] = [[/^CUS/, "customers"], [/^ACC/, "accounts"], [/^TXN/, "transactions"], [/^LGN/, "login_events"], [/^APP/, "loan_applications"], [/^CLM/, "insurance_claims"]];
const refOf = (id: string): Ref | null => { for (const [re, table] of PREFIX) if (re.test(id)) return { table, id }; return null; };
const ID_RE = /\b(?:CUS|ACC|TXN|LGN|APP|CLM|EXT|POL|DEV-)[0-9A-F]{4,}\b/g;
const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const ACTION_KEYS = Object.keys(ACTIONS).filter((a) => !["ADD_NOTE", "SET_CONCLUSION"].includes(a));

type Orchestrated = { brief: string; focus_entities: string[]; open_questions: string[]; hypothesis_budget: number };
type Hyp = { category: string; statement: string; supporting_ids: string[]; would_confirm: string; would_refute: string };
type Query = { hypothesis: number; purpose: string; sql: string };
type Review = {
  hypotheses: { index: number; verdict: "supported" | "refuted" | "inconclusive"; confidence: number; cited_ids: string[]; rationale: string }[];
  predicted_category: string; likely_benign: boolean; overall_confidence: number; reviewer_score: number; reviewer_notes: string;
  recommended_actions: { action: string; rationale: string }[]; missing_information: { item: string; why: string }[];
};

export function caseContext(c: { case_id: string; title: string; level: string; score: number }, alerts: AlertRow[], timeline: TimelineEvent[], extra: { graph: unknown; exposure: number; lessons: string[] }) {
  return JSON.stringify({
    case: { id: c.case_id, title: c.title, risk_level: c.level, risk_score: c.score, estimated_exposure_inr: extra.exposure },
    alerts: alerts.map((a) => ({
      detector: a.detector, category: a.category, level: a.level, score: a.score, title: a.title, primary_record: a.primary_ref.id,
      signals: a.signals.filter((s) => s.weight > 0).slice(0, 8).map((s) => `${s.label}: ${trunc(s.detail, 220)}`),
      legitimate_context: a.mitigations.map((m) => `${m.label}: ${trunc(m.detail, 160)}`),
      customers: a.customer_ids.slice(0, 8), accounts: a.account_ids.slice(0, 8), devices: a.device_ids.slice(0, 6), applications: a.application_ids.slice(0, 6), claims: a.claim_ids.slice(0, 6),
    })),
    timeline: timeline.filter((e) => e.role !== "baseline").slice(0, 45).map((e) => `${e.time.slice(0, 16)} [${e.role ?? ""}] ${e.kind}: ${trunc(e.summary, 140)} (${e.ref.id})`),
    graph_model: extra.graph,
    lessons_from_past_analyst_corrections: extra.lessons,
  });
}

export async function investigateLLM(c: { case_id: string; title: string; level: string; score: number }, alerts: AlertRow[], timeline: TimelineEvent[], lessons: string[]): Promise<Assessment> {
  const agents: AgentStep[] = [];
  const toolCalls: ToolCall[] = [];
  const step = async <T,>(agent: AgentStep["agent"], system: string, user: string, maxTokens = 1400): Promise<T> => {
    const r = await chatJson<T>(system, user, { maxTokens });
    agents.push({ agent, model: r.model, ms: r.ms, tokens: r.tokens, output: r.json });
    toolCalls.push({ tool: `${agent}_agent`, purpose: { orchestrator: "Read the case and plan the investigation", hypothesis: "Generate fraud hypotheses from the case records", sql: "Write SQL to test each hypothesis", reviewer: "Review the evidence and score the investigation" }[agent], ok: true, summary: `${r.model}, ${r.tokens} tokens, ${r.ms} ms`, evidence: [], result: null });
    return r.json;
  };

  const members = alerts.filter((a) => a.detector !== "FD-06");
  const customers = [...new Set(alerts.flatMap((a) => a.customer_ids))];
  const [scores, model] = await Promise.all([scoreCase(c, alerts), caseModelView(customers)]);
  const graph = { model: model.model, threshold: model.threshold, customers: model.customers.slice(0, 10).map((x) => ({ customer: x.customer_id, probability: x.score, drivers: x.drivers, neighbours: x.neighbours.slice(0, 3).map((n) => `${n.customer_id} via ${n.via.join(", ")}`) })) };
  const context = caseContext(c, members.length ? alerts : alerts, timeline, { graph, exposure: scores.exposure.inr, lessons });
  const categories = AGENT_CATEGORIES.join(" | ");

  // 1. Orchestrator
  const plan = await step<Orchestrated>("orchestrator",
    `You are the orchestrator of a bank fraud-investigation team (BFSI, India). Read the case and plan. Reply as JSON: {"brief": string (3 sentences, plain English, no speculation beyond the data), "focus_entities": string[] (IDs to investigate first), "open_questions": string[] (max 4, what the data does not yet show), "hypothesis_budget": 2|3|4}.`,
    context, 600);

  // 2. Hypothesis agent
  const hyp = await step<{ hypotheses: Hyp[] }>("hypothesis",
    `You are a senior fraud analyst. Generate competing hypotheses for this case, including a legitimate explanation when the evidence allows one. Categories: ${categories} | Likely legitimate. Use only IDs that appear in the case. Apply the lessons from past analyst corrections when they fit. Reply as JSON: {"hypotheses": [{"category": string, "statement": string, "supporting_ids": string[], "would_confirm": string, "would_refute": string}]}, at most ${Math.min(4, Math.max(2, plan.hypothesis_budget || 3))} hypotheses.`,
    `Orchestrator brief: ${plan.brief}\nOpen questions: ${(plan.open_questions ?? []).join("; ")}\nCase: ${context}`, 1200);
  const hypotheses = (hyp.hypotheses ?? []).slice(0, 4);

  // 3. SQL agent, with one repair round for failed queries
  const sqlPlan = await step<{ queries: Query[] }>("sql",
    `You write SQLite SELECT queries that test fraud hypotheses. ${SCHEMA_DOC}\nRules: SELECT only, one statement, no semicolons, always select the ID columns you rely on, prefer specific WHERE clauses on the case's IDs. Reply as JSON: {"queries": [{"hypothesis": number (0-based index), "purpose": string, "sql": string}]}, 1-2 queries per hypothesis, at most 6 in total.`,
    `Hypotheses: ${JSON.stringify(hypotheses.map((h, i) => ({ index: i, category: h.category, statement: h.statement, would_confirm: h.would_confirm, would_refute: h.would_refute })))}\nFocus entities: ${(plan.focus_entities ?? []).join(", ")}`, 1400);
  const sql: SqlRun[] = [];
  for (const q of (sqlPlan.queries ?? []).slice(0, 6)) {
    const r = await runAgentSql(q.sql);
    sql.push({ hypothesis: q.hypothesis, purpose: q.purpose, sql: q.sql, ...r });
  }
  const failed = sql.filter((s) => !s.ok);
  if (failed.length) {
    const fix = await step<{ queries: Query[] }>("sql",
      `Fix these SQLite queries. ${SCHEMA_DOC}\nSELECT only, one statement. Reply as JSON: {"queries": [{"hypothesis": number, "purpose": string, "sql": string}]} in the same order.`,
      JSON.stringify(failed.map((f) => ({ hypothesis: f.hypothesis, purpose: f.purpose, sql: f.sql, error: f.error }))), 900);
    for (const [i, q] of (fix.queries ?? []).slice(0, failed.length).entries()) {
      const r = await runAgentSql(q.sql);
      if (r.ok) Object.assign(failed[i], { sql: q.sql, ...r, error: undefined, repaired: true });
    }
  }
  for (const s of sql) toolCalls.push({ tool: "run_sql", purpose: s.purpose, ok: s.ok, summary: s.ok ? `${s.row_count} row(s)${s.repaired ? " after self-repair" : ""}` : `rejected: ${s.error}`, evidence: [], result: null });

  // 4. Reviewer agent
  const review = await step<Review>("reviewer",
    `You are the reviewing fraud manager. Judge each hypothesis strictly from the query results and case records. Cite only IDs present in the results or the case. Score the investigation quality (reviewer_score 0-1: were the right questions asked, do the queries actually test the hypotheses, is the conclusion supported). Allowed actions: ${ACTION_KEYS.join(", ")}. Holds and enhanced verification are recommendations only. Categories: ${categories}. Reply as JSON: {"hypotheses": [{"index": number, "verdict": "supported"|"refuted"|"inconclusive", "confidence": number 0-1, "cited_ids": string[], "rationale": string}], "predicted_category": string (one of the categories), "likely_benign": boolean, "overall_confidence": number 0-1, "reviewer_score": number 0-1, "reviewer_notes": string, "recommended_actions": [{"action": string, "rationale": string}], "missing_information": [{"item": string, "why": string}]}`,
    `Hypotheses: ${JSON.stringify(hypotheses)}\nQuery results: ${JSON.stringify(sql.map((s) => ({ hypothesis: s.hypothesis, purpose: s.purpose, ok: s.ok, error: s.error, rows: s.rows.slice(0, 15) })))}\nCase: ${trunc(context, 9000)}`, 1600);

  // 5. Verification in code
  const caseRefs = [...new Map(alerts.flatMap((a) => [a.primary_ref, ...a.evidence]).map((r) => [`${r.table}:${r.id}`, r])).values()];
  const visible = new Set<string>([...caseRefs.map((r) => r.id), ...alerts.flatMap((a) => [...a.customer_ids, ...a.account_ids, ...a.device_ids, ...a.application_ids, ...a.claim_ids, ...a.transaction_ids])]);
  for (const s of sql) for (const row of s.rows) for (const v of Object.values(row)) if (typeof v === "string") for (const m of v.match(ID_RE) ?? []) visible.add(m);
  const candidate = [...new Set((review.hypotheses ?? []).flatMap((h) => h.cited_ids ?? []))].map(refOf).filter(Boolean) as Ref[];
  const exists = await resolveRefs(candidate);
  let total = 0, verified = 0;
  const dropped: string[] = [];
  const out: Hypothesis[] = [];
  for (const r of review.hypotheses ?? []) {
    const h = hypotheses[r.index];
    if (!h) continue;
    const ids = r.cited_ids ?? [];
    total += ids.length;
    const good = ids.filter((id) => visible.has(id) && (!refOf(id) || exists.has(`${refOf(id)!.table}:${id}`)));
    verified += good.length;
    ids.filter((id) => !good.includes(id)).forEach((id) => dropped.push(`${id} (cited for "${trunc(h.statement, 60)}" but not found in results or records)`));
    let verdict = r.verdict;
    if (verdict === "supported" && good.length === 0) { verdict = "inconclusive"; dropped.push(`"${trunc(h.statement, 80)}" downgraded to inconclusive: no verified citation`); }
    const refs = good.map(refOf).filter(Boolean) as Ref[];
    const claim: Claim = { text: `${h.statement}. Reviewer: ${r.rationale}${good.length ? ` [${good.slice(0, 6).join(", ")}]` : ""}`, stance: verdict === "refuted" ? "contradicts" : "supports", weight: 1, evidence: refs.length ? refs : caseRefs.slice(0, 1), check: { type: "exists", refs: refs.length ? refs : caseRefs.slice(0, 1) } };
    const category = (AGENT_CATEGORIES as readonly string[]).includes(h.category) ? (h.category as AgentCategory) : "Likely legitimate";
    const conf = Math.max(0, Math.min(1, Number(r.confidence) || 0)) * (verdict === "supported" ? 1 : verdict === "inconclusive" ? 0.5 : 0.1);
    out.push({ category, confidence: Math.round(conf * 100) / 100, supports: verdict === "refuted" ? [] : [claim], contradicts: verdict === "refuted" ? [claim] : [] });
  }
  out.sort((a, b) => b.confidence - a.confidence);
  const predicted = ((AGENT_CATEGORIES as readonly string[]).includes(review.predicted_category) ? review.predicted_category : out.find((h) => h.category !== "Likely legitimate")?.category ?? "Suspicious transfers") as AgentCategory;
  const grounding = total ? Math.round((verified / total) * 100) / 100 : 0;
  const recs = (review.recommended_actions ?? []).filter((a) => ACTION_KEYS.includes(a.action)).slice(0, 5).map((a) => ({
    action: a.action, label: (ACTIONS as Record<string, { label: string }>)[a.action].label, rationale: a.rationale, customer_impacting: isCustomerImpacting(a.action), requires_human_approval: true, evidence: [] as Ref[],
  }));

  return {
    case_id: c.case_id, mode: "llm-multi-agent", generated_at: new Date().toISOString(), tool_calls: toolCalls,
    missing_information: (review.missing_information ?? []).slice(0, 6),
    hypotheses: out, predicted_category: predicted, likely_benign: !!review.likely_benign,
    confidence: Math.round(Math.max(0, Math.min(1, Number(review.overall_confidence) || 0)) * grounding * 100) / 100,
    priority: { tier: scores.priority.tier, score: scores.priority.score, reason: scores.priority.reason },
    recommended_actions: recs,
    verification: { claims_total: total, claims_verified: verified, dropped, grounding },
    learning: { signature: [...new Set(members.map((a) => a.detector))].sort().join("+") || "none", adjustments: {} },
    scores: { risk: scores.risk, confidence: scores.confidence, exposure: scores.exposure },
    agents, sql, reviewer_score: Math.round(Math.max(0, Math.min(1, Number(review.reviewer_score) || 0)) * 100) / 100, model: agents[0]?.model, lessons_used: lessons,
  };
}
