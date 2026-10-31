import { HttpError } from "@/lib/api";
import { getDb, all, one } from "@/lib/db/client";
import { loadContext } from "@/lib/detect/context";
import { describeKey, entityKeys } from "@/lib/detect/fd06-cross-system";
import type { Ref, ScoredFinding } from "@/lib/detect/types";
import { policy } from "@/lib/policy";
import { idFrom, sha256 } from "@/lib/util/hash";
import { parseAlert, type AlertRow } from "@/lib/queries";
import { z } from "zod";

const FIELD: Record<string, string> = {
  cust: "customer_id", acct: "account_id (owner, beneficiary or payout account)", dev: "device_id", app: "loan_applications.application_id", txn: "transactions.transaction_id",
  clm: "insurance_claims.claim_id", phone: "customers.phone_norm", ip: "login_events.ip_address", pol: "insurance_claims.policy_id", doc: "insurance_claims.document_hash",
};

export type SharedEntity = {
  key: string; kind: string; label: string; field: string; timed: boolean; within_window: boolean | null;
  alerts: { alert_id: string; detector: string; title: string; event_time: string }[]; span_days: number; refs: Ref[];
};
export type GroupingExplanation = {
  summary: string; shared: SharedEntity[]; excluded_hubs: { key: string; label: string; customers: number }[];
  per_alert: { alert_id: string; connected_via: string[]; weakly_connected: boolean }[]; window_days: number;
};

/** Why the alerts of a case were grouped: the shared entities, the source field that matched and the time relationship. */
export async function explainGrouping(alerts: AlertRow[]): Promise<GroupingExplanation> {
  const members = alerts.filter((a) => a.detector !== "FD-06");
  const ctx = await loadContext();
  const asFinding = (a: AlertRow) => ({
    entities: { customers: new Set(a.customer_ids), accounts: new Set(a.account_ids), transactions: new Set(a.transaction_ids), devices: new Set(a.device_ids), applications: new Set(a.application_ids), claims: new Set(a.claim_ids) },
    evidence: a.evidence,
  }) as unknown as ScoredFinding;
  const byKey = new Map<string, AlertRow[]>();
  const hubs = new Map<string, { key: string; label: string; customers: number }>();
  for (const a of members) {
    const f = asFinding(a);
    for (const key of entityKeys(ctx, f)) byKey.set(key, [...(byKey.get(key) ?? []), a]);
    for (const id of a.account_ids) if (ctx.isHubAccount(id)) hubs.set(`acct:${id}`, { key: `acct:${id}`, label: `Account ${id}`, customers: ctx.accountDegree.get(id) ?? 0 });
    for (const id of a.device_ids) if (ctx.isHubDevice(id)) hubs.set(`dev:${id}`, { key: `dev:${id}`, label: `Device ${id}`, customers: ctx.deviceDegree.get(id) ?? 0 });
  }
  const windowMs = policy.priority.correlationWindowDays * 86400000;
  const shared: SharedEntity[] = [];
  for (const [key, list] of byKey) {
    const uniq = [...new Map(list.map((a) => [a.alert_id, a])).values()];
    if (uniq.length < 2) continue;
    const kind = key.split(":")[0];
    if (kind === "cust" && uniq.length < 2) continue;
    const times = uniq.map((a) => Date.parse(a.event_time)).sort((x, y) => x - y);
    const span = times[times.length - 1] - times[0];
    const timed = ["phone", "ip", "pol", "doc"].includes(kind);
    shared.push({
      key, kind, label: describeKey(key), field: FIELD[kind] ?? kind, timed, within_window: timed ? span <= windowMs : null,
      alerts: uniq.map((a) => ({ alert_id: a.alert_id, detector: a.detector, title: a.title, event_time: a.event_time })),
      span_days: Math.round((span / 86400000) * 10) / 10, refs: uniq.map((a) => a.primary_ref),
    });
  }
  const rank = (s: SharedEntity) => (s.kind === "txn" ? 9 : s.kind === "cust" ? 5 : 0) - s.alerts.length;
  shared.sort((a, b) => rank(a) - rank(b));
  const per_alert = members.map((a) => {
    const via = shared.filter((s) => s.alerts.some((x) => x.alert_id === a.alert_id)).map((s) => s.label);
    return { alert_id: a.alert_id, connected_via: via, weakly_connected: members.length > 1 && via.length <= 1 };
  });
  const detectors = new Set(members.map((a) => a.detector));
  return {
    summary: members.length < 2 ? "A single alert; there was nothing to consolidate." : `${members.length} alerts from ${detectors.size} detector(s) were grouped because they share ${shared.length} entit${shared.length === 1 ? "y" : "ies"} found in the source records.`,
    shared, excluded_hubs: [...hubs.values()], per_alert, window_days: policy.priority.correlationWindowDays,
  };
}

