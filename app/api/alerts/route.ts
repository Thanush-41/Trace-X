import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { handle } from "@/lib/api";
import { listAlerts } from "@/lib/queries";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const query = z.object({
  view: z.enum(["escalated", "reviewed", "all"]).optional(),
  customer: z.string().max(100).optional(),
  transaction: z.string().max(100).optional(),
  product: z.enum(["banking", "lending", "cards", "insurance"]).optional(),
  level: z.enum(["High", "Medium", "Low"]).optional(),
  detector: z.enum(["FD-01", "FD-02", "FD-03", "FD-04", "FD-05", "FD-06", "FD-07"]).optional(),
  from: date.optional(),
  to: date.optional(),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

/** GET /api/alerts?customer=&transaction=&product=&level=&detector=&from=&to=&view=escalated|reviewed|all */
export const GET = handle(async (req: Request) => {
  await connection();
  const params = Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v !== ""));
  const { limit, ...filters } = query.parse(params);
  const { run, alerts, total } = await listAlerts(filters, limit);
  return NextResponse.json({ run_id: run?.run_id ?? null, total, alerts });
});
