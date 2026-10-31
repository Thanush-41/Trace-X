import Papa from "papaparse";
import { connection } from "next/server";
import { handle, HttpError } from "@/lib/api";
import { batchIssues, getBatch } from "@/lib/ingest/batches";

/** Full issue report for one import batch as CSV. */
export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/batches/[id]/errors">) => {
  await connection();
  const { id } = await ctx.params;
  const batch = await getBatch(id);
  if (!batch) throw new HttpError(404, "Batch not found");
  const rows = await batchIssues(id);
  const csv = Papa.unparse(rows.map((r) => ({ row: r.source_row, severity: r.severity, field: r.field ?? "", message: r.message, original_values: r.raw_json })));
  return new Response(csv + "\n", {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${batch.filename.replace(/[^\w.-]+/g, "_")}-issues.csv"` },
  });
});
