import type { InValue } from "@libsql/client";
import { z } from "zod";
import { HttpError } from "@/lib/api";
import { all, getDb, one } from "@/lib/db/client";
import type { Ref } from "@/lib/detect/types";
import { CASE_STATUS_SQL, parseAlert, resolveRefs, type AlertRow } from "@/lib/queries";

export const DECISIONS = ["REQUIRES_INVESTIGATION", "ESCALATED", "FALSE_POSITIVE", "DISMISSED"] as const;
export const STATUS_LABEL: Record<string, string> = {
  OPEN: "Open", REQUIRES_INVESTIGATION: "Requires investigation", ESCALATED: "Escalated", FALSE_POSITIVE: "False positive", DISMISSED: "Dismissed",
};

export type CaseRow = {
  case_id: string; title: string; category: string; level: "High" | "Medium" | "Low"; score: number;
  primary_customer_id: string | null; primary_account_id: string | null; created_at: string; first_run_id: string;
  status: string; alert_count: number; decided_at: string | null; current_level: string; current_category: string; current_run: number;
};

const CURRENT = (col: "revised_level" | "revised_category", fallback: string) =>
  `COALESCE((SELECT d.${col} FROM case_decisions d WHERE d.case_id = c.case_id AND d.${col} IS NOT NULL ORDER BY d.id DESC LIMIT 1), ${fallback})`;

const CASE_SELECT = `SELECT c.*, ${CASE_STATUS_SQL} AS status,
  (SELECT COUNT(*) FROM case_alerts ca WHERE ca.case_id = c.case_id) AS alert_count,
  (SELECT MAX(d.created_at) FROM case_decisions d WHERE d.case_id = c.case_id) AS decided_at,
  ${CURRENT("revised_level", "c.level")} AS current_level,
  ${CURRENT("revised_category", "c.category")} AS current_category,
  EXISTS (SELECT 1 FROM case_alerts ca JOIN run_alerts ra ON ra.alert_id = ca.alert_id
          WHERE ca.case_id = c.case_id AND ra.run_id = (SELECT run_id FROM detection_runs ORDER BY started_at DESC, rowid DESC LIMIT 1)) AS current_run
  FROM cases c`;

export type CaseFilters = { status?: string; level?: string; category?: string; customer?: string; superseded?: boolean };

export async function listCases(f: CaseFilters = {}) {
  const where: string[] = [];
  const args: InValue[] = [];
  // Cases whose alerts are not in the latest detection run belong to an earlier state of the data.
  const latest = "(SELECT run_id FROM detection_runs ORDER BY started_at DESC, rowid DESC LIMIT 1)";
  where.push(`${f.superseded ? "NOT " : ""}EXISTS (SELECT 1 FROM case_alerts ca JOIN run_alerts ra ON ra.alert_id = ca.alert_id WHERE ca.case_id = c.case_id AND ra.run_id = ${latest})`);
  if (f.status === "open") where.push(`${CASE_STATUS_SQL} IN ('OPEN','REQUIRES_INVESTIGATION','ESCALATED')`);
  else if (f.status === "closed") where.push(`${CASE_STATUS_SQL} IN ('FALSE_POSITIVE','DISMISSED')`);
  else if (f.status) { where.push(`${CASE_STATUS_SQL} = ?`); args.push(f.status); }
  if (f.level) { where.push("c.level = ?"); args.push(f.level); }
  if (f.category) { where.push("c.category = ?"); args.push(f.category); }
  if (f.customer) {
    where.push("EXISTS (SELECT 1 FROM case_alerts ca JOIN alerts a ON a.alert_id = ca.alert_id, json_each(a.customer_ids) j WHERE ca.case_id = c.case_id AND j.value = ?)");
    args.push(f.customer.trim());
  }
  const sql = `${CASE_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY CASE c.level WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END, c.score DESC, c.created_at`;
  const rows = await all<CaseRow>(sql, args);
  return rows.map((r) => ({ ...r, score: Number(r.score), alert_count: Number(r.alert_count), current_run: Number(r.current_run) }));
}

/**
 * `system` names the source system so a journey across products is visible at a glance.
 * `role` says why the event is on the timeline: it raised an alert (trigger), supports a signal (evidence),
 * is when a customer or account was created (profile), or is normal history used only for comparison (baseline).
 */
