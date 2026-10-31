import { NextResponse } from "next/server";
import { handle, HttpError } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { logEvent } from "@/lib/db/client";
import { recordFeedback } from "@/lib/agent/store";

/** Accept, correct or reject the agent's latest recommendation. The feedback updates that category's trust. */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/cases/[id]/agent/feedback">) => {
  const session = await requireRole("analyst", "admin");
  const { id } = await ctx.params;
  const body = await req.json().catch(() => { throw new HttpError(400, "Expected a JSON body"); });
  const actor = `${session.name} (${session.username})`;
  const res = await recordFeedback(id, body, actor);
  await logEvent("feedback", `${(body as { outcome?: string }).outcome} agent recommendation on ${id}: trust ${res.before.trust} → ${res.after.trust}`, actor);
  return NextResponse.json(res, { status: 201 });
});
