import { z } from "zod";
import { HttpError } from "@/lib/api";
import { all, getDb, one } from "@/lib/db/client";
import { recordDecision } from "@/lib/cases";
import type { Role } from "@/lib/session";

/**
 * Analyst workflow actions. Everything is appended to case_actions; nothing is edited or removed.
 * Customer-impacting actions are only ever *recommendations*: they wait for an authorised approver, and even an
 * approval is a record for the operations team: TRACE X itself holds, blocks and restricts nothing.
 */
export const CUSTOMER_IMPACTING = ["RECOMMEND_HOLD", "RECOMMEND_ENHANCED_VERIFICATION", "BLOCK_TRANSACTION", "RESTRICT_ACCOUNT", "TRANSFER_FUNDS", "ADVERSE_DECISION"] as const;
export const isCustomerImpacting = (action: string) => (CUSTOMER_IMPACTING as readonly string[]).includes(action);

export const ACTIONS = {
  REQUIRES_INVESTIGATION: { label: "Requires investigation", reason: false, decision: "REQUIRES_INVESTIGATION" },
  FALSE_POSITIVE: { label: "False positive", reason: true, decision: "FALSE_POSITIVE" },
  REQUEST_INFORMATION: { label: "Request information", reason: true },
  ESCALATE_SPECIALIST: { label: "Escalate to specialist", reason: true, decision: "ESCALATED" },
  ESCALATE_SUPERVISOR: { label: "Escalate to supervisor", reason: true, decision: "ESCALATED" },
  RECOMMEND_HOLD: { label: "Recommend temporary hold", reason: true, approval: true },
  RECOMMEND_ENHANCED_VERIFICATION: { label: "Recommend enhanced verification", reason: true, approval: true },
  CLOSE_CASE: { label: "Close case", reason: true },
  ADD_NOTE: { label: "Add investigator note", reason: true },
  SET_CONCLUSION: { label: "Record conclusion", reason: true },
} as const satisfies Record<string, { label: string; reason: boolean; decision?: string; approval?: boolean }>;
export type ActionName = keyof typeof ACTIONS;

const schema = z.object({
  action: z.enum(Object.keys(ACTIONS) as [ActionName, ...ActionName[]]),
  reason: z.string().trim().max(2000).optional().default(""),
  outcome: z.enum(["confirmed_fraud", "not_fraud", "inconclusive"]).optional(),
});

export type CaseActionRow = { id: number; case_id: string; action: string; status: string; reason: string | null; actor: string; ref_id: number | null; created_at: string };

/** Records one action. Roles only gate approvals; analysts and admins can both raise actions. */
export async function performAction(caseId: string, input: unknown, actor: string) {
  const a = schema.parse(input);
  const def = ACTIONS[a.action];
  if (!(await one("SELECT 1 FROM cases WHERE case_id = ?", [caseId]))) throw new HttpError(404, "Case not found");
  if (def.reason && a.reason.length < 5) throw new HttpError(400, `A reason is required for "${def.label}"`);
  if (a.action === "SET_CONCLUSION" && !a.outcome) throw new HttpError(400, "Choose a conclusion outcome");
  if ("decision" in def) await recordDecision(caseId, { decision: def.decision, note: `${def.label}: ${a.reason}`.trim(), analyst: actor });
  const status = "approval" in def ? "pending_approval" : "recorded";
  const reason = a.outcome ? `[${a.outcome}] ${a.reason}` : a.reason;
  const res = await (await getDb()).execute({
    sql: "INSERT INTO case_actions (case_id, action, status, reason, actor, ref_id, created_at) VALUES (?,?,?,?,?,?,?)",
    args: [caseId, a.action, status, reason || null, actor, null, new Date().toISOString()],
  });
  return { id: Number(res.lastInsertRowid), case_id: caseId, action: a.action, status, customer_impacting: isCustomerImpacting(a.action) };
}

/** Authorised approval of a recommendation. Only admins (supervisors) can approve, and never their own request. */
export async function decideApproval(caseId: string, actionId: number, outcome: "approved" | "rejected", reason: string, actor: string, role: Role) {
  if (role !== "admin") throw new HttpError(403, "Only a supervisor (admin) can approve or reject customer-impacting recommendations");
  const row = await one<CaseActionRow>("SELECT * FROM case_actions WHERE id = ? AND case_id = ?", [actionId, caseId]);
  if (!row || !isCustomerImpacting(row.action)) throw new HttpError(404, "No customer-impacting recommendation with that ID on this case");
  if (row.actor === actor) throw new HttpError(403, "A recommendation cannot be approved by the person who raised it");
  if (await one("SELECT 1 FROM case_actions WHERE action = 'APPROVAL_DECISION' AND ref_id = ?", [actionId])) throw new HttpError(409, "This recommendation has already been decided");
  if (reason.trim().length < 5) throw new HttpError(400, "A reason is required");
  await (await getDb()).execute({
    sql: "INSERT INTO case_actions (case_id, action, status, reason, actor, ref_id, created_at) VALUES (?,?,?,?,?,?,?)",
    args: [caseId, "APPROVAL_DECISION", outcome, reason.trim(), actor, actionId, new Date().toISOString()],
  });
  return { action_id: actionId, outcome };
}

export type ActionView = CaseActionRow & { label: string; effective_status: string; customer_impacting: boolean; approval: CaseActionRow | null };

/** Action history, newest first, with each recommendation's approval state resolved. */
export async function listActions(caseId: string): Promise<ActionView[]> {
  const rows = await all<CaseActionRow>("SELECT * FROM case_actions WHERE case_id = ? ORDER BY id DESC", [caseId]);
  const approvals = new Map(rows.filter((r) => r.action === "APPROVAL_DECISION").map((r) => [Number(r.ref_id), r]));
  return rows.map((r) => {
    const approval = approvals.get(Number(r.id)) ?? null;
    const label = r.action === "APPROVAL_DECISION" ? "Approval decision" : r.action === "SPLIT_CASE" ? "Case split" : (ACTIONS as Record<string, { label: string }>)[r.action]?.label ?? r.action;
    return { ...r, id: Number(r.id), label, customer_impacting: isCustomerImpacting(r.action), approval, effective_status: approval ? approval.status : r.status };
  });
}
