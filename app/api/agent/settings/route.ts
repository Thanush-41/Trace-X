import { NextResponse } from "next/server";
import { handle, HttpError } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { logEvent } from "@/lib/db/client";
import { getSettings, setKillSwitch, setThresholds } from "@/lib/agent/store";

/** Admin controls: the global kill switch and stricter autonomy thresholds. */
export const POST = handle(async (req: Request) => {
  const session = await requireRole("admin");
  const body = (await req.json().catch(() => { throw new HttpError(400, "Expected a JSON body"); })) as { kill_switch?: boolean; thresholds?: unknown };
  const actor = `${session.name} (${session.username})`;
  if (typeof body.kill_switch === "boolean") {
    await setKillSwitch(body.kill_switch, actor);
    await logEvent("kill_switch", `autonomy kill switch ${body.kill_switch ? "ON" : "off"}`, actor);
  }
  if (body.thresholds) {
    await setThresholds(body.thresholds, actor);
    await logEvent("thresholds", "autonomy thresholds updated", actor);
  }
  return NextResponse.json(await getSettings());
});
