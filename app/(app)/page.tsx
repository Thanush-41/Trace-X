import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { AlertTriangle, Database, FolderOpen, ShieldAlert } from "lucide-react";
import { AlertsOverTime } from "@/components/alerts-chart";
import { RunDetectionButton } from "@/components/run-detection";
import { StatusBadge } from "@/components/case-bits";
import { BarList, ButtonLink, Card, LevelBadge, PageHeader, Pill, Stat, fmtInt, fmtTime } from "@/components/ui";
import { dashboardSummary, workspaceIdentity } from "@/lib/queries";
import { rankedCases } from "@/lib/priority-list";
import { agentEvaluation } from "@/lib/agent/evaluation";
import { listAgentActions, trustReport } from "@/lib/agent/store";
import type { Level } from "@/lib/policy";

export default function DashboardPage() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-3">Loading command center…</p>}>
      <Dashboard />
    </Suspense>
  );
}

const LEVELS: Level[] = ["High", "Medium", "Low"];
const PRODUCT_LABELS: Record<string, string> = { banking: "Core banking", lending: "Lending", cards: "Cards", insurance: "Insurance" };

function FirstRun({ hasData }: { hasData: boolean }) {
  const steps = [
    { n: 1, title: "Load data", body: "Pick a bundled dataset or upload CSV, Excel or JSON from your systems.", done: hasData, action: <ButtonLink href="/ingest" variant={hasData ? "secondary" : "primary"}>Go to data ingestion</ButtonLink> },
    { n: 2, title: "Run detection", body: "Seven detectors, an ML anomaly model and cross-system correlation score every record.", done: false, action: hasData ? <RunDetectionButton /> : null },
    { n: 3, title: "Investigate", body: "Open prioritised cases, inspect the evidence and record decisions.", done: false, action: null },
  ];
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {steps.map((s) => (
        <div key={s.n} className="rounded-xl border border-line bg-surface p-4 shadow-card">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className={`grid h-6 w-6 place-items-center rounded-full text-xs ${s.done ? "bg-good text-white" : "bg-accent-wash text-accent-ink"}`}>{s.done ? "✓" : s.n}</span>
            {s.title}
          </div>
          <p className="mt-2 text-sm text-ink-2">{s.body}</p>
          {s.action && <div className="mt-3">{s.action}</div>}
        </div>
      ))}
    </div>
  );
}

