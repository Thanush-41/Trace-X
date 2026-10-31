import { NextResponse } from "next/server";
import { handle } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { runDetection } from "@/lib/detect/run";
import { logEvent } from "@/lib/db/client";

export const POST = handle(async () => {
  const session = await requireRole("analyst", "admin");
  const summary = await runDetection();
  await logEvent("detect", `Detection run ${summary.run_id}: ${summary.total_alerts} findings (${summary.by_level.High} High, ${summary.by_level.Medium} Medium), ${summary.total_cases} cases, ${summary.new_alerts} new alerts`, `${session.name} (${session.username})`);
  return NextResponse.json(summary);
});
