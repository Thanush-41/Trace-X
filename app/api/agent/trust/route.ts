import { NextResponse, connection } from "next/server";
import { handle } from "@/lib/api";
import { getSettings, listAgentActions, trustReport } from "@/lib/agent/store";

export const GET = handle(async (req: Request) => {
  await connection();
  const includeSimulated = new URL(req.url).searchParams.get("simulated") !== "0";
  return NextResponse.json({ categories: await trustReport({ includeSimulated }), settings: await getSettings(), actions: await listAgentActions() });
});
