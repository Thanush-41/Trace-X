import type { InValue } from "@libsql/client";
import { all, one } from "@/lib/db/client";
import type { Ref, Rule } from "@/lib/detect/types";
import type { Level } from "@/lib/policy";

export const PK: Record<Ref["table"], string> = {
  customers: "customer_id", accounts: "account_id", transactions: "transaction_id", login_events: "event_id", loan_applications: "application_id",
  insurance_claims: "claim_id",
};

/** Latest status expression for a case row aliased `c`. */
export const CASE_STATUS_SQL = `COALESCE(
  (SELECT 'CLOSED' FROM case_actions x WHERE x.case_id = c.case_id AND x.action = 'CLOSE_CASE'
     AND x.created_at >= COALESCE((SELECT MAX(d.created_at) FROM case_decisions d WHERE d.case_id = c.case_id), '') LIMIT 1),
  (SELECT d.decision FROM case_decisions d WHERE d.case_id = c.case_id ORDER BY d.id DESC LIMIT 1), 'OPEN')`;
export const OPEN_STATUSES = ["OPEN", "REQUIRES_INVESTIGATION", "ESCALATED"];

export type AlertRow = {
  alert_id: string; fingerprint: string; first_run_id: string; detector: string; category: string; subject_type: string; subject_id: string; title: string;
  customer_ids: string[]; account_ids: string[]; transaction_ids: string[]; device_ids: string[]; application_ids: string[]; claim_ids: string[]; products: string[];
  event_time: string; primary_ref: Ref; raw_score: number; score: number; level: Level; floor_note: string | null;
  signals: Rule[]; mitigations: Rule[]; evidence: Ref[]; member_alert_ids: string[]; created_at: string;
};

type RawAlert = Record<string, unknown>;
export function parseAlert(r: RawAlert): AlertRow {
  const j = (k: string) => JSON.parse(String(r[k] ?? "[]"));
  return {
    alert_id: String(r.alert_id), fingerprint: String(r.fingerprint), first_run_id: String(r.first_run_id), detector: String(r.detector),
    category: String(r.category), subject_type: String(r.subject_type), subject_id: String(r.subject_id), title: String(r.title),
    customer_ids: j("customer_ids"), account_ids: j("account_ids"), transaction_ids: j("transaction_ids"), device_ids: j("device_ids"),
    application_ids: j("application_ids"), claim_ids: j("claim_ids"), products: j("products"), event_time: String(r.event_time), primary_ref: JSON.parse(String(r.primary_ref)),
    raw_score: Number(r.raw_score), score: Number(r.score), level: r.level as Level, floor_note: (r.floor_note as string) ?? null,
    signals: j("signals_json"), mitigations: j("mitigations_json"), evidence: j("evidence_refs_json"), member_alert_ids: j("member_alert_ids"),
    created_at: String(r.created_at),
  };
}

export async function latestRun() {
  return one<{ run_id: string; policy_version: string; started_at: string; finished_at: string; counts_json: string }>(
    "SELECT * FROM detection_runs ORDER BY started_at DESC, rowid DESC LIMIT 1",
  );
}

export async function recordCounts() {
  const tables = ["customers", "accounts", "transactions", "login_events", "loan_applications", "insurance_claims"] as const;
  const rows = await Promise.all(tables.map((t) => one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)));
  return Object.fromEntries(tables.map((t, i) => [t, Number(rows[i]?.n ?? 0)])) as Record<(typeof tables)[number], number>;
}

