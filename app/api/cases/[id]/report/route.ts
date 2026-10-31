import { NextResponse, connection } from "next/server";
import { handle } from "@/lib/api";
import { currentSession } from "@/lib/auth";
import { buildReport, reportPdf } from "@/lib/report";

/** Case report as structured JSON (default) or PDF (?format=pdf). */
export const GET = handle(async (req: Request, ctx: RouteContext<"/api/cases/[id]/report">) => {
  await connection();
  const { id } = await ctx.params;
  const session = await currentSession();
  const report = await buildReport(id, session ? `${session.name} (${session.username})` : "unknown");
  if (new URL(req.url).searchParams.get("format") === "pdf") {
    return new Response(new Uint8Array(reportPdf(report)), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${id}-report.pdf"` } });
  }
  return new NextResponse(JSON.stringify(report, null, 2), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${id}-report.json"` } });
});
