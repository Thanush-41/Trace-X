import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { CustomerLink, StatusBadge } from "@/components/case-bits";
import { Card, Empty, LevelBadge, PageHeader, cx, fmtTime } from "@/components/ui";
import { listCases } from "@/lib/cases";

export const metadata: Metadata = { title: "Cases" };

const TABS = [["open", "Open"], ["closed", "Closed"], ["", "All"]] as const;

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
  const cases = await listCases({ status: status || undefined });

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
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="border-b border-line text-xs text-ink-3">
                <tr>{["Case", "Risk", "Suspected fraud", "Summary", "Customer / account", "Alerts", "Status", "Opened (UTC)"].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-line">
                {cases.map((c) => (
                  <tr key={c.case_id} className="hover:bg-surface-2">
                    <td className="px-4 py-2.5"><Link href={`/cases/${c.case_id}`} className="font-mono text-xs text-accent-ink hover:underline">{c.case_id}</Link></td>
                    <td className="px-4 py-2.5">
                      <LevelBadge level={c.level} score={c.score} />
                      {c.current_level !== c.level && <div className="mt-1 text-[11px] text-ink-2">now {c.current_level}</div>}
                    </td>
                    <td className="px-4 py-2.5">
                      {c.category}
                      {c.current_category !== c.category && <div className="text-[11px] text-ink-2">now {c.current_category}</div>}
                    </td>
                    <td className="max-w-xs px-4 py-2.5"><Link href={`/cases/${c.case_id}`} className="hover:underline">{c.title}</Link></td>
                    <td className="px-4 py-2.5 text-xs"><CustomerLink id={c.primary_customer_id} /><div className="font-mono text-ink-3">{c.primary_account_id ?? ""}</div></td>
                    <td className="px-4 py-2.5 tabular">{c.alert_count}</td>
                    <td className="px-4 py-2.5"><StatusBadge status={c.status} />{c.decided_at && <div className="mt-1 text-[11px] text-ink-3">{fmtTime(c.decided_at)}</div>}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-ink-2 tabular">{fmtTime(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
