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

  const [logins, txns, loans, run] = await Promise.all([
    all<Record<string, unknown>>("SELECT * FROM login_events WHERE customer_id = ? ORDER BY timestamp", [id]),
    accountIds.length
      ? all<Record<string, unknown>>(
          `SELECT * FROM transactions WHERE account_id IN (${inList(accountIds.length)}) OR beneficiary_account IN (${inList(accountIds.length)}) ORDER BY timestamp`,
          [...accountIds, ...accountIds],
        )
      : Promise.resolve([]),
    all<Record<string, unknown>>("SELECT * FROM loan_applications WHERE customer_id = ? ORDER BY submitted_at", [id]),
    latestRun(),
  ]);
  if (!customer && logins.length === 0 && accounts.length === 0 && loans.length === 0) return null;

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
  events.sort((a, b) => b.time.localeCompare(a.time));

  const cases = await all<{ case_id: string; title: string; level: string }>(
    `SELECT DISTINCT c.case_id, c.title, c.level FROM cases c JOIN case_alerts ca ON ca.case_id = c.case_id JOIN alerts a ON a.alert_id = ca.alert_id, json_each(a.customer_ids) j WHERE j.value = ?`,
    [id],
  );

  return {
    customer,
    accounts,
    devices,
    loans,
    alerts,
    cases,
    timeline: events.slice(0, TIMELINE_LIMIT),
    timelineTotal: events.length,
    counts: { logins: logins.length, transactions: txns.length, loans: loans.length },
  };
}
