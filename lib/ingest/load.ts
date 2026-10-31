import type { InStatement } from "@libsql/client";
import { getDb } from "@/lib/db/client";
import { hashObject, newId } from "@/lib/util/hash";
import { DATASET_LABELS, DEFAULTED, LOAD_ORDER, PRIMARY_KEY, detectType, type DatasetType, type HeaderMapping } from "./fields";
import { ParseError, parseFile, type RawDataset } from "./parse";
import { validateRow, type Issue, type RowOptions } from "./validate";
import { policy } from "@/lib/policy";
import { detectDateOrder, type DateOrder } from "@/lib/util/normalize";

const TIME_FIELDS = ["timestamp", "onboarding_date", "opened_at", "submitted_at", "incident_date", "dob", "policy_start_date"];

export type IssueRow = { source_row: number; field: string | null; severity: "error" | "warning" | "duplicate"; message: string };

export type IngestResult = {
  ok: true;
  batch_id: string;
  filename: string;
  sheet?: string;
  dataset_type: DatasetType;
  dataset_label: string;
  format: RawDataset["format"];
  header_map: Record<string, string>;
  unmapped: string[];
  missing_columns: string[];
  notices: string[];
  total: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  warnings: number;
  issues: IssueRow[];
  issues_truncated: boolean;
};
export type IngestFailure = { ok: false; filename: string; sheet?: string; error: string };

const MAX_ISSUES_RETURNED = 200;
const INSERT_CHUNK = 100;

/** Parses a file (one or more datasets) and ingests each dataset. Never throws for bad content. */
export async function ingestFile(buffer: Buffer, filename: string, override?: DatasetType): Promise<(IngestResult | IngestFailure)[]> {
  let datasets: RawDataset[];
  try {
    datasets = parseFile(buffer, filename);
  } catch (e) {
    if (e instanceof ParseError) return [{ ok: false, filename, error: e.message }];
    throw e;
  }
  const planned: { ds: RawDataset; mapping: HeaderMapping }[] = [];
  const results: (IngestResult | IngestFailure)[] = [];
  for (const ds of datasets) {
    const detected = detectType(ds.headers, ds.name ?? filename, datasets.length === 1 ? override : undefined);
    if ("error" in detected) results.push({ ok: false, filename, sheet: ds.name, error: detected.error });
    else planned.push({ ds, mapping: detected });
  }
  planned.sort((a, b) => LOAD_ORDER.indexOf(a.mapping.type) - LOAD_ORDER.indexOf(b.mapping.type));
  for (const { ds, mapping } of planned) results.push(await ingestDataset(ds, mapping, filename));
  return results;
}

async function knownIds(sql: string): Promise<Set<string>> {
  const db = await getDb();
  const res = await db.execute(sql);
  return new Set(res.rows.map((r) => String(r[0])));
}

