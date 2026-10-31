import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { handle } from "@/lib/api";
import { listCases } from "@/lib/cases";

const query = z.object({
  status: z.enum(["open", "closed", "OPEN", "REQUIRES_INVESTIGATION", "ESCALATED", "FALSE_POSITIVE", "DISMISSED", "CLOSED"]).optional(),
  level: z.enum(["High", "Medium", "Low"]).optional(),
  category: z.string().max(80).optional(),
  customer: z.string().max(100).optional(),
});

export const GET = handle(async (req: Request) => {
  await connection();
  const params = Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v !== ""));
  return NextResponse.json({ cases: await listCases(query.parse(params)) });
});
