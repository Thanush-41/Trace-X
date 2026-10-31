import { NextResponse } from "next/server";
import { handle } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { runDetection } from "@/lib/detect/run";

export const POST = handle(async () => {
  await requireRole("analyst", "admin");
  return NextResponse.json(await runDetection());
});
