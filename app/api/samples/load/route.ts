import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, HttpError } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { listSamples, loadSample } from "@/lib/ingest/samples";
import { logEvent } from "@/lib/db/client";

const body = z.object({ seed: z.coerce.number().int().positive() });

export const POST = handle(async (req: Request) => {
  const session = await requireRole("analyst", "admin");
  const { seed } = body.parse(await req.json().catch(() => ({})));
  if (!(await listSamples()).some((s) => s.seed === seed)) throw new HttpError(404, `Sample seed ${seed} not found`);
  const results = await loadSample(seed);
  const accepted = results.reduce((s, r) => s + (r.ok ? r.accepted : 0), 0);
  await logEvent("load", `Loaded bundled sample seed ${seed}: ${accepted} new records`, `${session.name} (${session.username})`);
  return NextResponse.json({ results });
});
