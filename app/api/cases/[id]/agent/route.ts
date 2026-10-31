import { NextResponse, connection } from "next/server";
import { handle } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { logEvent } from "@/lib/db/client";
import { latestAssessment, runAgent } from "@/lib/agent/store";

/** Four sequential model calls plus SQL; allow for slow responses. */
export const maxDuration = 120;

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/cases/[id]/agent">) => {
  await connection();
  const { id } = await ctx.params;
  return NextResponse.json({ assessment: await latestAssessment(id) });
});

/** Runs the investigation agent. It reads records and writes only its own assessment (plus allowlisted internal actions at L3). */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/cases/[id]/agent">) => {
  const session = await requireRole("analyst", "admin");
  const { id } = await ctx.params;
  const actor = `${session.name} (${session.username})`;
  const body = (await req.json().catch(() => ({}))) as { mode?: "auto" | "deterministic" };
  const res = await runAgent(id, actor, { mode: body.mode === "deterministic" ? "deterministic" : "auto" });
  await logEvent("agent", `${res.assessment.mode} assessed ${id}: ${res.assessment.predicted_category}`, actor);
  return NextResponse.json(res, { status: 201 });
});
