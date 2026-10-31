import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { EvidenceTables, RuleTable } from "@/components/evidence";
import { Card, LevelBadge, Mono, Pill, fmtTime } from "@/components/ui";
import { getAlert } from "@/lib/queries";

export const metadata: Metadata = { title: "Alert" };

export default function AlertPage({ params }: PageProps<"/alerts/[id]">) {
  return (
    <Suspense fallback={<p className="text-sm text-ink-3">Loading alert…</p>}>
      <AlertDetail params={params} />
    </Suspense>
  );
}

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Open", REQUIRES_INVESTIGATION: "Requires investigation", ESCALATED: "Escalated", FALSE_POSITIVE: "False positive", DISMISSED: "Dismissed",
};

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

  return (
    <div className="space-y-5">
      <div>
        <Link href="/alerts" className="text-sm text-accent-ink hover:underline">← Alerts</Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <LevelBadge level={a.level} score={a.score} />
          <Pill>{a.detector} · {a.category}</Pill>
          {a.products.map((p) => <Pill key={p} tone="accent">{p}</Pill>)}
        </div>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">{a.title}</h1>
        <p className="mt-1 text-sm text-ink-2">
          Alert <Mono>{a.alert_id}</Mono> · event {fmtTime(a.event_time)} UTC · first detected in run <Mono>{a.first_run_id}</Mono> · original record, never modified
        </p>
      </div>

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

        <Card title="Investigation" className="lg:col-span-2">
          {cases.length === 0 ? (
            <p className="text-sm text-ink-2">{a.level === "Low" ? "Reviewed and not escalated: legitimate context outweighs the risk signals, so no case was opened." : "Not part of a case."}</p>
          ) : (
            <ul className="space-y-2">
              {cases.map((c) => (
                <li key={c.case_id} className="flex flex-wrap items-center gap-2 text-sm">
                  <Link href={`/cases/${c.case_id}`} className="font-mono text-accent-ink hover:underline">{c.case_id}</Link>
                  <span className="text-ink-2">{c.title}</span>
                  <Pill tone={c.status === "OPEN" ? "accent" : "neutral"}>{STATUS_LABEL[c.status] ?? c.status}</Pill>
                </li>
              ))}
            </ul>
          )}
          {parents.length > 0 && (
            <p className="mt-3 text-sm text-ink-2">
              Part of cross-system finding{" "}
              {parents.map((p) => <Link key={p.alert_id} href={`/alerts/${p.alert_id}`} className="font-mono text-accent-ink hover:underline">{p.alert_id}</Link>)}
            </p>
          )}
          {a.customer_ids.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5 text-sm">
              <span className="text-ink-2">Customers:</span>
              {a.customer_ids.map((c) => <Link key={c} href={`/customers/${c}`} className="rounded border border-line px-1.5 font-mono text-xs text-accent-ink hover:bg-surface-2">{c}</Link>)}
            </div>
          )}
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

      <Card title={`Supporting records (${a.evidence.length})`}>
        <EvidenceTables refs={a.evidence} rows={rows} primary={a.primary_ref} />
      </Card>
    </div>
  );
}
