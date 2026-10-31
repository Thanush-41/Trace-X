import { NextResponse } from "next/server";
import { policy } from "@/lib/policy";

export async function GET() {
  return NextResponse.json(policy);
}
