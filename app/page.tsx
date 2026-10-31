import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { RunDetectionButton } from "@/components/run-detection";
import { BarList, ButtonLink, Card, Empty, LevelBadge, PageHeader, Pill, Stat, fmtInt, fmtTime } from "@/components/ui";
import { dashboardSummary } from "@/lib/queries";
import type { Level } from "@/lib/policy";

export default function DashboardPage() {
  return (
    <>
      <PageHeader
        title="Fraud intelligence dashboard"
        description="Records processed across customer, transaction, login and lending systems, and what the detectors flagged in the latest run."
      />
      <Suspense fallback={<p className="text-sm text-ink-3">Loading dashboard…</p>}>
        <Dashboard />
      </Suspense>
    </>
  );
}

const LEVELS: Level[] = ["High", "Medium", "Low"];
const PRODUCT_LABELS: Record<string, string> = { banking: "Core banking", lending: "Lending", cards: "Cards", insurance: "Insurance" };

async function Dashboard() {
  await connection();
  const d = await dashboardSummary();

  if (d.totalRecords === 0) {
    return (
      <Empty title="No data yet">
        Load a bundled sample dataset or upload your own CSV, Excel or JSON files to begin.
        <div className="mt-4">
          <ButtonLink href="/ingest" variant="primary">Go to data ingestion</ButtonLink>
        </div>
      </Empty>
    );
  }

  const actionable = d.levels.High + d.levels.Medium;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3">
        <div className="text-sm text-ink-2">
          {d.run ? (
            <>Last detection run <span className="font-medium text-ink">{fmtTime(d.run.finished_at)} UTC</span> · policy v{d.run.policy_version} · {d.run.counts.ms} ms</>
          ) : (
            <>Data is loaded but detection has not run yet.</>
          )}
        </div>
        <RunDetectionButton variant={d.run ? "secondary" : "primary"} />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Records processed" value={fmtInt(d.totalRecords)} hint={`${fmtInt(d.imports.total)} rows read in ${d.imports.batches} imports`} />
        <Stat label="Rows rejected" value={fmtInt(d.imports.rejected)} hint={`${fmtInt(d.imports.duplicates)} duplicates · ${fmtInt(d.imports.warnings)} with warnings`} />
        <Stat label="Flagged events" value={fmtInt(d.flagged)} hint={`${actionable} need investigation · ${d.levels.Low} reviewed, not escalated`} tone={actionable ? "high" : undefined} />
        <Stat label="Open cases" value={fmtInt(d.cases.open)} hint={`${d.cases.openHigh} high risk · ${d.cases.total} total`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Risk distribution">
          {d.flagged === 0 ? (
            <p className="text-sm text-ink-3">Run detection to see results.</p>
          ) : (
            <>
              <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded" role="img" aria-label={LEVELS.map((l) => `${l} ${d.levels[l]}`).join(", ")}>
                {LEVELS.map((l) => d.levels[l] > 0 && (
                  <div key={l} title={`${l}: ${d.levels[l]}`} className={l === "High" ? "bg-risk-high" : l === "Medium" ? "bg-risk-medium" : "bg-risk-low"} style={{ flexGrow: d.levels[l] }} />
                ))}
              </div>
              <ul className="mt-4 space-y-2">
                {LEVELS.map((l) => (
                  <li key={l} className="flex items-center justify-between text-sm">
                    <Link href={`/alerts?view=all&level=${l}`} className="hover:underline"><LevelBadge level={l} /></Link>
                    <span className="tabular font-medium">{d.levels[l]} <span className="font-normal text-ink-3">({Math.round((d.levels[l] / d.flagged) * 100)}%)</span></span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-ink-3">High and Medium alerts open cases. Low alerts are kept, with the reasons they were not escalated.</p>
            </>
          )}
        </Card>

        <Card title="Fraud categories (Medium + High)">
          <BarList
            rows={d.byDetector.map((x) => ({ label: <>{x.category} <span className="text-ink-3">{x.detector}</span></>, value: x.actionable, href: `/alerts?detector=${x.detector}`, title: `${x.actionable} actionable of ${x.n} findings` }))}
            emptyText="No alerts yet"
          />
        </Card>

        <Card title="Products affected (Medium + High)">
          <BarList rows={d.byProduct.map((p) => ({ label: PRODUCT_LABELS[p.product] ?? p.product, value: p.n, href: `/alerts?product=${p.product}` }))} emptyText="No alerts yet" />
          <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-line pt-3 text-xs text-ink-2">
            <dt>Customers</dt><dd className="text-right tabular">{fmtInt(d.records.customers)}</dd>
            <dt>Accounts</dt><dd className="text-right tabular">{fmtInt(d.records.accounts)}</dd>
            <dt>Transactions</dt><dd className="text-right tabular">{fmtInt(d.records.transactions)}</dd>
            <dt>Login events</dt><dd className="text-right tabular">{fmtInt(d.records.login_events)}</dd>
            <dt>Loan applications</dt><dd className="text-right tabular">{fmtInt(d.records.loan_applications)}</dd>
          </dl>
        </Card>
      </div>

      <Card title="Recent high-risk alerts" actions={<Link href="/alerts" className="text-sm text-accent-ink hover:underline">All alerts →</Link>} padded={false}>
        {d.recent.length === 0 ? (
          <p className="p-4 text-sm text-ink-3">No high-risk alerts in the latest run.</p>
        ) : (
          <ul className="divide-y divide-line">
            {d.recent.map((a) => (
              <li key={a.alert_id}>
                <Link href={`/alerts/${a.alert_id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-surface-2">
                  <LevelBadge level={a.level} score={a.score} />
                  <Pill>{a.detector}</Pill>
                  <span className="min-w-0 flex-1 truncate text-sm">{a.title}</span>
                  <span className="text-xs text-ink-3 tabular">{fmtTime(a.event_time)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