const splitSchema = z.object({
  alert_ids: z.array(z.string()).min(1, "Select at least one alert to move"),
  reason: z.string().trim().min(10, "Explain why these alerts do not belong with the rest (at least 10 characters)").max(1000),
});

/**
 * Moves the selected alerts into a new case. Alerts, evidence and decisions are untouched; the move is an
 * append-only record. A later detection run keeps the two groups apart (see applySplits).
 */
export async function splitCase(caseId: string, input: unknown, actor: string) {
  const { alert_ids, reason } = splitSchema.parse(input);
  const c = await one<{ case_id: string; first_run_id: string; category: string; level: string; score: number }>("SELECT * FROM cases WHERE case_id = ?", [caseId]);
  if (!c) throw new HttpError(404, "Case not found");
  const rows = await all<Record<string, unknown>>("SELECT a.* FROM alerts a JOIN case_alerts_effective ca ON ca.alert_id = a.alert_id WHERE ca.case_id = ?", [caseId]);
  const alerts = rows.map(parseAlert);
  const members = alerts.filter((a) => a.detector !== "FD-06");
  const moved = members.filter((a) => alert_ids.includes(a.alert_id));
  const kept = members.filter((a) => !alert_ids.includes(a.alert_id));
  if (moved.length !== new Set(alert_ids).size) throw new HttpError(400, "Some selected alerts are not part of this case, or are the summary alert");
  if (kept.length === 0) throw new HttpError(400, "A split must leave at least one alert in the original case");
  const movedFps = moved.map((a) => a.fingerprint).sort();
  const keptFps = kept.map((a) => a.fingerprint).sort();
  const toCase = idFrom("CASE", sha256(`split|${caseId}|${movedFps.join(",")}`));
  const lead = moved.reduce((a, b) => (b.score > a.score ? b : a));
  const now = new Date().toISOString();
  const tx = await (await getDb()).transaction("write");
  try {
    const res = await tx.execute({
      sql: "INSERT INTO case_splits (from_case_id, to_case_id, moved_alert_ids, moved_fingerprints, kept_fingerprints, reason, actor, created_at) VALUES (?,?,?,?,?,?,?,?)",
      args: [caseId, toCase, JSON.stringify(moved.map((a) => a.alert_id)), JSON.stringify(movedFps), JSON.stringify(keptFps), reason, actor, now],
    });
    const splitId = Number(res.lastInsertRowid);
    await tx.execute({
      sql: "INSERT INTO cases (case_id, case_key, first_run_id, title, primary_customer_id, primary_account_id, category, level, score, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      args: [toCase, `split:${splitId}`, c.first_run_id, lead.title, lead.customer_ids[0] ?? null, lead.account_ids[0] ?? null, lead.category, lead.level, lead.score, now],
    });
    for (const a of moved) {
      await tx.execute({ sql: "INSERT INTO case_alerts (case_id, alert_id) VALUES (?,?)", args: [toCase, a.alert_id] });
      await tx.execute({ sql: "INSERT INTO case_alert_moves (alert_id, from_case_id, to_case_id, split_id) VALUES (?,?,?,?)", args: [a.alert_id, caseId, toCase, splitId] });
    }
    // The old cross-system summary described the combined group, so it no longer describes either half.
    for (const a of alerts.filter((x) => x.detector === "FD-06")) {
      await tx.execute({ sql: "INSERT INTO case_alert_moves (alert_id, from_case_id, to_case_id, split_id) VALUES (?,?,?,?)", args: [a.alert_id, caseId, `superseded-by-split-${splitId}`, splitId] });
    }
    for (const [cid, text] of [[caseId, `Split: ${moved.length} alert(s) moved to ${toCase}. ${reason}`], [toCase, `Created by splitting ${caseId}. ${reason}`]]) {
      await tx.execute({ sql: "INSERT INTO case_actions (case_id, action, status, reason, actor, ref_id, created_at) VALUES (?,?,?,?,?,?,?)", args: [cid, "SPLIT_CASE", "recorded", text, actor, splitId, now] });
    }
    await tx.commit();
    return { split_id: splitId, from_case_id: caseId, to_case_id: toCase, moved: moved.map((a) => a.alert_id), kept: kept.map((a) => a.alert_id) };
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

export async function listSplits(caseId: string) {
  return all<{ id: number; from_case_id: string; to_case_id: string; moved_alert_ids: string; reason: string; actor: string; created_at: string }>(
    "SELECT * FROM case_splits WHERE from_case_id = ? OR to_case_id = ? ORDER BY id", [caseId, caseId]);
}
