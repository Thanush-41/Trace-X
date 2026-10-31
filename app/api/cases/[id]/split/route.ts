import { NextResponse } from "next/server";
import { handle, HttpError } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { splitCase } from "@/lib/consolidation";
import { logEvent } from "@/lib/db/client";

/** Moves selected alerts into a new case, with a reason. Alerts and history are kept. */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/cases/[id]/split">) => {
  const session = await requireRole("analyst", "admin");
  const { id } = await ctx.params;
  const body = await req.json().catch(() => { throw new HttpError(400, "Expected a JSON body"); });
  const actor = `${session.name} (${session.username})`;
  const res = await splitCase(id, body, actor);
  await logEvent("split", `${res.moved.length} alert(s) split from ${id} into ${res.to_case_id}`, actor);
  return NextResponse.json(res, { status: 201 });
});
