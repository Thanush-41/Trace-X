import { NextResponse, connection } from "next/server";
import { handle } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { logEvent } from "@/lib/db/client";
import { latestAssessment, runAgent } from "@/lib/agent/store";

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/cases/[id]/agent">) => {
  await connection();
  const { id } = await ctx.params;
  return NextResponse.json({ assessment: await latestAssessment(id) });
});

/** Runs the investigation agent. It reads records and writes only its own assessment (plus allowlisted internal actions at L3). */
export const POST = handle(async (_req: Request, ctx: RouteContext<"/api/cases/[id]/agent">) => {
  const session = await requireRole("analyst", "admin");
  const { id } = await ctx.params;
  const actor = `${session.name} (${session.username})`;
  const res = await runAgent(id, actor);
  await logEvent("agent", `agent assessed ${id}: ${res.assessment.predicted_category}`, actor);
  return NextResponse.json(res, { status: 201 });
});
