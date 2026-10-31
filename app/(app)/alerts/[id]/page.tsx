import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { StatusBadge, Timeline } from "@/components/case-bits";
import { EvidenceTables, RuleTable } from "@/components/evidence";
import { Card, LevelBadge, Mono, Pill, buttonClass, fmtTime } from "@/components/ui";
import { assignRoles, describe, type TimelineEvent } from "@/lib/cases";
import { getAlert } from "@/lib/queries";

export const metadata: Metadata = { title: "Alert" };

export default function AlertPage({ params }: PageProps<"/alerts/[id]">) {
  return (
    <Suspense fallback={<p className="text-sm text-ink-3">Loading alert…</p>}>
      <AlertDetail params={params} />
    </Suspense>
  );
}



async function AlertDetail({ params }: { params: PageProps<"/alerts/[id]">["params"] }) {
  const { id } = await params;
  const data = await getAlert(id);
  if (!data) notFound();
  const { alert: a, rows, cases, members, parents } = data;
  const reduction = a.mitigations.reduce((s, m) => s + m.weight, 0);
  const netScore = a.raw_score - reduction;
  const clampedScore = Math.max(0, Math.min(100, netScore));
  const topSignal = [...a.signals].sort((x, y) => y.weight - x.weight)[0];
  const primary = rows.get(`${a.primary_ref.table}:${a.primary_ref.id}`);
  const primaryKey = `${a.primary_ref.table}:${a.primary_ref.id}`;
  const timeline: TimelineEvent[] = assignRoles([a], a.evidence
    .map((r) => {
      const row = rows.get(`${r.table}:${r.id}`);
      const e = row ? describe(r, row) : null;
      return e ? { ...e, flagged: `${r.table}:${r.id}` === primaryKey } : null;
    })
    .filter((e): e is TimelineEvent => !!e)
    .sort((x, y) => x.time.localeCompare(y.time)));

  return (
    <div className="space-y-5">
      <Link href="/alerts" className="text-sm text-accent-ink hover:underline">← Alerts</Link>
      <section className="rounded-xl border border-line bg-surface p-5 shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <LevelBadge level={a.level} score={a.score} />
              <Pill>{a.detector} · {a.category}</Pill>
              {a.products.map((p) => <Pill key={p} tone="accent">{p}</Pill>)}
            </div>
            <h1 className="mt-2 text-[22px] font-semibold leading-snug tracking-tight md:text-[26px]">{a.title}</h1>
            {topSignal && (
              <p className="mt-2 text-sm"><span className="font-medium">Primary suspicion:</span> <span className="text-ink-2">{topSignal.label}. {topSignal.detail}</span></p>
            )}
            <p className="mt-2 text-xs text-ink-3">
              Alert <Mono>{a.alert_id}</Mono> · event {fmtTime(a.event_time)} UTC · first detected in run <Mono>{a.first_run_id}</Mono> · original record, never modified
            </p>
          </div>
          <div className="w-full shrink-0 space-y-2 sm:w-64">
            {cases.length > 0 ? cases.map((c) => (
              <div key={c.case_id} className="rounded-lg border border-line bg-surface-2 p-3">
                <div className="flex items-center justify-between gap-2 text-xs text-ink-2"><span>Case <Mono>{c.case_id}</Mono></span><StatusBadge status={c.status} /></div>
                <Link href={`/cases/${c.case_id}`} className={`${buttonClass("primary")} mt-2 w-full`}>{c.status === "OPEN" ? "Review case & decide" : "Open case"}</Link>
              </div>
            )) : (
              <div className="rounded-lg border border-line bg-surface-2 p-3 text-xs text-ink-2">
                {a.level === "Low" ? "Monitored, not escalated: legitimate context outweighs the risk signals, so no case was opened." : "Not part of a case."}
              </div>
            )}
            {parents.map((p) => (
              <Link key={p.alert_id} href={`/alerts/${p.alert_id}`} className="block rounded-lg border border-risk-high/40 px-3 py-2 text-xs hover:bg-surface-2">
                Part of a cross-system finding (<Mono>{p.alert_id}</Mono>, {p.level} {p.score}) →
              </Link>
            ))}
          </div>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Risk score" className="lg:col-span-1">
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-semibold tabular">{a.score}</span>
            <span className="text-sm text-ink-2">/ 100 · {a.level}</span>
          </div>
          <ol className="mt-3 space-y-1.5 text-sm text-ink-2 tabular">
            <li className="flex justify-between gap-3"><span>Risk signals ({a.signals.length})</span><strong className="text-risk-high">+{a.raw_score}</strong></li>
            <li className="flex justify-between gap-3"><span>Legitimate context ({a.mitigations.length})</span><strong className="text-good-ink">−{reduction}</strong></li>
            <li className="flex justify-between gap-3 border-t border-line pt-1.5"><span>Net score</span><strong>{netScore}</strong></li>
            {clampedScore !== netScore && <li className="flex justify-between gap-3"><span>Clamped to 0–100</span><strong>{clampedScore}</strong></li>}
            {a.score !== clampedScore && <li className="flex justify-between gap-3"><span>Severity floor</span><strong>{clampedScore} → {a.score}</strong></li>}
            <li className="flex justify-between gap-3 border-t border-line pt-1.5 font-semibold text-ink"><span>Final score</span><span>{a.score} · {a.level}</span></li>
          </ol>
          {a.floor_note && <p className="mt-2 rounded bg-surface-2 px-2 py-1 text-xs">{a.floor_note}</p>}
          {topSignal && <p className="mt-2 text-xs text-ink-3">Largest weighted factor: {topSignal.label} (+{topSignal.weight}).</p>}
          <p className="mt-3 text-xs text-ink-3">High ≥ 70 · Medium 40–69 · Low &lt; 40. Low alerts are kept for review but do not open a case.</p>
        </Card>

        <Card title="Linked entities" className="lg:col-span-2">
          <dl className="space-y-3 text-sm">
            {([
              ["Customers", a.customer_ids, (id: string) => `/customers/${id}`],
              ["Accounts", a.account_ids, null],
              ["Devices", a.device_ids, null],
              ["Transactions", a.transaction_ids, null],
              ["Loan applications", a.application_ids, null],
              ["Insurance claims", a.claim_ids, null],
            ] as [string, string[], ((id: string) => string) | null][]).filter(([, ids]) => ids.length > 0).map(([label, ids, href]) => (
              <div key={label} className="flex flex-wrap items-start gap-x-3 gap-y-1">
                <dt className="w-36 shrink-0 text-xs text-ink-3">{label} ({ids.length})</dt>
                <dd className="flex min-w-0 flex-1 flex-wrap gap-1">
                  {ids.slice(0, 12).map((id) => href
                    ? <Link key={id} href={href(id)} className="rounded border border-line px-1.5 font-mono text-xs text-accent-ink hover:bg-surface-2">{id}</Link>
                    : <span key={id} className="rounded border border-line px-1.5 font-mono text-xs text-ink-2">{id}</span>)}
                  {ids.length > 12 && <span className="text-xs text-ink-3">+{ids.length - 12} more</span>}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-ink-3">These identifiers are what connect this alert to other alerts and cases.</p>
        </Card>
      </div>

      {primary && (
        <Card title="Underlying event">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-4">
            {Object.entries(primary).filter(([k]) => !["row_hash", "batch_id", "name_norm", "phone_norm", "email_norm", "address_norm", "surname"].includes(k) && primary[k] !== null && primary[k] !== "").map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt className="text-xs text-ink-3">{k.replace(/_/g, " ")}</dt>
                <dd className="truncate font-mono text-xs">{String(v)}</dd>
              </div>
            ))}
          </dl>
        </Card>
      )}

      <Card title="Why it was flagged">
        <RuleTable signals={a.signals} mitigations={a.mitigations} />
      </Card>

      {members.length > 0 && (
        <Card title={`Linked alerts (${members.length})`} padded={false}>
          <ul className="divide-y divide-line">
            {members.map((m) => (
              <li key={m.alert_id}>
                <Link href={`/alerts/${m.alert_id}`} className="flex flex-wrap items-center gap-3 px-4 py-2.5 hover:bg-surface-2">
                  <LevelBadge level={m.level} score={m.score} />
                  <Pill>{m.detector}</Pill>
                  <span className="text-sm">{m.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {timeline.length > 1 && (
        <Card title={`Event timeline (${timeline.length})`}>
          <Timeline events={timeline} />
        </Card>
      )}

      <details className="group rounded-xl border border-line bg-surface shadow-card" open={a.evidence.length <= 15}>
        <summary className="flex cursor-pointer items-center justify-between px-4 py-3 text-sm font-semibold">
          Supporting records ({a.evidence.length}) <span className="text-xs font-normal text-accent-ink group-open:hidden">Show source rows</span>
        </summary>
        <div className="border-t border-line p-4">
          <EvidenceTables refs={a.evidence} rows={rows} primary={a.primary_ref} />
        </div>
      </details>
    </div>
  );
}
