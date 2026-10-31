import type { InStatement } from "@libsql/client";
import { getDb } from "@/lib/db/client";
import { policy as defaultPolicy, type Policy } from "@/lib/policy";
import { idFrom, newId, sha256 } from "@/lib/util/hash";
import { loadContext, type DetectionContext } from "./context";
import { detectSuspiciousTransfers } from "./fd01-transfer";
import { detectSharedDevices } from "./fd02-device";
import { detectAccountTakeover } from "./fd03-ato";
import { detectIdentityLinks } from "./fd04-identity";
import { detectLoanRings } from "./fd05-loan-ring";
import { detectClaimFraud } from "./fd07-claims";
import { correlate, crossSystemFinding } from "./fd06-cross-system";
import { scoreFinding } from "./score";
import { scoreTransfers } from "./anomaly";
import { detectModelOnly } from "./fdml-model-only";
import { detectDormantReactivation } from "./fd08-dormant";
import type { ScoredFinding } from "./types";

export type CaseDraft = {
  case_id: string;
  case_key: string;
  title: string;
  category: string;
  level: ScoredFinding["level"];
  score: number;
  primary_customer_id: string | null;
  primary_account_id: string | null;
  alerts: ScoredFinding[];
};

export type DetectionOutput = { ctx: DetectionContext; findings: ScoredFinding[]; cases: CaseDraft[] };

const mostCommon = (values: string[]) => {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
};

/** Pure detection: no writes. Used by the run endpoint and by tests. */
export async function detect(policy: Policy = defaultPolicy): Promise<DetectionOutput> {
  const ctx = await loadContext(policy);
  ctx.anomaly = scoreTransfers(ctx);
  const ruleFindings = [
    ...detectSuspiciousTransfers(ctx),
    ...detectSharedDevices(ctx),
    ...detectAccountTakeover(ctx),
    ...detectIdentityLinks(ctx),
    ...detectLoanRings(ctx),
    ...detectClaimFraud(ctx),
    ...detectDormantReactivation(ctx),
  ];
  const covered = new Set(ruleFindings.filter((f) => f.detector === "FD-01").map((f) => f.subject_id));
  const base = [...ruleFindings, ...detectModelOnly(ctx, covered)].map((f) => scoreFinding(f, policy));

  const actionable = base.filter((f) => f.level !== "Low");
  const findings = [...base];
  const cases: CaseDraft[] = [];
  for (const group of correlate(ctx, actionable)) {
    const cross = crossSystemFinding(ctx, group);
    if (cross) findings.push(cross);
    const members = cross ? [cross, ...group] : group;
    const lead = cross ?? group.reduce((a, b) => (b.score > a.score ? b : a));
    const case_key = sha256(members.map((f) => f.fingerprint).sort().join(","));
    cases.push({
      case_id: idFrom("CASE", case_key),
      case_key,
      title: cross ? cross.title : group.length > 1 ? `${lead.title} (+${group.length - 1} linked)` : lead.title,
      category: lead.category,
      level: lead.level,
      score: lead.score,
      primary_customer_id: mostCommon(members.flatMap((f) => [...f.entities.customers])),
      primary_account_id: mostCommon(members.flatMap((f) => [...f.entities.accounts].filter((a) => ctx.accounts.has(a)))),
      alerts: members,
    });
  }
  return { ctx, findings, cases };
}

export type RunSummary = {
  run_id: string;
  policy_version: string;
  input_hash: string;
  records: Record<string, number>;
  total_alerts: number;
  new_alerts: number;
  total_cases: number;
  new_cases: number;
  by_level: Record<string, number>;
  by_detector: Record<string, number>;
  ms: number;
};

const CHUNK = 50;

