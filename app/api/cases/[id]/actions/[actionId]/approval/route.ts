import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, HttpError } from "@/lib/api";
import { decideApproval } from "@/lib/actions";
import { requireRole } from "@/lib/auth";
import { logEvent } from "@/lib/db/client";

const body = z.object({ outcome: z.enum(["approved", "rejected"]), reason: z.string().trim().min(5).max(1000) });

/** Authorised workflow for customer-impacting recommendations. Supervisors (admin) only. */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/cases/[id]/actions/[actionId]/approval">) => {
  const session = await requireRole("admin");
  const { id, actionId } = await ctx.params;
  const parsed = body.parse(await req.json().catch(() => { throw new HttpError(400, "Expected a JSON body"); }));
  const actor = `${session.name} (${session.username})`;
  const res = await decideApproval(id, Number(actionId), parsed.outcome, parsed.reason, actor, session.role);
  await logEvent("approval", `${parsed.outcome} recommendation #${actionId} on ${id}`, actor);
  return NextResponse.json(res, { status: 201 });
});