export async function dashboardSummary() {
  const [records, imports, run] = await Promise.all([
    recordCounts(),
    one<{ batches: number; total: number; accepted: number; rejected: number; duplicates: number; warnings: number }>(
      "SELECT COUNT(*) AS batches, COALESCE(SUM(total_rows),0) AS total, COALESCE(SUM(accepted),0) AS accepted, COALESCE(SUM(rejected),0) AS rejected, COALESCE(SUM(duplicates),0) AS duplicates, COALESCE(SUM(warnings),0) AS warnings FROM import_batches",
    ),
    latestRun(),
  ]);
  const runId = run?.run_id ?? "";
  const [byLevel, byDetector, byProduct, cases, recent] = await Promise.all([
    all<{ level: string; n: number }>("SELECT a.level, COUNT(*) AS n FROM alerts a JOIN run_alerts ra ON ra.alert_id = a.alert_id WHERE ra.run_id = ? GROUP BY a.level", [runId]),
    all<{ detector: string; category: string; n: number; actionable: number }>(
      "SELECT a.detector, a.category, COUNT(*) AS n, SUM(a.level <> 'Low') AS actionable FROM alerts a JOIN run_alerts ra ON ra.alert_id = a.alert_id WHERE ra.run_id = ? GROUP BY a.detector, a.category ORDER BY a.detector",
      [runId],
    ),
    all<{ product: string; n: number }>(
      "SELECT p.value AS product, COUNT(*) AS n FROM alerts a JOIN run_alerts ra ON ra.alert_id = a.alert_id, json_each(a.products) p WHERE ra.run_id = ? AND a.level <> 'Low' GROUP BY p.value ORDER BY n DESC",
      [runId],
    ),
    all<{ status: string; level: string; n: number }>(`SELECT ${CASE_STATUS_SQL} AS status, c.level, COUNT(*) AS n FROM cases c WHERE EXISTS (SELECT 1 FROM case_alerts_effective ca2 JOIN run_alerts ra2 ON ra2.alert_id = ca2.alert_id WHERE ca2.case_id = c.case_id AND ra2.run_id = ?) GROUP BY status, c.level`, [runId]),
    all<RawAlert>(
      "SELECT a.* FROM alerts a JOIN run_alerts ra ON ra.alert_id = a.alert_id WHERE ra.run_id = ? AND a.level = 'High' ORDER BY a.score DESC, a.event_time DESC LIMIT 8",
      [runId],
    ),
  ]);
  const daily = await all<{ day: string; level: string; n: number }>(
    "SELECT substr(a.event_time, 1, 10) AS day, a.level, COUNT(*) AS n FROM alerts a JOIN run_alerts ra ON ra.alert_id = a.alert_id WHERE ra.run_id = ? GROUP BY day, a.level ORDER BY day",
    [runId],
  );
  const priority = await all<{ case_id: string; title: string; category: string; level: string; score: number; status: string; primary_customer_id: string | null }>(
    `SELECT c.case_id, c.title, c.category, c.level, c.score, c.primary_customer_id, ${CASE_STATUS_SQL} AS status FROM cases c
     WHERE ${CASE_STATUS_SQL} IN ('OPEN','REQUIRES_INVESTIGATION','ESCALATED') AND EXISTS (SELECT 1 FROM case_alerts_effective ca2 JOIN run_alerts ra2 ON ra2.alert_id = ca2.alert_id WHERE ca2.case_id = c.case_id AND ra2.run_id = ?)
     ORDER BY CASE c.level WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END, c.score DESC LIMIT 6`,
    [runId],
  );
  const levels = { High: 0, Medium: 0, Low: 0 } as Record<Level, number>;
  byLevel.forEach((r) => (levels[r.level as Level] = Number(r.n)));
  return {
    records,
    totalRecords: Object.values(records).reduce((s, n) => s + n, 0),
    imports: { batches: Number(imports?.batches ?? 0), total: Number(imports?.total ?? 0), accepted: Number(imports?.accepted ?? 0), rejected: Number(imports?.rejected ?? 0), duplicates: Number(imports?.duplicates ?? 0), warnings: Number(imports?.warnings ?? 0) },
    run: run ? { ...run, counts: JSON.parse(run.counts_json) as { ms: number; new_alerts: number; total_alerts: number } } : null,
    levels,
    flagged: levels.High + levels.Medium + levels.Low,
    byDetector: byDetector.map((d) => ({ ...d, n: Number(d.n), actionable: Number(d.actionable) })),
    byProduct: byProduct.map((p) => ({ ...p, n: Number(p.n) })),
    cases: {
      open: cases.filter((c) => OPEN_STATUSES.includes(c.status)).reduce((s, c) => s + Number(c.n), 0),
      total: cases.reduce((s, c) => s + Number(c.n), 0),
      openHigh: cases.filter((c) => OPEN_STATUSES.includes(c.status) && c.level === "High").reduce((s, c) => s + Number(c.n), 0),
    },
    recent: recent.map(parseAlert),
    daily: daily.map((d) => ({ ...d, n: Number(d.n) })),
    priority: priority.map((p) => ({ ...p, score: Number(p.score) })),
  };
}