/** Runs detection and persists alerts and cases. Re-running on unchanged data inserts nothing new. */
export async function runDetection(policy: Policy = defaultPolicy): Promise<RunSummary> {
  const started = Date.now();
  const db = await getDb();
  const { ctx, findings, cases } = await detect(policy);
  const run_id = newId("RUN");
  const now = new Date().toISOString();

  const existingAlerts = new Set((await db.execute("SELECT fingerprint FROM alerts")).rows.map((r) => String(r[0])));
  const existingCases = new Set((await db.execute("SELECT case_key FROM cases")).rows.map((r) => String(r[0])));
  const idByFingerprint = new Map(findings.map((f) => [f.fingerprint, f.alert_id]));

  const statements: InStatement[] = [];
  const alertCols = [
    "alert_id", "fingerprint", "first_run_id", "detector", "category", "subject_type", "subject_id", "title",
    "customer_ids", "account_ids", "transaction_ids", "device_ids", "application_ids", "claim_ids", "products", "event_time", "primary_ref",
    "raw_score", "score", "level", "floor_note", "signals_json", "mitigations_json", "evidence_refs_json", "member_alert_ids", "created_at",
  ];
  const sorted = (s: Set<string>) => JSON.stringify([...s].sort());
  for (let i = 0; i < findings.length; i += CHUNK) {
    const chunk = findings.slice(i, i + CHUNK);
    statements.push({
      sql: `INSERT OR IGNORE INTO alerts (${alertCols.join(",")}) VALUES ${chunk.map(() => `(${alertCols.map(() => "?").join(",")})`).join(",")}`,
      args: chunk.flatMap((f) => [
        f.alert_id, f.fingerprint, run_id, f.detector, f.category, f.subject_type, f.subject_id, f.title,
        sorted(f.entities.customers), sorted(f.entities.accounts), sorted(f.entities.transactions), sorted(f.entities.devices), sorted(f.entities.applications), sorted(f.entities.claims),
        sorted(f.products), f.event_time, JSON.stringify(f.primary_ref),
        f.raw_score, f.score, f.level, f.floor_note, JSON.stringify(f.signals), JSON.stringify(f.mitigations), JSON.stringify(f.evidence),
        JSON.stringify((f.members ?? []).map((m) => idByFingerprint.get(m))), now,
      ]),
    });
    statements.push({
      sql: `INSERT OR IGNORE INTO run_alerts (run_id, alert_id) VALUES ${chunk.map(() => "(?,?)").join(",")}`,
      args: chunk.flatMap((f) => [run_id, f.alert_id]),
    });
  }
  for (const c of cases) {
    statements.push({
      sql: `INSERT OR IGNORE INTO cases (case_id, case_key, first_run_id, title, primary_customer_id, primary_account_id, category, level, score, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
      args: [c.case_id, c.case_key, run_id, c.title, c.primary_customer_id, c.primary_account_id, c.category, c.level, c.score, now],
    });
    statements.push({
      sql: `INSERT OR IGNORE INTO case_alerts (case_id, alert_id) VALUES ${c.alerts.map(() => "(?,?)").join(",")}`,
      args: c.alerts.flatMap((a) => [c.case_id, a.alert_id]),
    });
  }

  const by_level: Record<string, number> = { High: 0, Medium: 0, Low: 0 };
  const by_detector: Record<string, number> = {};
  for (const f of findings) {
    by_level[f.level]++;
    by_detector[f.detector] = (by_detector[f.detector] ?? 0) + 1;
  }
  const summary: RunSummary = {
    run_id,
    policy_version: policy.version,
    input_hash: ctx.inputHash,
    records: ctx.counts,
    total_alerts: findings.length,
    new_alerts: findings.filter((f) => !existingAlerts.has(f.fingerprint)).length,
    total_cases: cases.length,
    new_cases: cases.filter((c) => !existingCases.has(c.case_key)).length,
    by_level,
    by_detector,
    ms: 0,
  };
  summary.ms = Date.now() - started;
  statements.push({
    sql: "INSERT INTO detection_runs (run_id, policy_version, input_hash, started_at, finished_at, counts_json) VALUES (?,?,?,?,?,?)",
    args: [run_id, policy.version, ctx.inputHash, new Date(started).toISOString(), new Date().toISOString(), JSON.stringify(summary)],
  });
  await db.batch(statements, "write");
  return summary;
}
