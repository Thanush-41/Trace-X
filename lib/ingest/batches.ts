import { all, one } from "@/lib/db/client";

export type BatchRow = {
  batch_id: string; filename: string; dataset_type: string; format: string; meta_json: string;
  total_rows: number; accepted: number; rejected: number; duplicates: number; warnings: number; created_at: string;
};

export function listBatches(limit = 100) {
  return all<BatchRow>("SELECT * FROM import_batches ORDER BY created_at DESC, rowid DESC LIMIT ?", [limit]);
}

export function getBatch(id: string) {
  return one<BatchRow>("SELECT * FROM import_batches WHERE batch_id = ?", [id]);
}

export function batchIssues(id: string) {
  return all<{ source_row: number; field: string | null; severity: string; message: string; raw_json: string }>(
    "SELECT source_row, field, severity, message, raw_json FROM import_errors WHERE batch_id = ? ORDER BY source_row, id",
    [id],
  );
}
