import { NextResponse, connection } from "next/server";
import { handle } from "@/lib/api";
import { dashboardSummary } from "@/lib/queries";

export const GET = handle(async () => {
  await connection();
  return NextResponse.json(await dashboardSummary());
});