export type TimelineRole = "trigger" | "evidence" | "profile" | "baseline";
export type TimelineEvent = { ref: Ref; time: string; kind: string; summary: string; customer?: string; system?: string; role?: TimelineRole; why?: string; flagged: boolean };

/** Signals whose evidence is the customer's normal past behaviour, shown only as the comparison baseline. */
const BASELINE_CODES = new Set(["AMOUNT_OUTLIER", "UNUSUAL_CHANNEL", "WITHIN_CUSTOMER_NORM", "ESTABLISHED_BENEFICIARY", "LONG_STANDING_USE"]);

/** Tags each timeline event with its role and the signal that put it there. */
export function assignRoles(alerts: AlertRow[], events: TimelineEvent[]): TimelineEvent[] {
  const triggers = new Map<string, string>();
  const reasons = new Map<string, { label: string; baseline: boolean }>();
  for (const a of alerts) {
    if (a.detector !== "FD-06") triggers.set(`${a.primary_ref.table}:${a.primary_ref.id}`, `raised ${a.detector} ${a.category}`);
    for (const r of [...a.signals, ...a.mitigations]) {
      for (const e of r.evidence) {
        const k = `${e.table}:${e.id}`;
        const baseline = BASELINE_CODES.has(r.code) && k !== `${a.primary_ref.table}:${a.primary_ref.id}`;
        const prev = reasons.get(k);
        if (!prev || (prev.baseline && !baseline)) reasons.set(k, { label: `${r.label} (${a.detector})`, baseline });
      }
    }
  }
  return events.map((e) => {
    const k = `${e.ref.table}:${e.ref.id}`;
    if (triggers.has(k)) return { ...e, role: "trigger", why: triggers.get(k) };
    if (e.ref.table === "customers" || e.ref.table === "accounts") return { ...e, role: "profile", why: reasons.get(k)?.label };
    const r = reasons.get(k);
    return { ...e, role: r?.baseline ? "baseline" : "evidence", why: r?.label };
  });
}

