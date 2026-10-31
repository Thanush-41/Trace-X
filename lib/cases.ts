import type { InValue } from "@libsql/client";
import { z } from "zod";
import { HttpError } from "@/lib/api";
import { all, getDb, one } from "@/lib/db/client";
import type { Ref } from "@/lib/detect/types";
import { CASE_STATUS_SQL, parseAlert, resolveRefs } from "@/lib/queries";

export const DECISIONS = ["REQUIRES_INVESTIGATION", "ESCALATED", "FALSE_POSITIVE", "DISMISSED"] as const;
export const STATUS_LABEL: Record<string, string> = {
  OPEN: "Open", REQUIRES_INVESTIGATION: "Requires investigation", ESCALATED: "Escalated", FALSE_POSITIVE: "False positive", DISMISSED: "Dismissed",
};

export type CaseRow = {
  case_id: string; title: string; category: string; level: "High" | "Medium" | "Low"; score: number;
  primary_customer_id: string | null; primary_account_id: string | null; created_at: string; first_run_id: string;
  status: string; alert_count: number; decided_at: string | null; current_level: string; current_category: string;
};

const CURRENT = (col: "revised_level" | "revised_category", fallback: string) =>
  `COALESCE((SELECT d.${col} FROM case_decisions d WHERE d.case_id = c.case_id AND d.${col} IS NOT NULL ORDER BY d.id DESC LIMIT 1), ${fallback})`;

const CASE_SELECT = `SELECT c.*, ${CASE_STATUS_SQL} AS status,
  (SELECT COUNT(*) FROM case_alerts ca WHERE ca.case_id = c.case_id) AS alert_count,
  (SELECT MAX(d.created_at) FROM case_decisions d WHERE d.case_id = c.case_id) AS decided_at,
  ${CURRENT("revised_level", "c.level")} AS current_level,
  ${CURRENT("revised_category", "c.category")} AS current_category
  FROM cases c`;

export type CaseFilters = { status?: string; level?: string; category?: string; customer?: string };

export async function listCases(f: CaseFilters = {}) {
  const where: string[] = [];
  const args: InValue[] = [];
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
  return rows.map((r) => ({ ...r, score: Number(r.score), alert_count: Number(r.alert_count) }));
}

export type TimelineEvent = { ref: Ref; time: string; kind: string; summary: string; customer?: string; flagged: boolean };

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
  return { case: { ...c, score: Number(c.score), alert_count: Number(c.alert_count) }, alerts, decisions, timeline, rows };
}

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

/** One line per source record, for timelines. Profiles and accounts have no event time and are skipped. */
export function describe(ref: Ref, row: Record<string, unknown>): Omit<TimelineEvent, "flagged"> | null {
  const s = (k: string) => String(row[k] ?? "");
  switch (ref.table) {
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
