import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { handle } from "@/lib/api";
import { listCustomers } from "@/lib/customers";

const query = z.object({ q: z.string().max(100).optional(), flagged: z.enum(["1", "0"]).optional() });

export const GET = handle(async (req: Request) => {
  await connection();
  const { q, flagged } = query.parse(Object.fromEntries(new URL(req.url).searchParams));
  return NextResponse.json(await listCustomers(q ?? "", flagged === "1"));
});