export type AlertFilters = {
  view?: "actionable" | "monitored" | "all";
  case_status?: string;
  customer?: string; transaction?: string; product?: string; level?: string; detector?: string; from?: string; to?: string; q?: string;
};

function alertWhere(runId: string, f: AlertFilters, view: AlertFilters["view"]) {
  const where: string[] = ["ra.run_id = ?"];
  const args: InValue[] = [runId];
  if (view === "actionable") where.push("a.level IN ('High','Medium')");
  if (view === "monitored") where.push("a.level = 'Low'");
  if (f.case_status === "NO_CASE") {
    where.push("NOT EXISTS (SELECT 1 FROM case_alerts_effective ca WHERE ca.alert_id = a.alert_id)");
  } else if (f.case_status) {
    where.push(`EXISTS (
      SELECT 1 FROM case_alerts_effective ca JOIN cases c ON c.case_id = ca.case_id
      WHERE ca.alert_id = a.alert_id AND ${CASE_STATUS_SQL} = ?
    )`);
    args.push(f.case_status);
  }
  if (f.level) { where.push("a.level = ?"); args.push(f.level); }
  if (f.detector) { where.push("a.detector = ?"); args.push(f.detector); }
  if (f.product) { where.push("EXISTS (SELECT 1 FROM json_each(a.products) WHERE value = ?)"); args.push(f.product); }
  if (f.customer) { where.push("EXISTS (SELECT 1 FROM json_each(a.customer_ids) WHERE value = ?)"); args.push(f.customer.trim()); }
  if (f.transaction) { where.push("EXISTS (SELECT 1 FROM json_each(a.transaction_ids) WHERE value = ?)"); args.push(f.transaction.trim()); }
  if (f.from) { where.push("a.event_time >= ?"); args.push(f.from); }
  if (f.to) { where.push("a.event_time < date(?, '+1 day')"); args.push(f.to); }
  if (f.q) {
    where.push("(a.title LIKE ? OR a.subject_id LIKE ? OR a.alert_id LIKE ? OR a.account_ids LIKE ? OR a.device_ids LIKE ? OR a.claim_ids LIKE ? OR a.customer_ids LIKE ?)");
    const like = `%${f.q.trim()}%`;
    args.push(like, like, like, like, like, like, like);
  }
  return { sql: `FROM alerts a JOIN run_alerts ra ON ra.alert_id = a.alert_id WHERE ${where.join(" AND ")}`, args };
}

export type AlertListRow = AlertRow & { case_id: string | null; case_status: string | null };

export async function listAlerts(f: AlertFilters, limit = 500) {
  const run = await latestRun();
  if (!run) return { run: null, alerts: [] as AlertListRow[], total: 0, counts: { actionable: 0, monitored: 0, all: 0 } };
  const view = f.view ?? "actionable";
  const { sql, args } = alertWhere(run.run_id, f, view);
  const caseCols = `(SELECT ca.case_id FROM case_alerts_effective ca WHERE ca.alert_id = a.alert_id LIMIT 1) AS case_id,
    (SELECT ${CASE_STATUS_SQL} FROM case_alerts_effective ca JOIN cases c ON c.case_id = ca.case_id WHERE ca.alert_id = a.alert_id LIMIT 1) AS case_status`;
  const countFor = (v: AlertFilters["view"]) => {
    const w = alertWhere(run.run_id, f, v);
    return one<{ n: number }>(`SELECT COUNT(*) AS n ${w.sql}`, w.args).then((r) => Number(r?.n ?? 0));
  };
  const [rows, actionable, monitored, allCount] = await Promise.all([
    all<RawAlert>(`SELECT a.*, ${caseCols} ${sql} ORDER BY a.score DESC, a.event_time DESC LIMIT ?`, [...args, limit]),
    countFor("actionable"),
    countFor("monitored"),
    countFor("all"),
  ]);
  const total = view === "actionable" ? actionable : view === "monitored" ? monitored : allCount;
  return {
    run,
    alerts: rows.map((r) => ({ ...parseAlert(r), case_id: (r.case_id as string) ?? null, case_status: (r.case_status as string) ?? null })),
    total,
    counts: { actionable, monitored, all: allCount },
  };
}