export async function ingestDataset(ds: RawDataset, mapping: HeaderMapping, filename: string): Promise<IngestResult> {
  const db = await getDb();
  const type = mapping.type;
  const pk = PRIMARY_KEY[type];
  const batch_id = newId("BAT");
  const notices = [...ds.notices];

  const defaults: Record<string, string> = {};
  const mappedFields = new Set(Object.values(mapping.map));
  for (const [field, value] of Object.entries(DEFAULTED[type] ?? {})) {
    if (!mappedFields.has(field)) {
      defaults[field] = value;
      notices.push(`Column "${field}" is missing; every row was given the default "${value}".`);
    }
  }
  // Day/month order is decided per column from all its values, so 03/04/2026 is read consistently.
  const dateOrders: Record<string, DateOrder> = {};
  let offsetless = 0;
  for (const [src, field] of Object.entries(mapping.map)) {
    if (!TIME_FIELDS.includes(field)) continue;
    const values = ds.rows.map((r) => r[src]);
    const { order, ambiguous, conflicting } = detectDateOrder(values);
    dateOrders[field] = order;
    if (order === "MDY") notices.push(`Column "${src}" uses month-first dates (MM/DD/YYYY).`);
    if (ambiguous) notices.push(`Column "${src}" has only ambiguous slash dates; read as day-first (DD/MM/YYYY).`);
    if (conflicting) notices.push(`Column "${src}" mixes day-first and month-first dates; each value was read on its own.`);
    offsetless += values.filter((v) => typeof v === "string" && /\d{1,2}:\d{2}/.test(v) && !/(Z|[+-]\d{2}:?\d{2}|UTC|GMT)\s*$/i.test(v.trim())).length;
  }
  if (offsetless > 0) notices.push(`${offsetless} time value(s) had no UTC offset and were read as ${policy.ingest.defaultTimezone} (policy ingest.defaultTimezone).`);
  const rowOptions: RowOptions = { dateOrders, defaultOffset: policy.ingest.defaultTimezone };

  if (mapping.missingMandatory.length > 0) {
    notices.push(`Required column(s) missing: ${mapping.missingMandatory.join(", ")}. Rows without them are rejected.`);
  }

  const existing = new Map<string, string>();
  const res = await db.execute(`SELECT ${pk}, row_hash FROM ${type}`);
  for (const r of res.rows) existing.set(String(r[0]), String(r[1]));
  const customers = type === "customers" ? new Set<string>() : await knownIds("SELECT customer_id FROM customers");
  const accounts = type === "transactions" ? await knownIds("SELECT account_id FROM accounts") : new Set<string>();

  const issues: IssueRow[] = [];
  const issueRaw: string[] = [];
  const accepted: Record<string, string | number | null>[] = [];
  let rejected = 0;
  let duplicates = 0;
  let warningRows = 0;

  ds.rows.forEach((raw, i) => {
    const source_row = ds.firstRow + i;
    const rawJson = JSON.stringify(raw).slice(0, 2000);
    const push = (severity: IssueRow["severity"], issue: Issue) => {
      issues.push({ source_row, field: issue.field, severity, message: issue.message });
      issueRaw.push(rawJson);
    };
    const mapped: Record<string, unknown> = {};
    if ("__invalid__" in raw) mapped.__invalid__ = raw.__invalid__;
    for (const [src, field] of Object.entries(mapping.map)) mapped[field] = raw[src];

    const result = validateRow(type, mapped, defaults, rowOptions);
    if (!result.record) {
      rejected++;
      result.errors.forEach((e) => push("error", e));
      return;
    }
    const record = result.record;
    const id = String(record[pk]);
    const hash = hashObject(record);
    const prior = existing.get(id);
    if (prior === hash) {
      duplicates++;
      push("duplicate", { field: pk, message: `${pk} ${id} was already imported with identical values; not inserted again` });
      return;
    }
    if (prior !== undefined) {
      rejected++;
      push("error", { field: pk, message: `${pk} ${id} already exists with different values; the original record was kept` });
      return;
    }

    const warnings = [...result.warnings];
    const cust = record.customer_id ? String(record.customer_id) : null;
    if (type !== "customers" && type !== "transactions" && cust && !customers.has(cust)) {
      warnings.push({ field: "customer_id", message: `customer ${cust} is not in the imported customer data (accepted; linked if customers are imported later)` });
    }
    if (type === "transactions" && !accounts.has(String(record.account_id)) && !accounts.has(String(record.beneficiary_account))) {
      warnings.push({ field: "account_id", message: `neither ${record.account_id} nor ${record.beneficiary_account} is a known account (accepted; linked if accounts are imported later)` });
    }
    if (warnings.length > 0) {
      warningRows++;
      warnings.forEach((w) => push("warning", w));
    }
    existing.set(id, hash);
    accepted.push({ ...record, batch_id, source_file: ds.name ? `${filename}#${ds.name}` : filename, source_row, row_hash: hash });
  });

  const statements: InStatement[] = [];
  if (accepted.length > 0) {
    const cols = Object.keys(accepted[0]);
    for (let i = 0; i < accepted.length; i += INSERT_CHUNK) {
      const chunk = accepted.slice(i, i + INSERT_CHUNK);
      statements.push({
        sql: `INSERT INTO ${type} (${cols.join(",")}) VALUES ${chunk.map(() => `(${cols.map(() => "?").join(",")})`).join(",")}`,
        args: chunk.flatMap((r) => cols.map((c) => r[c] ?? null)),
      });
    }
  }
  for (let i = 0; i < issues.length; i += INSERT_CHUNK) {
    const chunk = issues.slice(i, i + INSERT_CHUNK);
    statements.push({
      sql: `INSERT INTO import_errors (batch_id, source_row, field, severity, message, raw_json) VALUES ${chunk.map(() => "(?,?,?,?,?,?)").join(",")}`,
      args: chunk.flatMap((x, j) => [batch_id, x.source_row, x.field, x.severity, x.message, issueRaw[i + j]]),
    });
  }
  const meta = { header_map: mapping.map, unmapped: mapping.unmapped, missing_columns: mapping.missingMandatory, notices, sheet: ds.name ?? null };
  statements.push({
    sql: `INSERT INTO import_batches (batch_id, filename, dataset_type, format, meta_json, total_rows, accepted, rejected, duplicates, warnings, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [batch_id, filename, type, ds.format, JSON.stringify(meta), ds.rows.length, accepted.length, rejected, duplicates, warningRows, new Date().toISOString()],
  });
  await db.batch(statements, "write");

  return {
    ok: true,
    batch_id,
    filename,
    sheet: ds.name,
    dataset_type: type,
    dataset_label: DATASET_LABELS[type],
    format: ds.format,
    header_map: mapping.map,
    unmapped: mapping.unmapped,
    missing_columns: mapping.missingMandatory,
    notices,
    total: ds.rows.length,
    accepted: accepted.length,
    rejected,
    duplicates,
    warnings: warningRows,
    issues: issues.slice(0, MAX_ISSUES_RETURNED),
    issues_truncated: issues.length > MAX_ISSUES_RETURNED,
  };
}
