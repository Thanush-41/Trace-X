import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, HttpError } from "@/lib/api";
import { listSamples, loadSample } from "@/lib/ingest/samples";

const body = z.object({ seed: z.coerce.number().int().positive() });

export const POST = handle(async (req: Request) => {
  const { seed } = body.parse(await req.json().catch(() => ({})));
  if (!(await listSamples()).some((s) => s.seed === seed)) throw new HttpError(404, `Sample seed ${seed} not found`);
  return NextResponse.json({ results: await loadSample(seed) });
});
