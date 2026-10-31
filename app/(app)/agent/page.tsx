import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { AgentAdmin } from "@/components/agent-admin";
import { TrustChart } from "@/components/trust-chart";
import { Card, PageHeader, Pill, cx, fmtTime } from "@/components/ui";
import { currentSession } from "@/lib/auth";
import { getSettings, listAgentActions, trustReport } from "@/lib/agent/store";
import { listLessons } from "@/lib/agent/learn";
import { llmEnabled, llmModel } from "@/lib/agent/llm";
import { policy } from "@/lib/policy";

export const metadata: Metadata = { title: "Agent trust" };

export default function AgentPage({ searchParams }: PageProps<"/agent">) {
  return (
    <>
      <PageHeader eyebrow="Adaptive investigator" title="Agent trust & autonomy" description="The agent starts with zero trust everywhere. Each analyst decision on its recommendations updates a category-specific, conservative score, and only that evidence can raise its permissions." />
      <Suspense fallback={<p className="text-sm text-ink-3">Loading trust…</p>}><Trust searchParams={searchParams} /></Suspense>
    </>
  );
}

const LEVEL_TONE = ["neutral", "accent", "good", "good"] as const;
const ALLOWED = [
  ["L0 — Observe", "No validated trust", "Analyzes cases. A human approves every decision."],
  ["L1 — Assist", "At least one validated decision", "Generates evidence-backed suggestions."],
  ["L2 — Recommend", "Enough decisions and trust above the L2 floor", "Proposes prioritised actions; a human confirms each."],
  ["L3 — Limited autonomy", "Volume, trust and held-out accuracy all above floor", "Only labels cases, routes them to a queue and requests analyst review. All reversible and logged."],
];