async function Dashboard() {
  await connection();
  const [d, ws, ranked, trust, agentEval, agentActs] = await Promise.all([dashboardSummary(), workspaceIdentity(), rankedCases({ status: "open" }), trustReport(), agentEvaluation(), listAgentActions(3)]);
  const totalExposure = ranked.reduce((sum, c) => sum + c.scores.exposure.inr, 0);
  const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
  const actionable = d.levels.High + d.levels.Medium;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Fraud command center"
        title="Financial activity intelligence"
        description="Every number below comes from the records you imported and the latest detection run."
        actions={d.totalRecords > 0 && d.run ? <RunDetectionButton variant="secondary" /> : undefined}
      />

      {(d.totalRecords === 0 || !d.run) && <FirstRun hasData={d.totalRecords > 0} />}

      {d.totalRecords > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Records processed" icon={<Database className="h-4 w-4" />} value={fmtInt(d.totalRecords)} hint={`${fmtInt(d.imports.rejected)} rejected · ${fmtInt(d.imports.warnings)} with warnings`} href="/ingest" />
            <Stat label="Flagged events" icon={<AlertTriangle className="h-4 w-4" />} value={fmtInt(d.flagged)} hint={`${actionable} actionable · ${d.levels.Low} monitored`} href="/alerts?view=all" />
            <Stat label="High risk" icon={<ShieldAlert className="h-4 w-4" />} value={fmtInt(d.levels.High)} hint={`${d.levels.Medium} medium risk`} tone={d.levels.High ? "high" : undefined} href="/alerts?view=all&level=High" />
            <Stat label="Open cases" icon={<FolderOpen className="h-4 w-4" />} value={fmtInt(d.cases.open)} hint={`${d.cases.openHigh} high risk · ${d.cases.total} total`} href="/cases" />
          </div>

          <section className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm shadow-card md:grid-cols-3" aria-label="Current workspace">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-ink-3">Dataset in this workspace</div>
              <ul className="mt-1 space-y-0.5">
                {ws.sources.map((s) => <li key={s.name}><span className="font-medium">{s.name}</span> <span className="text-ink-2">· {fmtInt(s.records)} records in {s.files} file{s.files === 1 ? "" : "s"}</span></li>)}
              </ul>
              {ws.sources.length > 1 && <p className="mt-1 text-xs text-risk-medium">Several sources are loaded together; detection runs over all of them.</p>}
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-ink-3">Detection run shown</div>
              {d.run ? (
                <p className="mt-1"><span className="font-mono text-xs">{d.run.run_id}</span><span className="block text-ink-2">{fmtTime(d.run.finished_at)} UTC · policy v{d.run.policy_version} · {d.run.counts.total_alerts} findings · {d.run.counts.ms} ms</span></p>
              ) : <p className="mt-1 text-ink-2">Not run since the data changed.</p>}
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-ink-3">Shared workspace</div>
              <p className="mt-1 text-ink-2">{ws.lastReset ? <>Last reset {fmtTime(ws.lastReset.created_at)} UTC by {ws.lastReset.actor}</> : "Never reset"}. Everyone signed in sees and changes the same data.</p>
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Alerts over time (by event date)" className="lg:col-span-2">
              <AlertsOverTime rows={d.daily} />
            </Card>
            <Card title="Risk distribution">
              {d.flagged === 0 ? <p className="text-sm text-ink-3">Run detection to see results.</p> : (
                <>
                  <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded" role="img" aria-label={LEVELS.map((l) => `${l} ${d.levels[l]}`).join(", ")}>
                    {LEVELS.map((l) => d.levels[l] > 0 && (
                      <div key={l} title={`${l}: ${d.levels[l]}`} className={l === "High" ? "bg-risk-high" : l === "Medium" ? "bg-risk-medium" : "bg-risk-low"} style={{ flexGrow: d.levels[l] }} />
                    ))}
                  </div>
                  <ul className="mt-4 space-y-2">
                    {LEVELS.map((l) => (
                      <li key={l}>
                        <Link href={`/alerts?view=all&level=${l}`} className="flex items-center justify-between rounded-md px-1 py-0.5 text-sm hover:bg-surface-2">
                          <LevelBadge level={l} />
                          <span className="tabular font-medium">{d.levels[l]} <span className="font-normal text-ink-3">({Math.round((d.levels[l] / d.flagged) * 100)}%)</span></span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 text-xs text-ink-3">High and Medium open cases. Low alerts are kept as monitored signals with the reasons they were not escalated.</p>
                </>
              )}
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Investigation priorities" className="lg:col-span-2" padded={false} actions={<Link href="/cases" className="text-sm text-accent-ink hover:underline">All cases →</Link>}>
              {ranked.length === 0 ? <p className="p-4 text-sm text-ink-3">No open cases.</p> : (
                <ul className="divide-y divide-line">
                  {ranked.slice(0, 6).map((c) => (
                    <li key={c.case_id}>
                      <Link href={`/cases/${c.case_id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-surface-2">
                        <span className="w-10 text-center text-lg font-semibold tabular" title="Investigation priority">{c.scores.priority.score}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{c.title}</span>
                          <span className="block text-xs text-ink-3">{c.scores.priority.tier} · {c.category} · exposure {inr(c.scores.exposure.inr)} · confidence {Math.round(c.scores.confidence.score * 100)}%</span>
                        </span>
                        <LevelBadge level={c.level as Level} score={c.score} />
                        <StatusBadge status={c.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Fraud categories (actionable)">
              <BarList rows={d.byDetector.filter((x) => x.actionable > 0).map((x) => ({ label: <>{x.category} <span className="text-ink-3">{x.detector}</span></>, value: x.actionable, href: `/alerts?detector=${x.detector}`, title: `${x.actionable} actionable of ${x.n} findings` }))} emptyText="No actionable alerts" />
              <div className="mt-5 border-t border-line pt-4">
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-3">Products affected</div>
                <BarList rows={d.byProduct.map((p) => ({ label: PRODUCT_LABELS[p.product] ?? p.product, value: p.n, href: `/alerts?product=${p.product}` }))} emptyText="No alerts yet" />
              </div>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Stat label="Estimated exposure (open cases)" value={inr(totalExposure)} hint={`${ranked.filter((c) => c.scores.priority.needs_more_evidence).length} case(s) need more evidence before escalation`} href="/cases" />
            <Stat label="Agent feedback" value={fmtInt(agentEval.feedback.total)} hint={`${agentEval.feedback.analyst} analyst · ${agentEval.feedback.simulated_replay} simulated · ${agentEval.autonomous_safety.autonomous_actions} autonomous action(s)`} href="/agent" />
            <Stat label="Agent accuracy (accepted)" value={agentEval.agent_correctness.accuracy === null ? "—" : `${agentEval.agent_correctness.accuracy}%`} hint={`override rate ${agentEval.override_rate.all ?? "—"}% · held-out ${agentEval.holdout.accuracy ?? "—"}%`} href="/evaluation" />
          </div>

          <Card title="Agent trust overview" actions={<Link href="/agent" className="text-sm text-accent-ink hover:underline">Trust &amp; autonomy →</Link>}>
            <ul className="grid gap-x-8 gap-y-2 md:grid-cols-2">
              {trust.map((c) => (
                <li key={c.category} className="flex items-center gap-3 text-sm">
                  <span className="w-48 shrink-0 truncate">{c.category}</span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded bg-surface-2"><span className="block h-full bg-accent" style={{ width: `${Math.round(c.trust * 100)}%` }} /></span>
                  <span className="w-10 text-right text-xs tabular text-ink-2">{c.trust.toFixed(2)}</span>
                  <Pill tone={c.level >= 2 ? "good" : c.level === 1 ? "accent" : "neutral"}>L{c.level}</Pill>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-ink-3">Trust is earned per category from human decisions; it starts at zero. {agentActs.length ? `Latest autonomous action: ${agentActs[0].action} on ${agentActs[0].case_id}.` : "No autonomous action has been taken."}</p>
          </Card>

          {ws.events.length > 0 && (
            <Card title="Recent workspace activity" padded={false}>
              <ul className="divide-y divide-line text-sm">
                {ws.events.map((e) => (
                  <li key={e.id} className="flex flex-wrap gap-x-3 gap-y-0.5 px-4 py-2">
                    <span className="w-32 shrink-0 text-xs text-ink-3 tabular">{fmtTime(e.created_at)} UTC</span>
                    <span className={`w-20 shrink-0 text-xs font-medium uppercase ${e.kind === "reset" ? "text-risk-high" : "text-ink-2"}`}>{e.kind}</span>
                    <span className="min-w-0 flex-1">{e.detail}</span>
                    <span className="text-xs text-ink-3">{e.actor}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="Records by source system">
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
              {([["Customers", d.records.customers], ["Accounts", d.records.accounts], ["Transactions", d.records.transactions], ["Login events", d.records.login_events], ["Loan applications", d.records.loan_applications], ["Insurance claims", d.records.insurance_claims]] as const).map(([k, v]) => (
                <div key={k} className="rounded-lg bg-surface-2 px-3 py-2">
                  <dt className="text-xs text-ink-3">{k}</dt>
                  <dd className="text-lg font-semibold tabular">{fmtInt(v)}</dd>
                </div>
              ))}
            </dl>
          </Card>

          {d.recent.length > 0 && (
            <Card title="Latest high-risk alerts" padded={false} actions={<Link href="/alerts" className="text-sm text-accent-ink hover:underline">All alerts →</Link>}>
              <ul className="divide-y divide-line">
                {d.recent.slice(0, 5).map((a) => (
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
            </Card>
          )}
        </>
      )}
    </div>
  );
}
