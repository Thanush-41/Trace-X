import { Card, Stat } from "@/components/ui";
import type { agentEvaluation } from "@/lib/agent/evaluation";

type Data = Awaited<ReturnType<typeof agentEvaluation>>;
const v = (n: number | null, unit = "%") => (n === null ? "—" : `${n}${unit}`);

/** Level 2 evaluation: all numbers come from stored feedback, assessments and the autonomous-action log. */
export function AgentEvaluationView({ data }: { data: Data }) {
  return (
    <section className="space-y-4" aria-label="Agent evaluation">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Agent evaluation</h2>
        <p className="mt-1 text-sm text-ink-2">Computed from {data.feedback.total} validated decision(s): {data.feedback.analyst} by analysts, {data.feedback.simulated_replay} by the labelled answer-key replay. With few decisions these rates are indicative only.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Agent correctness" value={v(data.agent_correctness.accuracy)} hint={`${data.agent_correctness.accepted} accepted · ${data.agent_correctness.corrected} corrected · ${data.agent_correctness.rejected} rejected`} />
        <Stat label="Analyst override rate" value={v(data.override_rate.analyst_only)} hint={`all feedback: ${v(data.override_rate.all)}`} />
        <Stat label="Held-out accuracy" value={v(data.holdout.accuracy)} hint={`${data.holdout.n} held-out decision(s), never used to learn`} />
        <Stat label="Autonomous-action safety" value={`${data.autonomous_safety.allowlist_violations + data.autonomous_safety.customer_impacting_actions_by_agent} violations`} hint={`${data.autonomous_safety.autonomous_actions} autonomous action(s); customer-impacting by agent: ${data.autonomous_safety.customer_impacting_actions_by_agent}`} tone={data.autonomous_safety.allowlist_violations + data.autonomous_safety.customer_impacting_actions_by_agent === 0 ? "good" : "high"} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Trust calibration: does stated confidence match accuracy?" padded={false}>
          <table className="w-full text-left text-sm"><thead className="border-b border-line text-xs text-ink-3"><tr><th className="px-4 py-2 font-medium">Agent confidence</th><th className="px-4 py-2 font-medium">Decisions</th><th className="px-4 py-2 font-medium">Accepted</th></tr></thead>
            <tbody className="divide-y divide-line">{data.calibration.map((b) => <tr key={b.range}><td className="px-4 py-2">{b.range}</td><td className="px-4 py-2 tabular">{b.n}</td><td className="px-4 py-2 tabular">{v(b.accuracy)}</td></tr>)}</tbody></table>
        </Card>
        <Card title="False-positive handling and grouping quality">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-ink-2">Cases judged not fraud</dt><dd className="tabular">{data.false_positive_handling.cases_judged_not_fraud}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-2">…of which the agent had flagged as likely legitimate</dt><dd className="tabular">{data.false_positive_handling.agent_flagged_as_likely_legitimate} ({v(data.false_positive_handling.share)})</dd></div>
            <div className="flex justify-between gap-3 border-t border-line pt-2"><dt className="text-ink-2">Cases / analyst splits</dt><dd className="tabular">{data.grouping_quality.cases} / {data.grouping_quality.analyst_splits} ({v(data.grouping_quality.split_rate)} split rate)</dd></div>
          </dl>
        </Card>
      </div>
      <Card title="Per-category trust and held-out validation" padded={false}>
        <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm"><thead className="border-b border-line text-xs text-ink-3"><tr>{["Category", "Training decisions", "Trust", "Level", "Held-out n", "Held-out accepted"].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-line">{data.categories.map((c) => <tr key={c.category}><td className="px-4 py-2">{c.category}</td><td className="px-4 py-2 tabular">{c.n}</td><td className="px-4 py-2 tabular">{c.trust.toFixed(3)}</td><td className="px-4 py-2">{c.level}</td><td className="px-4 py-2 tabular">{c.holdout_n}</td><td className="px-4 py-2 tabular">{v(c.holdout_accuracy === null ? null : Math.round(c.holdout_accuracy * 100))}</td></tr>)}</tbody></table></div>
      </Card>
    </section>
  );
}
