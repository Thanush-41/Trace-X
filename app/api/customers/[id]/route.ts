import { NextResponse, connection } from "next/server";
import { handle, HttpError } from "@/lib/api";
import { getCustomerProfile } from "@/lib/customers";

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/customers/[id]">) => {
  await connection();
  const { id } = await ctx.params;
  const data = await getCustomerProfile(id);
  if (!data) throw new HttpError(404, "Customer not found");
  return NextResponse.json(data);
});