export async function getCase(id: string) {
  const c = await one<CaseRow>(`${CASE_SELECT} WHERE c.case_id = ?`, [id]);
  if (!c) return null;
  const [alertRows, decisions] = await Promise.all([
    all<Record<string, unknown>>(
      "SELECT a.* FROM alerts a JOIN case_alerts ca ON ca.alert_id = a.alert_id WHERE ca.case_id = ? ORDER BY (a.detector = 'FD-06') DESC, a.score DESC",
      [id],
    ),
    all<{ id: number; decision: string; note: string | null; analyst: string; revised_level: string | null; revised_category: string | null; created_at: string }>(
      "SELECT * FROM case_decisions WHERE case_id = ? ORDER BY id DESC",
      [id],
    ),
  ]);
  const alerts = alertRows.map(parseAlert);
  const refs = alerts.flatMap((a) => [a.primary_ref, ...a.evidence]);
  const rows = await resolveRefs(refs);
  const flagged = new Set(alerts.map((a) => `${a.primary_ref.table}:${a.primary_ref.id}`));
  const timeline: TimelineEvent[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    const key = `${r.table}:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = rows.get(key);
    if (!row) continue;
    const event = describe(r, row);
    if (event) timeline.push({ ...event, flagged: flagged.has(key) });
  }
  timeline.sort((a, b) => a.time.localeCompare(b.time));
  const roled = assignRoles(alerts, timeline);
  return { case: { ...c, score: Number(c.score), alert_count: Number(c.alert_count), current_run: Number(c.current_run) }, alerts, decisions, timeline: roled, rows };
}

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

/** One line per source record, for timelines. Profiles and accounts have no event time and are skipped. */
const SYSTEM: Record<string, string> = { banking: "Core banking", lending: "Lending", insurance: "Insurance", cards: "Cards" };

export function describe(ref: Ref, row: Record<string, unknown>): Omit<TimelineEvent, "flagged"> | null {
  const e = describeEvent(ref, row);
  if (!e) return null;
  const system = ref.table === "transactions" ? (row.type === "disbursement" ? "Lending" : "Core banking")
    : ref.table === "login_events" ? "Digital channel"
    : ref.table === "loan_applications" ? "Lending"
    : ref.table === "insurance_claims" ? "Insurance"
    : ref.table === "accounts" ? SYSTEM[String(row.product)] ?? "Core banking"
    : "KYC / onboarding";
  return { ...e, system };
}

function describeEvent(ref: Ref, row: Record<string, unknown>): Omit<TimelineEvent, "flagged"> | null {
  const s = (k: string) => String(row[k] ?? "");
  switch (ref.table) {
    case "customers":
      return row.onboarding_date ? { ref, time: s("onboarding_date"), kind: "customer onboarded", customer: s("customer_id"), summary: `${s("full_name")} (${s("customer_id")}) onboarded${row.onboarding_channel ? ` via ${s("onboarding_channel")}` : ""}${row.city ? `, ${s("city")}` : ""}` } : null;
    case "accounts":
      return row.opened_at ? { ref, time: s("opened_at"), kind: "account opened", customer: s("customer_id"), summary: `${s("product")} account ${s("account_id")} opened for ${s("customer_id")}${row.account_type ? ` (${s("account_type")})` : ""}` } : null;
    case "transactions":
      return {
        ref, time: s("timestamp"), kind: s("type") || "transfer", customer: undefined,
        summary: `₹${inr.format(Number(row.amount))} ${s("account_id")} → ${s("beneficiary_account")}${row.beneficiary_name ? ` (${s("beneficiary_name")})` : ""} via ${s("channel")}${s("status") !== "completed" ? ` · ${s("status")}` : ""}`,
      };
    case "login_events":
      return {
        ref, time: s("timestamp"), kind: s("event_type") === "login" ? (s("outcome") === "failure" ? "login failed" : "login") : s("event_type").replace(/_/g, " "), customer: s("customer_id"),
        summary: `${s("customer_id")} on ${s("device_id")}${row.ip_address ? ` from ${s("ip_address")}` : ""}${row.geo ? `, ${s("geo")}` : ""}`,
      };
    case "loan_applications":
      return {
        ref, time: s("submitted_at"), kind: "loan application", customer: s("customer_id"),
        summary: `${s("customer_id")} applied for ₹${inr.format(Number(row.requested_amount))}${row.device_id ? ` on ${s("device_id")}` : ""}, payout to ${s("payout_account")}`,
      };
    case "insurance_claims":
      return {
        ref, time: s("submitted_at"), kind: `${s("claim_type")} claim`, customer: s("customer_id"),
        summary: `${s("customer_id")} claimed ₹${inr.format(Number(row.claim_amount))} on policy ${s("policy_id")} for loss on ${s("incident_date").slice(0, 10)}${row.provider_id ? ` at ${s("provider_id")}` : ""}, payout to ${s("payout_account")}`,
      };
    default:
      return null;
  }
}

export const decisionSchema = z.object({
  decision: z.enum(DECISIONS),
  note: z.string().trim().max(2000).optional().default(""),
  analyst: z.string().trim().min(1, "Analyst name is required").max(80),
  revised_level: z.enum(["High", "Medium", "Low"]).nullish(),
  revised_category: z.string().trim().max(80).nullish(),
});

/** Appends a decision. The case and its alerts are never modified; status is always the latest decision. */
export async function recordDecision(caseId: string, input: unknown) {
  const d = decisionSchema.parse(input);
  const c = await one<{ level: string; category: string }>("SELECT level, category FROM cases WHERE case_id = ?", [caseId]);
  if (!c) throw new HttpError(404, "Case not found");
  if ((d.decision === "FALSE_POSITIVE" || d.decision === "DISMISSED") && d.note.length < 5) {
    throw new HttpError(400, "A note explaining the decision is required for False positive and Dismissed");
  }
  const revisedLevel = d.revised_level && d.revised_level !== c.level ? d.revised_level : null;
  const revisedCategory = d.revised_category && d.revised_category !== c.category ? d.revised_category : null;
  const db = await getDb();
  const res = await db.execute({
    sql: "INSERT INTO case_decisions (case_id, decision, note, analyst, revised_level, revised_category, created_at) VALUES (?,?,?,?,?,?,?)",
    args: [caseId, d.decision, d.note || null, d.analyst, revisedLevel, revisedCategory, new Date().toISOString()],
  });
  return { id: Number(res.lastInsertRowid), case_id: caseId, ...d, revised_level: revisedLevel, revised_category: revisedCategory };
}
