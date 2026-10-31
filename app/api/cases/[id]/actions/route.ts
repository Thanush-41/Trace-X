import { NextResponse, connection } from "next/server";
import { handle, HttpError } from "@/lib/api";
import { listActions, performAction } from "@/lib/actions";
import { requireRole } from "@/lib/auth";
import { logEvent } from "@/lib/db/client";

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/cases/[id]/actions">) => {
  await connection();
  const { id } = await ctx.params;
  return NextResponse.json({ actions: await listActions(id) });
});

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/cases/[id]/actions">) => {
  const session = await requireRole("analyst", "admin");
  const { id } = await ctx.params;
  const body = await req.json().catch(() => { throw new HttpError(400, "Expected a JSON body"); });
  const actor = `${session.name} (${session.username})`;
  const saved = await performAction(id, body, actor);
  await logEvent("action", `${saved.action.replace(/_/g, " ").toLowerCase()} on ${id}`, actor);
  return NextResponse.json(saved, { status: 201 });
});
