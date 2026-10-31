import { NextResponse, connection } from "next/server";
import { handle, HttpError } from "@/lib/api";
import { getCase } from "@/lib/cases";
import { buildCaseGraph } from "@/lib/graph";

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/cases/[id]/graph">) => {
  await connection();
  const { id } = await ctx.params;
  const data = await getCase(id);
  if (!data) throw new HttpError(404, "Case not found");
  return NextResponse.json(await buildCaseGraph(data.alerts));
});
