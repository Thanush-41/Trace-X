import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { CustomerLink, StatusBadge, StatusProgress, Timeline } from "@/components/case-bits";
import { DecisionForm } from "@/components/decision-form";
import { InvestigationBrief } from "@/components/brief";
import { buildBrief } from "@/lib/narrative";
import { EvidenceTables, RuleTable } from "@/components/evidence";
import { Card, LevelBadge, Mono, Pill, fmtTime } from "@/components/ui";
import { getCase } from "@/lib/cases";
import type { Level } from "@/lib/policy";

export const metadata: Metadata = { title: "Case" };

export default function CasePage({ params }: PageProps<"/cases/[id]">) {
  return (
    <Suspense fallback={<p className="text-sm text-ink-3">Loading case…</p>}>
      <CaseDetail params={params} />
    </Suspense>
  );
}

async function CaseDetail({ params }: { params: PageProps<"/cases/[id]">["params"] }) {
  const { id } = await params;
  const data = await getCase(id);
  if (!data) notFound();
  const { case: c, alerts, decisions, timeline, rows } = data;
  const lead = alerts[0];
  const refs = alerts.flatMap((a) => a.evidence);
  const uniqueRefs = [...new Map(refs.map((r) => [`${r.table}:${r.id}`, r])).values()];
  const reclassified = c.current_level !== c.level || c.current_category !== c.category;
  const isCrossSystem = lead?.detector === "FD-06";
  const journeyDetectors = [...new Set(alerts.filter((a) => a.detector !== "FD-06").map((a) => a.detector))].sort();
  const journeyProducts = [...new Set(alerts.flatMap((a) => a.products))].sort();

  return (
    <div className="space-y-5">
      <div>
        <Link href="/cases" className="text-sm text-accent-ink hover:underline">← Cases</Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <StatusBadge status={c.status} />
          <LevelBadge level={c.level} score={c.score} />
          <Pill>{c.category}</Pill>
        </div>
        <h1 className="mt-2 text-[22px] font-semibold leading-snug tracking-tight md:text-[26px]">{c.title}</h1>
        <p className="mt-1 text-sm text-ink-2">
          Case <Mono>{c.case_id}</Mono> · opened {fmtTime(c.created_at)} UTC by run <Mono>{c.first_run_id}</Mono> · {c.alert_count} alert{c.alert_count === 1 ? "" : "s"}
        </p>
        <div className="mt-3"><StatusProgress status={c.status} history={decisions.map((d) => d.decision)} /></div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Classification">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-ink-2">Original risk</dt><dd><LevelBadge level={c.level} score={c.score} /></dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-2">Original category</dt><dd className="text-right">{c.category}</dd></div>
            {reclassified && (
              <>
                <div className="flex justify-between gap-3 border-t border-line pt-2"><dt className="text-ink-2">Analyst risk</dt><dd><LevelBadge level={c.current_level as Level} /></dd></div>
                <div className="flex justify-between gap-3"><dt className="text-ink-2">Analyst category</dt><dd className="text-right">{c.current_category}</dd></div>
              </>
            )}
            <div className="flex justify-between gap-3 border-t border-line pt-2"><dt className="text-ink-2">Customer</dt><dd><CustomerLink id={c.primary_customer_id} /></dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-2">Account</dt><dd><Mono>{c.primary_account_id ?? "—"}</Mono></dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-2">Status</dt><dd><StatusBadge status={c.status} /></dd></div>
          </dl>
          <p className="mt-3 text-xs text-ink-3">The original alert and score are stored read-only; reclassification is recorded as a decision.</p>
        </Card>

        <Card title="Record a decision" className="lg:sticky lg:top-4 lg:col-span-2 lg:self-start">
          <DecisionForm caseId={c.case_id} level={c.current_level} category={c.current_category} />
        </Card>
      </div>

      <InvestigationBrief brief={buildBrief(c, alerts, timeline)} />

      <Card title={`Decision history (${decisions.length})`} padded={decisions.length === 0}>
        {decisions.length === 0 ? (
          <p className="text-sm text-ink-3">No decisions yet. Status is Open.</p>
        ) : (
          <ol className="divide-y divide-line">
            {decisions.map((d) => (
              <li key={d.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3 text-sm">
                <span className="w-36 shrink-0 text-xs text-ink-3 tabular">{fmtTime(d.created_at)} UTC</span>
                <span className="w-44 shrink-0"><StatusBadge status={d.decision} /></span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{d.analyst}</span>
                  {d.note && <span className="text-ink-2">: {d.note}</span>}
                  {(d.revised_level || d.revised_category) && (
                    <span className="block text-xs text-ink-2">Reclassified{d.revised_level ? ` risk → ${d.revised_level}` : ""}{d.revised_category ? ` · category → ${d.revised_category}` : ""}</span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card title={`Alerts in this case (${alerts.length}) · original, read-only`} padded={false}>
        <ul className="divide-y divide-line">
          {alerts.map((a) => (
            <li key={a.alert_id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <LevelBadge level={a.level} score={a.score} />
                <Pill>{a.detector}</Pill>
                <Link href={`/alerts/${a.alert_id}`} className="text-sm font-medium hover:underline">{a.title}</Link>
                <span className="font-mono text-[11px] text-ink-3">{a.alert_id}</span>
              </div>
              <p className="mt-1 text-xs text-ink-2">
                {a.signals.map((s) => `${s.label} (+${s.weight})`).join(" · ")}
                {a.mitigations.length > 0 && <span className="text-good-ink"> · {a.mitigations.map((m) => `${m.label} (−${m.weight})`).join(" · ")}</span>}
              </p>
            </li>
          ))}
        </ul>
      </Card>

      {lead && lead.detector === "FD-06" && (
        <Card title="Why these alerts are connected">
          <RuleTable signals={lead.signals} mitigations={lead.mitigations} />
        </Card>
      )}

      <Card title={`${isCrossSystem ? "Cross-system fraud journey" : "Timeline"} (${timeline.length} events)`}>
        {isCrossSystem && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md bg-surface-2 p-3 text-xs text-ink-2">
            <span className="font-medium text-ink">Connected evidence:</span>
            {journeyDetectors.map((d) => <Pill key={d}>{d}</Pill>)}
            <span aria-hidden>across</span>
            {journeyProducts.map((p) => <Pill key={p} tone="accent">{p}</Pill>)}
            <span className="basis-full text-ink-3">Events are chronological; red markers are the primary events that triggered alerts. Every event links to its imported source record below.</span>
          </div>
        )}
        <Timeline events={timeline} />
      </Card>

      <Card title={`Supporting records (${uniqueRefs.length})`}>
        <EvidenceTables refs={uniqueRefs} rows={rows} />
      </Card>
    </div>
  );
}
