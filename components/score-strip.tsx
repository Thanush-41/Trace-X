import Link from "next/link";
import { Pill } from "@/components/ui";
import type { CaseScores } from "@/lib/priority";

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const TIER_TONE = { Critical: "bad", High: "warn", Medium: "neutral", Low: "good", "Needs More Evidence": "accent" } as const;

/** Risk, confidence, exposure and agent trust are four different questions; they are never merged into one number. */
export function ScoreStrip({ scores, trust }: { scores: CaseScores; trust: { category: string; trust: number; level_name: string; n: number } | null }) {
  const tile = (label: string, value: string, sub: string) => (
    <div className="rounded-xl border border-line bg-surface p-3 shadow-card"><div className="text-xs text-ink-3">{label}</div><div className="mt-1 text-xl font-semibold tabular">{value}</div><div className="mt-0.5 text-xs text-ink-2">{sub}</div></div>
  );
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {tile("Risk score", `${scores.risk.score}/100`, `${scores.risk.level}: how suspicious the evidence is`)}
        {tile("Evidence confidence", `${Math.round(scores.confidence.score * 100)}%`, "how complete and corroborated it is")}
        {tile("Estimated exposure", inr(scores.exposure.inr), `${scores.exposure.items.length} record(s) at stake`)}
        {tile("Agent trust", trust ? trust.trust.toFixed(2) : "—", trust ? `${trust.category}: ${trust.n} decision(s), ${trust.level_name.split(" — ")[0]}` : "run the agent to see the category")}
        <div className="rounded-xl border border-line bg-surface p-3 shadow-card"><div className="text-xs text-ink-3">Investigation priority</div><div className="mt-1 flex items-center gap-2"><span className="text-xl font-semibold tabular">{scores.priority.score}</span><Pill tone={TIER_TONE[scores.priority.tier]}>{scores.priority.tier}</Pill></div><div className="mt-0.5 text-xs text-ink-2">order to work cases in</div></div>
      </div>
      {scores.priority.needs_more_evidence && <p className="rounded-md border border-risk-medium/60 bg-surface-2 px-3 py-2 text-xs">{scores.priority.reason}</p>}
      <details className="rounded-lg border border-line bg-surface px-3 py-2 text-sm">
        <summary className="cursor-pointer text-xs font-medium text-accent-ink">How priority, confidence and exposure were computed</summary>
        <div className="mt-3 grid gap-4 lg:grid-cols-3">
          <div><h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Priority components</h4>
            <ul className="space-y-1 text-xs">{scores.priority.components.map((c) => <li key={c.label} className="flex justify-between gap-2"><span>{c.label} <span className="text-ink-3">×{c.weight}</span></span><span className="tabular text-ink-2">{Math.round(c.value * 100)}% · {c.detail}</span></li>)}</ul></div>
          <div><h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Confidence factors</h4>
            <ul className="space-y-1 text-xs">{scores.confidence.factors.map((f) => <li key={f.label} className="flex justify-between gap-2"><span>{f.label}</span><span className="text-ink-2">{Math.round(f.value * 100)}% · {f.detail}</span></li>)}</ul></div>
          <div><h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Exposure records</h4>
            <ul className="space-y-1 text-xs">{scores.exposure.items.slice(0, 8).map((i) => <li key={`${i.ref.table}:${i.ref.id}`} className="flex justify-between gap-2"><span>{i.kind} <span className="font-mono text-ink-3">{i.ref.id}</span></span><span className="tabular text-ink-2">{inr(i.amount)}</span></li>)}{scores.exposure.items.length === 0 && <li className="text-ink-3">No monetary record is attached to this case.</li>}</ul>
            <Link href="/agent" className="mt-2 inline-block text-xs text-accent-ink hover:underline">About agent trust</Link></div>
        </div>
      </details>
    </div>
  );
}
