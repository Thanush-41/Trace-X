import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { CustomerLink, StatusBadge } from "@/components/case-bits";
import { Card, Empty, LevelBadge, PageHeader, cx, fmtTime } from "@/components/ui";
import { rankedCases } from "@/lib/priority-list";

export const metadata: Metadata = { title: "Cases" };

const TABS = [["open", "Open"], ["closed", "Closed"], ["", "All current"], ["superseded", "Superseded"]] as const;

export default function CasesPage({ searchParams }: PageProps<"/cases">) {
  return (
    <>
      <PageHeader
        title="Investigation cases"
        description="Every High or Medium alert opens a case. Alerts that share a customer, account, device or application are grouped into one case. Decisions are appended; the original alerts never change."
      />
      <Suspense fallback={<p className="text-sm text-ink-3">Loading cases…</p>}>
        <Cases searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Cases({ searchParams }: { searchParams: PageProps<"/cases">["searchParams"] }) {
  const sp = await searchParams;
  const status = typeof sp.status === "string" ? sp.status : "open";
  const superseded = status === "superseded";
  const cases = await rankedCases(superseded ? { superseded: true } : { status: status || undefined });

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-line" role="tablist">
        {TABS.map(([v, label]) => (
          <Link key={label} href={`/cases?status=${v}`} role="tab" aria-selected={status === v}
            className={cx("-mb-px border-b-2 px-3 py-2 text-sm", status === v ? "border-accent font-medium text-ink" : "border-transparent text-ink-2 hover:text-ink")}>
            {label}
          </Link>
        ))}
      </div>
      {cases.length === 0 ? (
        <Empty title={status === "open" ? "No open cases" : "No cases"}>Run detection to open cases for High and Medium alerts.</Empty>
      ) : (
        <Card padded={false} title={`${cases.length} case${cases.length === 1 ? "" : "s"}`}>
          {superseded && <p className="border-b border-line px-4 py-2 text-xs text-ink-2">These cases came from an earlier state of the data; their alerts are not in the latest detection run. Decisions on them are kept.</p>}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="border-b border-line text-xs text-ink-3">
                <tr>{["Case", "Priority", "Risk", "Exposure / confidence", "Suspected fraud", "Summary", "Customer / account", "Alerts", "Status"].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-line">
                {cases.map((c) => (
                  <tr key={c.case_id} className="hover:bg-surface-2">
                    <td className="px-4 py-2.5"><Link href={`/cases/${c.case_id}`} className="font-mono text-xs text-accent-ink hover:underline">{c.case_id}</Link></td>
                    <td className="px-4 py-2.5 whitespace-nowrap"><span className="text-base font-semibold tabular">{c.scores.priority.score}</span><div className="text-[11px] text-ink-2">{c.scores.priority.tier}</div></td>
                    <td className="px-4 py-2.5">
                      <LevelBadge level={c.level} score={c.score} />
                      {c.current_level !== c.level && <div className="mt-1 text-[11px] text-ink-2">now {c.current_level}</div>}
                    </td>
                    <td className="px-4 py-2.5 text-xs whitespace-nowrap">₹{Math.round(c.scores.exposure.inr).toLocaleString("en-IN")}<div className="text-ink-3">{Math.round(c.scores.confidence.score * 100)}% confidence</div></td>
                    <td className="px-4 py-2.5">
                      {c.category}
                      {c.current_category !== c.category && <div className="text-[11px] text-ink-2">now {c.current_category}</div>}
                    </td>
                    <td className="max-w-xs px-4 py-2.5"><Link href={`/cases/${c.case_id}`} className="hover:underline">{c.title}</Link></td>
                    <td className="px-4 py-2.5 text-xs"><CustomerLink id={c.primary_customer_id} /><div className="font-mono text-ink-3">{c.primary_account_id ?? ""}</div></td>
                    <td className="px-4 py-2.5 tabular">{c.alert_count}</td>
                    <td className="px-4 py-2.5"><StatusBadge status={c.status} />{c.decided_at && <div className="mt-1 text-[11px] text-ink-3">{fmtTime(c.decided_at)}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-line md:hidden">
            {cases.map((c) => (
              <li key={c.case_id}>
                <Link href={`/cases/${c.case_id}`} className="block space-y-1.5 px-4 py-3 hover:bg-surface-2">
                  <div className="flex items-center justify-between gap-2"><LevelBadge level={c.level} score={c.score} /><StatusBadge status={c.status} /></div>
                  <div className="text-sm font-medium">{c.title}</div>
                  <div className="text-xs text-ink-3">{c.category} · {c.alert_count} alerts · {c.primary_customer_id ?? ""}</div>
                  <div className="text-xs text-ink-2">Priority {c.scores.priority.score} ({c.scores.priority.tier}) · exposure ₹{Math.round(c.scores.exposure.inr).toLocaleString("en-IN")}</div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
