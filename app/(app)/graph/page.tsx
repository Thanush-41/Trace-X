import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { CaseGraph } from "@/components/case-graph";
import { Card, Empty, LevelBadge, PageHeader, cx } from "@/components/ui";
import { getCase } from "@/lib/cases";
import { buildCaseGraph } from "@/lib/graph";
import { rankedCases } from "@/lib/priority-list";

export const metadata: Metadata = { title: "Relationship graph" };

export default function GraphPage({ searchParams }: PageProps<"/graph">) {
  return (
    <>
      <PageHeader eyebrow="Investigation" title="Fraud relationship graph" description="Entities and the links between them, built only from matching identifiers in the imported records. Click anything to see the records behind it." />
      <Suspense fallback={<p className="text-sm text-ink-3">Loading graph…</p>}><GraphView searchParams={searchParams} /></Suspense>
    </>
  );
}

async function GraphView({ searchParams }: { searchParams: PageProps<"/graph">["searchParams"] }) {
  await connection();
  const sp = await searchParams;
  const cases = await rankedCases({ status: "open" }, 30);
  if (cases.length === 0) return <Empty title="No open cases">Run detection to open cases; each case has its own relationship graph.</Empty>;
  const wanted = typeof sp.case === "string" ? sp.case : cases[0].case_id;
  const data = await getCase(wanted);
  if (!data) return <Empty title="Case not found">Pick a case from the list.</Empty>;
  const graph = await buildCaseGraph(data.alerts);
  return (
    <div className="grid gap-4 xl:grid-cols-[260px_1fr]">
      <Card title="Cases by priority" padded={false}>
        <ul className="max-h-[640px] divide-y divide-line overflow-auto">
          {cases.map((c) => (
            <li key={c.case_id}>
              <Link href={`/graph?case=${c.case_id}`} className={cx("block space-y-1 px-3 py-2 text-sm hover:bg-surface-2", c.case_id === wanted && "bg-accent-wash")}>
                <div className="flex items-center justify-between gap-2"><LevelBadge level={c.level} /><span className="text-xs text-ink-3">{c.scores.priority.tier}</span></div>
                <div className="line-clamp-2 text-xs">{c.title}</div>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-3 text-sm"><span className="font-semibold">{data.case.title}</span><Link href={`/cases/${wanted}`} className="text-accent-ink hover:underline">Open case workspace</Link></div>
        <CaseGraph graph={graph} caseId={wanted} height={600} />
      </div>
    </div>
  );
}
