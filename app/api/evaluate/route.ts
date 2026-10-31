import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, HttpError } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { groundTruthSchema } from "@/lib/detect/evaluate";
import { bundledGroundTruth, evaluateLatestRun } from "@/lib/evaluation";

const body = z.union([z.object({ seed: z.coerce.number().int().positive() }), groundTruthSchema]);

/** POST {seed} to use a bundled answer key, or POST a ground_truth.json body. Scores the latest run. */
export const POST = handle(async (req: Request) => {
  await requireRole("analyst", "admin");
  const parsed = body.parse(await req.json().catch(() => ({})));
  const truth = "items" in parsed ? parsed : await bundledGroundTruth(parsed.seed);
  if (!truth) throw new HttpError(404, "No ground truth for that seed");
  const result = await evaluateLatestRun(truth);
  if (!result) throw new HttpError(409, "Run detection before evaluating");
  return NextResponse.json(result);
});
