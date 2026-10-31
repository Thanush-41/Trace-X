import { NextResponse } from "next/server";
import { handle } from "@/lib/api";
import { runDetection } from "@/lib/detect/run";

export const POST = handle(async () => NextResponse.json(await runDetection()));
