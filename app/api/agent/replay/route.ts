import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, HttpError } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { logEvent } from "@/lib/db/client";
import { replayAnswerKey } from "@/lib/agent/replay";
import { answerKeyCoverage, bundledGroundTruth } from "@/lib/evaluation";

const body = z.object({ seeds: z.array(z.number().int()).min(1).max(5) });

/**
 * Simulated analyst: judges the current cases against the bundled answer key of the loaded seeds and records the
 * result as feedback labelled "answer_key_replay". Admin only; it is for evaluation and demos, never mixed with human feedback.
 */
export const POST = handle(async (req: Request) => {
  const session = await requireRole("admin");
  const { seeds } = body.parse(await req.json().catch(() => { throw new HttpError(400, "Expected a JSON body"); }));
  for (const s of seeds) {
    const truth = await bundledGroundTruth(s);
    if (!truth) throw new HttpError(404, `No bundled answer key for seed ${s}`);
    const cov = await answerKeyCoverage(truth);
    if (cov < 0.5) throw new HttpError(409, `Seed ${s} is not loaded in this workspace (only ${Math.round(cov * 100)}% of its records are present)`);
  }
  const actor = `Simulated analyst (answer key, run by ${session.username})`;
  const results = await replayAnswerKey(seeds, actor);
  await logEvent("replay", `answer-key replay recorded feedback on ${results.length} case(s)`, actor);
  return NextResponse.json({ results });
});
