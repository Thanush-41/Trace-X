import { all } from "@/lib/db/client";

/**
 * Read-only SQL for the SQL agent. Only source-data tables and graph-model scores are visible: never case
 * decisions, agent feedback or lessons, so the agent cannot read the human answer it is being graded against.
 */
export const AGENT_TABLES = ["customers", "accounts", "transactions", "login_events", "loan_applications", "insurance_claims", "graph_scores"] as const;
const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release|load_extension)\b/i;
export const ROW_LIMIT = 50;

export function checkSql(sql: string): { ok: true; sql: string } | { ok: false; error: string } {
  const q = sql.trim().replace(/;\s*$/, "");
  if (!q) return { ok: false, error: "empty query" };
  if (q.includes(";")) return { ok: false, error: "only one statement is allowed" };
  if (!/^(select|with)\b/i.test(q)) return { ok: false, error: "only SELECT queries are allowed" };
  if (FORBIDDEN.test(q)) return { ok: false, error: "the query contains a write or admin keyword" };
  if (/sqlite_|\bagent_|\bcase_|\bworkspace_|\bimport_|\balerts\b|\brun_alerts\b|\bcases\b/i.test(q)) return { ok: false, error: `only these tables are visible: ${AGENT_TABLES.join(", ")}` };
  const ctes = new Set([...q.matchAll(/(?:\bwith\b|,)\s*([a-z_][a-z0-9_]*)\s+as\s*\(/gi)].map((m) => m[1].toLowerCase()));
  for (const m of q.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi)) {
    const t = m[1].toLowerCase();
    if (!(AGENT_TABLES as readonly string[]).includes(t) && !ctes.has(t) && t !== "json_each") return { ok: false, error: `table "${m[1]}" is not visible; use ${AGENT_TABLES.join(", ")}` };
  }
  return { ok: true, sql: q };
}

/** Runs a checked query wrapped in an outer SELECT with a row cap, so even a missed write keyword cannot execute. */
export async function runAgentSql(sql: string): Promise<{ ok: boolean; rows: Record<string, unknown>[]; row_count: number; error?: string }> {
  const c = checkSql(sql);
  if (!c.ok) return { ok: false, rows: [], row_count: 0, error: c.error };
  try {
    const rows = await all<Record<string, unknown>>(`SELECT * FROM (${c.sql}) LIMIT ${ROW_LIMIT}`);
    const clean = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !["row_hash", "source_file", "source_row", "batch_id"].includes(k)).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])));
    return { ok: true, rows: clean, row_count: clean.length };
  } catch (e) {
    return { ok: false, rows: [], row_count: 0, error: (e as Error).message.slice(0, 300) };
  }
}

export const SCHEMA_DOC = `Tables (SQLite). Timestamps are ISO-8601 UTC text. Amounts are INR.
customers(customer_id, full_name, dob, national_id, phone_norm, email_norm, address, city, onboarding_date, onboarding_channel, kyc_status, occupation, declared_income)
accounts(account_id, customer_id, product['banking'|'lending'|'insurance'|'cards'], account_type, opened_at, status)
transactions(transaction_id, account_id [sender], beneficiary_account, beneficiary_name, amount, amount_inr, timestamp, channel, status, type['transfer'|'deposit'|'disbursement'|...], application_id, payee_name_check['match'|'partial'|'no_match'|'not_checked'])
login_events(event_id, customer_id, device_id, ip_address, geo, timestamp, outcome['success'|'failure'], event_type['login'|'password_reset'|'beneficiary_add'|'device_change'|...], sim_swap_days, remote_access[0/1], emulator_or_rooted[0/1], vpn_proxy[0/1], session_seconds, typing_anomaly[0..1])
loan_applications(application_id, customer_id, device_id, phone_norm, email_norm, requested_amount, payout_account, submitted_at, status, declared_income, employer, loan_purpose)
insurance_claims(claim_id, policy_id, customer_id, claim_type, incident_date, submitted_at, claim_amount, sum_insured, policy_start_date, provider_id, payout_account, device_id, document_hash, status)
graph_scores(run_id, customer_id, score [graph-model fraud probability 0..1], drivers_json)
Accounts starting EXT are outside the customer base (no accounts row). Results are capped at ${ROW_LIMIT} rows.`;
