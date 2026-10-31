import { NextResponse, connection } from "next/server";
import { handle, HttpError } from "@/lib/api";
import { getCase } from "@/lib/cases";
import { explainGrouping } from "@/lib/consolidation";

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/cases/[id]/grouping">) => {
  await connection();
  const { id } = await ctx.params;
  const data = await getCase(id);
  if (!data) throw new HttpError(404, "Case not found");
  return NextResponse.json(await explainGrouping(data.alerts));
});
