import Papa from "papaparse";
import * as XLSX from "xlsx";

export type RawDataset = {
  /** Sheet name or JSON key; used as a type hint. */
  name?: string;
  format: "csv" | "xlsx" | "json";
  headers: string[];
  rows: Record<string, unknown>[];
  /** Spreadsheet line number of rows[0] (header is line 1 for CSV/XLSX). */
  firstRow: number;
  notices: string[];
};

export class ParseError extends Error {}

export function formatOf(filename: string): RawDataset["format"] {
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "csv" || ext === "txt") return "csv";
  if (ext === "xlsx" || ext === "xls") return "xlsx";
  if (ext === "json") return "json";
  throw new ParseError(`Unsupported file type ".${ext}". Use CSV, Excel (.xlsx/.xls) or JSON.`);
}

export function parseFile(buffer: Buffer, filename: string): RawDataset[] {
  const format = formatOf(filename);
  if (format === "csv") return [parseCsv(buffer.toString("utf8").replace(/^﻿/, ""))];
  if (format === "xlsx") return parseXlsx(buffer);
  return parseJson(buffer.toString("utf8"));
}

function parseCsv(text: string): RawDataset {
  const res = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: "greedy", transformHeader: (h) => h.trim() });
  const headers = (res.meta.fields ?? []).filter((h) => h !== "");
  if (headers.length === 0) throw new ParseError("The CSV file has no header row.");
  const notices = res.errors.slice(0, 5).map((e) => `CSV line ${(e.row ?? 0) + 2}: ${e.message}`);
  if (res.errors.length > 5) notices.push(`…and ${res.errors.length - 5} more CSV structure issues`);
  return { format: "csv", headers, rows: res.data, firstRow: 2, notices };
}

function parseXlsx(buffer: Buffer): RawDataset[] {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: "buffer", cellDates: false, dense: true });
  } catch {
    throw new ParseError("The Excel file could not be read.");
  }
  const out: RawDataset[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: "", blankrows: false });
    if (grid.length === 0) continue;
    const headers = (grid[0] as unknown[]).map((h) => String(h ?? "").trim());
    const rows = grid.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r as unknown[])[i] ?? ""])));
    out.push({ name, format: "xlsx", headers: headers.filter((h) => h !== ""), rows, firstRow: 2, notices: [] });
  }
  if (out.length === 0) throw new ParseError("The Excel file has no sheets with data.");
  return out;
}

function parseJson(text: string): RawDataset[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new ParseError(`Invalid JSON: ${(e as Error).message}`);
  }
  const toDataset = (rows: unknown[], name?: string): RawDataset => {
    const isRecord = (r: unknown): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r);
    // Non-object entries still count as input rows so they are reported, not dropped.
    const normalized = rows.map((r) => (isRecord(r) ? r : { __invalid__: JSON.stringify(r) }));
    const invalid = rows.length - rows.filter(isRecord).length;
    const headers = [...new Set(rows.filter(isRecord).flatMap((o) => Object.keys(o)))];
    const notices = invalid > 0 ? [`${invalid} JSON entries are not objects and were reported as rejected`] : [];
    return { name, format: "json", headers, rows: normalized, firstRow: 1, notices };
  };
  if (Array.isArray(data)) return [toDataset(data)];
  if (data && typeof data === "object") {
    const entries = Object.entries(data as Record<string, unknown>).filter(([, v]) => Array.isArray(v));
    if (entries.length > 0) return entries.map(([k, v]) => toDataset(v as unknown[], k));
  }
  throw new ParseError("JSON must be an array of records, or an object whose values are arrays of records (e.g. {\"customers\": [...]}).");
}
