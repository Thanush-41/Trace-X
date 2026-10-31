import Link from "next/link";
import type { CaseModelView } from "@/lib/ml/query";
import { Pill, cx } from "@/components/ui";

/** Graph neural network's view of the case: a second opinion learned from data, separate from the rules. */
export function ModelPanel({ view }: { view: CaseModelView }) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-ink-2">
        {view.model}, trained on seeds 1–3, threshold {view.threshold} chosen on validation seed 101. Sealed test (seeds 201–202): AUC {view.test.auc}, precision {view.test.precision}, recall {view.test.recall}.{" "}
        <Link href="/evaluation#model" className="text-accent-ink hover:underline">Model card</Link>
      </p>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {view.customers.slice(0, 8).map((c) => (
          <li key={c.customer_id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2">
            <Link href={`/customers/${c.customer_id}`} className="w-28 shrink-0 font-mono text-xs text-accent-ink hover:underline">{c.customer_id}</Link>
            <span className="flex w-40 shrink-0 items-center gap-2">
              <span className="h-1.5 w-20 overflow-hidden rounded bg-surface-2"><span className={cx("block h-full", c.score >= view.threshold ? "bg-risk-high" : "bg-accent")} style={{ width: `${Math.round(c.score * 100)}%` }} /></span>
              <span className="tabular text-xs">{Math.round(c.score * 100)}%</span>
              {c.score >= view.threshold && <Pill tone="bad">above threshold</Pill>}
            </span>
            <span className="min-w-0 flex-1 text-xs text-ink-2">
              {c.drivers.length ? <>Driven by {c.drivers.join(", ")}</> : <span className="text-ink-3">No strong drivers</span>}
              {c.neighbours.length > 0 && <span className="block text-ink-3">Graph neighbours: {c.neighbours.slice(0, 3).map((n) => `${n.customer_id} (${Math.round(n.score * 100)}%) via ${n.via.slice(0, 2).join(", ")}`).join("; ")}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
