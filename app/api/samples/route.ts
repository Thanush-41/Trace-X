import { NextResponse } from "next/server";
import { connection } from "next/server";
import { handle, HttpError } from "@/lib/api";
import { listSamples, readSampleFile } from "@/lib/ingest/samples";

const TYPES: Record<string, string> = {
  csv: "text/csv; charset=utf-8",
  json: "application/json",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** GET /api/samples → list; GET /api/samples?seed=1&file=transactions_with_errors.csv → download. */
export const GET = handle(async (req: Request) => {
  await connection();
  const url = new URL(req.url);
  const file = url.searchParams.get("file");
  if (!file) return NextResponse.json({ samples: await listSamples() });
  const seed = Number(url.searchParams.get("seed"));
  const buf = Number.isInteger(seed) ? await readSampleFile(seed, file) : null;
  if (!buf) throw new HttpError(404, "Sample file not found");
  return new Response(new Uint8Array(buf), {
    headers: { "content-type": TYPES[file.split(".").pop()!], "content-disposition": `attachment; filename="seed-${seed}-${file}"` },
  });
});
