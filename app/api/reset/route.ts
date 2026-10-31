import { NextResponse } from "next/server";
import { z } from "zod";
import { handle } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { resetWorkspace } from "@/lib/db/client";

const body = z.object({ confirm: z.literal("RESET") });

/** Demo convenience: drops all data, alerts, cases and decisions. The only path that removes alerts. */
export const POST = handle(async (req: Request) => {
  await requireRole("admin");
  body.parse(await req.json().catch(() => ({})));
  await resetWorkspace();
  return NextResponse.json({ ok: true });
});