/** Fetches the source rows behind a set of references, keyed "table:id". */
export async function resolveRefs(refs: Ref[]) {
  const byTable = new Map<Ref["table"], Set<string>>();
  for (const r of refs) {
    if (!byTable.has(r.table)) byTable.set(r.table, new Set());
    byTable.get(r.table)!.add(r.id);
  }
  const out = new Map<string, Record<string, unknown>>();
  for (const [table, ids] of byTable) {
    const list = [...ids];
    for (let i = 0; i < list.length; i += 400) {
      const chunk = list.slice(i, i + 400);
      const rows = await all<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${PK[table]} IN (${chunk.map(() => "?").join(",")})`, chunk);
      for (const row of rows) out.set(`${table}:${row[PK[table]]}`, row);
    }
  }
  return out;
}

export async function getAlert(id: string) {
  const raw = await one<RawAlert>("SELECT * FROM alerts WHERE alert_id = ?", [id]);
  if (!raw) return null;
  const alert = parseAlert(raw);
  const [rows, cases, members, parents] = await Promise.all([
    resolveRefs([alert.primary_ref, ...alert.evidence]),
    all<{ case_id: string; title: string; level: string; status: string }>(
      `SELECT c.case_id, c.title, c.level, ${CASE_STATUS_SQL} AS status FROM cases c JOIN case_alerts_effective ca ON ca.case_id = c.case_id WHERE ca.alert_id = ?`,
      [id],
    ),
    alert.member_alert_ids.length
      ? all<RawAlert>(`SELECT * FROM alerts WHERE alert_id IN (${alert.member_alert_ids.map(() => "?").join(",")}) ORDER BY score DESC`, alert.member_alert_ids)
      : Promise.resolve([]),
    all<RawAlert>("SELECT * FROM alerts WHERE detector = 'FD-06' AND EXISTS (SELECT 1 FROM json_each(member_alert_ids) WHERE value = ?)", [id]),
  ]);
  return { alert, rows, cases, members: members.map(parseAlert), parents: parents.map(parseAlert) };
}

export type WorkspaceEvent = { id: number; kind: string; detail: string; actor: string; created_at: string };

/** What is loaded right now and who changed the shared workspace, so counts never change without explanation. */
export async function workspaceIdentity() {
  const [batches, events, lastReset] = await Promise.all([
    all<{ filename: string; accepted: number; created_at: string }>("SELECT filename, accepted, created_at FROM import_batches ORDER BY created_at"),
    all<WorkspaceEvent>("SELECT * FROM workspace_events ORDER BY id DESC LIMIT 8"),
    one<WorkspaceEvent>("SELECT * FROM workspace_events WHERE kind = 'reset' ORDER BY id DESC LIMIT 1"),
  ]);
  const sources = new Map<string, { records: number; files: number; since: string }>();
  for (const b of batches) {
    const m = b.filename.match(/^seed-(\d+)\//);
    const key = m ? `Sample seed ${m[1]}` : b.filename;
    const cur = sources.get(key) ?? { records: 0, files: 0, since: b.created_at };
    sources.set(key, { records: cur.records + Number(b.accepted), files: cur.files + 1, since: cur.since });
  }
  const seeds = [...new Set(batches.map((b) => b.filename.match(/^seed-(\d+)\//)?.[1]).filter(Boolean).map(Number))];
  return { sources: [...sources].map(([name, v]) => ({ name, ...v })), seeds, events, lastReset: lastReset ?? null };
}
