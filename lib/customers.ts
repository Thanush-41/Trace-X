import { all, one } from "@/lib/db/client";
import type { Ref } from "@/lib/detect/types";
import { describe, type TimelineEvent } from "@/lib/cases";
import { latestRun, parseAlert } from "@/lib/queries";

const TIMELINE_LIMIT = 400;

/** Everything known about one customer across systems, plus who they are linked to through devices and accounts. */
export async function getCustomerProfile(id: string) {
  const customer = await one<Record<string, unknown>>("SELECT * FROM customers WHERE customer_id = ?", [id]);
  const accounts = await all<Record<string, unknown>>("SELECT * FROM accounts WHERE customer_id = ? ORDER BY opened_at", [id]);
  const accountIds = accounts.map((a) => String(a.account_id));
  const inList = (n: number) => Array(n).fill("?").join(",") || "NULL";

  const [logins, txns, loans, claims, run] = await Promise.all([
    all<Record<string, unknown>>("SELECT * FROM login_events WHERE customer_id = ? ORDER BY timestamp", [id]),
    accountIds.length
      ? all<Record<string, unknown>>(
          `SELECT * FROM transactions WHERE account_id IN (${inList(accountIds.length)}) OR beneficiary_account IN (${inList(accountIds.length)}) ORDER BY timestamp`,
          [...accountIds, ...accountIds],
        )
      : Promise.resolve([]),
    all<Record<string, unknown>>("SELECT * FROM loan_applications WHERE customer_id = ? ORDER BY submitted_at", [id]),
    all<Record<string, unknown>>("SELECT * FROM insurance_claims WHERE customer_id = ? ORDER BY submitted_at", [id]),
    latestRun(),
  ]);
  if (!customer && logins.length === 0 && accounts.length === 0 && loans.length === 0 && claims.length === 0) return null;

  // Devices this customer used, with the other customers seen on each.
  const deviceIds = [...new Set([...logins.map((l) => String(l.device_id)), ...loans.map((l) => l.device_id).filter(Boolean).map(String)])];
  const deviceUsers = deviceIds.length
    ? await all<{ device_id: string; customer_id: string; uses: number; first: string; last: string }>(
        `SELECT device_id, customer_id, COUNT(*) AS uses, MIN(t) AS first, MAX(t) AS last FROM (
           SELECT device_id, customer_id, timestamp AS t FROM login_events WHERE device_id IN (${inList(deviceIds.length)})
           UNION ALL SELECT device_id, customer_id, submitted_at AS t FROM loan_applications WHERE device_id IN (${inList(deviceIds.length)})
         ) GROUP BY device_id, customer_id ORDER BY device_id, first`,
        [...deviceIds, ...deviceIds],
      )
    : [];
  const devices = deviceIds.map((d) => {
    const users = deviceUsers.filter((u) => u.device_id === d);
    const mine = users.find((u) => u.customer_id === id);
    return { device_id: d, uses: Number(mine?.uses ?? 0), first: mine?.first ?? "", last: mine?.last ?? "", others: users.filter((u) => u.customer_id !== id).map((u) => u.customer_id) };
  });

  const alerts = run
    ? (await all<Record<string, unknown>>(
        "SELECT a.* FROM alerts a JOIN run_alerts ra ON ra.alert_id = a.alert_id WHERE ra.run_id = ? AND EXISTS (SELECT 1 FROM json_each(a.customer_ids) WHERE value = ?) ORDER BY a.score DESC",
        [run.run_id, id],
      )).map(parseAlert)
    : [];
  const flagged = new Set(alerts.flatMap((a) => [a.primary_ref, ...a.evidence].map((r) => `${r.table}:${r.id}`)));

  const events: TimelineEvent[] = [];
  const push = (table: Ref["table"], key: string, row: Record<string, unknown>) => {
    const ref = { table, id: String(row[key]) };
    const e = describe(ref, row);
    if (e) events.push({ ...e, flagged: flagged.has(`${table}:${ref.id}`) });
  };
  logins.forEach((r) => push("login_events", "event_id", r));
  txns.forEach((r) => push("transactions", "transaction_id", r));
  loans.forEach((r) => push("loan_applications", "application_id", r));
  claims.forEach((r) => push("insurance_claims", "claim_id", r));
  events.sort((a, b) => b.time.localeCompare(a.time));

  const cases = await all<{ case_id: string; title: string; level: string }>(
    `SELECT DISTINCT c.case_id, c.title, c.level FROM cases c JOIN case_alerts_effective ca ON ca.case_id = c.case_id JOIN alerts a ON a.alert_id = ca.alert_id, json_each(a.customer_ids) j WHERE j.value = ?`,
    [id],
  );

  return {
    customer,
    accounts,
    devices,
    loans,
    claims,
    alerts,
    cases,
    timeline: events.slice(0, TIMELINE_LIMIT),
    timelineTotal: events.length,
    counts: { logins: logins.length, transactions: txns.length, loans: loans.length, claims: claims.length },
  };
}

