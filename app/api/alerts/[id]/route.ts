import { NextResponse, connection } from "next/server";
import { handle, HttpError } from "@/lib/api";
import { getAlert } from "@/lib/queries";

/** The alert, its resolved evidence rows, linked cases and (for FD-06) member alerts. */
export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/alerts/[id]">) => {
  await connection();
  const { id } = await ctx.params;
  const data = await getAlert(id);
  if (!data) throw new HttpError(404, "Alert not found");
  return NextResponse.json({ ...data, rows: Object.fromEntries(data.rows) });
});