async function Trust({ searchParams }: { searchParams: PageProps<"/agent">["searchParams"] }) {
  await connection();
  const sp = await searchParams;
  const includeSimulated = sp.simulated !== "0";
  const [cats, settings, actions, session, lessons] = await Promise.all([trustReport({ includeSimulated }), getSettings(), listAgentActions(25), currentSession(), listLessons(20)]);
  const t = settings.thresholds;
  const total = cats.reduce((s, c) => s + c.n + c.holdout.n, 0);
  const simulated = cats.reduce((s, c) => s + Math.round(c.simulated_share * (c.n + c.holdout.n)), 0);
  return (
    <div className="space-y-6">
      <Card title="The feedback loop">
        <ol className="flex flex-wrap items-center gap-2 text-xs">
          {["Agent assessment", "Human review", "Accept / correct / reject", "Verified feedback", "Trust update", "Permission level", "Next investigation"].map((s, i, a) => (
            <li key={s} className="flex items-center gap-2"><span className="rounded-full border border-accent/50 bg-accent-wash px-2.5 py-1 text-accent-ink">{s}</span>{i < a.length - 1 && <span aria-hidden className="text-ink-3">→</span>}</li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-ink-2">Trust = lower 5% credible bound of a Beta-Binomial posterior (accepted vs corrected/rejected, weighted by evidence grounding), measured above the uninformed prior and discounted until {policy.agent.referenceFeedback} decisions exist. {Math.round(policy.agent.holdoutShare * 100)}% of cases (chosen by case-ID hash) are held out: they never change trust, only validate it. Customer-impacting actions are never autonomous at any level.</p>
        <p className="mt-2 text-xs text-ink-3">{total} validated decision(s) in total{simulated ? `, ${simulated} from the labelled answer-key replay` : ""}. <Link href={`/agent?simulated=${includeSimulated ? "0" : "1"}`} className="text-accent-ink hover:underline">{includeSimulated ? "Show human decisions only" : "Include simulated replay"}</Link></p>
      </Card>

      <Card title="Agent team">
        <ol className="grid gap-3 text-sm md:grid-cols-5">
          {[
            ["Orchestrator", "Reads the case, writes a brief, picks the entities and open questions."],
            ["Hypothesis agent", "Proposes competing fraud and legitimate explanations, applying lessons from past corrections."],
            ["SQL agent", "Writes read-only SQL over the source tables to test each hypothesis; repairs failed queries once."],
            ["Reviewer agent", "Judges each hypothesis from the query results, scores the investigation and recommends actions."],
            ["Feedback-learning agent", "Compares the conclusion with the analyst's verdict and writes a reusable lesson; trust is updated."],
          ].map(([t, d], i) => <li key={t} className="rounded-lg border border-line p-3"><div className="text-xs text-ink-3">Step {i + 1}</div><div className="font-medium">{t}</div><p className="mt-1 text-xs text-ink-2">{d}</p></li>)}
        </ol>
        <p className="mt-3 text-xs text-ink-2">{llmEnabled() ? `Language model: ${llmModel()} (OpenAI).` : "No language-model key configured: the deterministic tool agent runs instead."} Code checks every citation against the database before anything is shown; the SQL agent cannot see decisions, feedback or lessons, so it cannot read the answer it is graded on. Held-out cases never create lessons.</p>
      </Card>

      <Card title="Trust over validated decisions">
        <TrustChart categories={cats} />
      </Card>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {cats.map((c) => (
          <div key={c.category} className="rounded-xl border border-line bg-surface p-4 shadow-card">
            <div className="flex items-start justify-between gap-2"><h3 className="font-semibold">{c.category}</h3><Pill tone={LEVEL_TONE[c.level]}>{c.level_name}</Pill></div>
            <div className="mt-2 flex items-baseline gap-2"><span className="text-3xl font-semibold tabular">{c.trust.toFixed(2)}</span><span className="text-xs text-ink-3">trust · lower bound {c.lower_bound.toFixed(2)} × volume {Math.round(c.volume_factor * 100)}%</span></div>
            <div className="mt-2 h-1.5 overflow-hidden rounded bg-surface-2"><div className="h-full bg-accent" style={{ width: `${Math.round(c.trust * 100)}%` }} /></div>
            <dl className="mt-3 grid grid-cols-4 gap-2 text-center text-xs">
              {[["Decisions", c.n], ["Accepted", c.accepted], ["Corrected", c.corrected], ["Rejected", c.rejected]].map(([l, v]) => <div key={l as string}><dt className="text-ink-3">{l}</dt><dd className="text-base font-semibold tabular">{v}</dd></div>)}
            </dl>
            <p className="mt-3 text-xs text-ink-2">Held-out: {c.holdout.n ? `${Math.round((c.holdout.accuracy ?? 0) * 100)}% accepted over ${c.holdout.n} case(s)` : "no held-out cases yet"}</p>
            <p className="mt-1 text-xs text-ink-2">{c.level === 3 ? c.next_step : `Next: ${c.next_step}`}</p>
            {c.last_change && <p className={cx("mt-2 rounded bg-surface-2 px-2 py-1 text-xs", c.trend.at(-1)!.delta < 0 ? "text-risk-high" : "text-ink-2")}>{c.last_change}</p>}
            {c.simulated_share > 0 && <p className="mt-2 text-[11px] text-ink-3">{Math.round(c.simulated_share * 100)}% of this evidence is the labelled answer-key replay.</p>}
          </div>
        ))}
      </div>

      <Card title="Autonomy levels and permitted actions" padded={false}>
        <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-line text-xs text-ink-3"><tr><th className="px-4 py-2 font-medium">Level</th><th className="px-4 py-2 font-medium">Condition</th><th className="px-4 py-2 font-medium">Allowed behaviour</th></tr></thead>
          <tbody className="divide-y divide-line">{ALLOWED.map(([l, c, b]) => <tr key={l}><td className="px-4 py-2 font-medium">{l}</td><td className="px-4 py-2 text-ink-2">{c}</td><td className="px-4 py-2 text-ink-2">{b}</td></tr>)}</tbody>
        </table></div>
        <div className="space-y-1 border-t border-line px-4 py-3 text-xs text-ink-2">
          <p>Current thresholds: L1 ≥ {t.L1.minFeedback} decision; L2 ≥ {t.L2.minFeedback} decisions and trust ≥ {t.L2.minTrust}; L3 ≥ {t.L3.minFeedback} decisions, trust ≥ {t.L3.minTrust}, ≥ {t.L3.minHoldout} held-out decisions at ≥ {Math.round(t.L3.minHoldoutAccuracy * 100)}% accepted.</p>
          <p>Autonomous allowlist: <span className="font-mono">{policy.agent.autonomousAllowlist.join(", ")}</span>. Never autonomous: holds, transaction blocks, account restrictions, fund transfers, final adverse decisions.</p>
          <p>Kill switch: <span className={settings.kill_switch ? "font-semibold text-risk-high" : "font-medium"}>{settings.kill_switch ? "ON, no autonomous action anywhere" : "off"}</span>{settings.updated_by && ` · last changed by ${settings.updated_by}`}</p>
        </div>
      </Card>

      {session?.role === "admin" ? (
        <Card title="Administrator controls"><AgentAdmin killSwitch={settings.kill_switch} thresholds={t} /></Card>
      ) : (
        <p className="text-xs text-ink-3">The kill switch, thresholds and answer-key replay are available to administrators.</p>
      )}

      <Card title={`Lessons learned from analyst feedback (${lessons.length})`} padded={lessons.length === 0}>
        {lessons.length === 0 ? <p className="text-sm text-ink-3">No lessons yet. Each reviewed recommendation on a training case adds one.</p> : (
          <ul className="divide-y divide-line">{lessons.map((l) => (
            <li key={l.id} className="px-4 py-2 text-sm"><div className="text-xs text-ink-3">{fmtTime(l.created_at)} UTC · {l.signature} · agent said {l.predicted_category}{l.human_category && l.human_category !== l.predicted_category ? `, analyst said ${l.human_category}` : ", analyst agreed"} · {l.source === "llm" ? "written by the feedback-learning agent" : "template"}</div><div>{l.lesson}</div></li>
          ))}</ul>
        )}
      </Card>

      <Card title={`Autonomous action audit log (${actions.length})`} padded={actions.length === 0}>
        {actions.length === 0 ? <p className="text-sm text-ink-3">The agent has taken no autonomous action. That is expected until a category earns L3.</p> : (
          <ul className="divide-y divide-line">{actions.map((a) => (
            <li key={a.id} className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-2 text-sm"><span className="w-32 shrink-0 text-xs text-ink-3 tabular">{fmtTime(a.created_at)} UTC</span><span className="w-44 shrink-0 font-mono text-xs">{a.action}</span><Link href={`/cases/${a.case_id}`} className="w-36 shrink-0 font-mono text-xs text-accent-ink hover:underline">{a.case_id}</Link><span className="min-w-0 flex-1 text-ink-2">{a.category} · L{a.autonomy_level} · {a.detail} · reversible</span></li>
          ))}</ul>
        )}
      </Card>
    </div>
  );
}