export type CustomerListRow = {
  customer_id: string; full_name: string; city: string | null; onboarding_date: string | null;
  accounts: number; devices: number; products: string | null; actionable: number; top_level: string | null;
};

/** Searchable customer index with cross-system counts and the highest risk seen in the latest run. */
export async function listCustomers(q = "", flaggedOnly = false, limit = 200) {
  const run = await latestRun();
  const runId = run?.run_id ?? "";
  const like = `%${q.trim()}%`;
  const where: string[] = [];
  const args: (string | number)[] = [runId, runId];
  if (q.trim()) {
    where.push(`(c.customer_id LIKE ? OR c.full_name LIKE ? OR c.phone LIKE ? OR c.email LIKE ?
      OR EXISTS (SELECT 1 FROM accounts a WHERE a.customer_id = c.customer_id AND a.account_id LIKE ?)
      OR EXISTS (SELECT 1 FROM login_events l WHERE l.customer_id = c.customer_id AND l.device_id LIKE ?))`);
    args.push(like, like, like, like, like, like);
  }
  const base = `SELECT * FROM (
    SELECT c.customer_id, c.full_name, c.city, c.onboarding_date,
      (SELECT COUNT(*) FROM accounts a WHERE a.customer_id = c.customer_id) AS accounts,
      (SELECT COUNT(DISTINCT l.device_id) FROM login_events l WHERE l.customer_id = c.customer_id AND l.device_id IS NOT NULL) AS devices,
      (SELECT GROUP_CONCAT(DISTINCT a.product) FROM accounts a WHERE a.customer_id = c.customer_id) AS products,
      (SELECT COUNT(*) FROM alerts al JOIN run_alerts ra ON ra.alert_id = al.alert_id
        WHERE ra.run_id = ? AND al.level <> 'Low' AND EXISTS (SELECT 1 FROM json_each(al.customer_ids) j WHERE j.value = c.customer_id)) AS actionable,
      (SELECT al.level FROM alerts al JOIN run_alerts ra ON ra.alert_id = al.alert_id
        WHERE ra.run_id = ? AND EXISTS (SELECT 1 FROM json_each(al.customer_ids) j WHERE j.value = c.customer_id)
        ORDER BY CASE al.level WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END LIMIT 1) AS top_level
    FROM customers c ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
  ) ${flaggedOnly ? "WHERE actionable > 0" : ""}`;
  const [rows, total] = await Promise.all([
    all<CustomerListRow>(`${base} ORDER BY actionable DESC, CASE top_level WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 WHEN 'Low' THEN 2 ELSE 3 END, full_name LIMIT ?`, [...args, limit]),
    all<{ n: number }>(`SELECT COUNT(*) AS n FROM (${base})`, args),
  ]);
  return { rows: rows.map((r) => ({ ...r, accounts: Number(r.accounts), devices: Number(r.devices), actionable: Number(r.actionable) })), total: Number(total[0]?.n ?? 0) };
}
