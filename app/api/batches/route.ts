import { NextResponse, connection } from "next/server";
import { handle } from "@/lib/api";
import { listBatches } from "@/lib/ingest/batches";

export const GET = handle(async () => {
  await connection();
  const batches = (await listBatches()).map(({ meta_json, ...b }) => ({ ...b, meta: JSON.parse(meta_json) }));
  return NextResponse.json({ batches });
});
