import { NextResponse, connection } from "next/server";
import { handle, HttpError } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { recordDecision } from "@/lib/cases";
import { all } from "@/lib/db/client";

/** Decision history, newest first. */
export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/cases/[id]/decisions">) => {
  await connection();
  const { id } = await ctx.params;
  return NextResponse.json({ decisions: await all("SELECT * FROM case_decisions WHERE case_id = ? ORDER BY id DESC", [id]) });
});

/** Appends a decision; the case and its alerts stay unchanged. */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/cases/[id]/decisions">) => {
  const session = await requireRole("analyst", "admin");
  const { id } = await ctx.params;
  const body = await req.json().catch(() => {
    throw new HttpError(400, "Expected a JSON body");
  });
  // The analyst is always the signed-in user, never a name supplied by the client.
  return NextResponse.json(await recordDecision(id, { ...body, analyst: `${session.name} (${session.username})` }), { status: 201 });
});
