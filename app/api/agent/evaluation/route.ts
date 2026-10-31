import { NextResponse, connection } from "next/server";
import { handle } from "@/lib/api";
import { agentEvaluation } from "@/lib/agent/evaluation";

export const GET = handle(async () => {
  await connection();
  return NextResponse.json(await agentEvaluation());
});
