import card from "@/config/model.json";
import { Card } from "@/components/ui";

type Metrics = { auc: number | null; ap: number | null; positives: number; n: number };
type CardT = {
  name: string; version: string; threshold: number;
  splits: Record<"train" | "validation" | "test", { seeds: number[]; customers: number; positives: number }>;
  candidates: { name: string; train: Metrics; validation: Metrics; test: Metrics }[];
  test: Metrics & { precision: number | null; recall: number | null; flagged: number };
  ablation: { removed: string[]; validation: Metrics; test: Metrics };
};
const c = card as unknown as CardT;

/** Graph-model card: what was trained, on which seeds, and how it did on data it never saw. */
export function ModelCard() {
  return (
    <section id="model" className="scroll-mt-24 space-y-4" aria-label="Graph model">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Graph neural network</h2>
        <p className="mt-1 text-sm text-ink-2">Selected by validation: <span className="font-medium">{c.name}</span>. It scores each customer from their own records and their neighbours in the customer graph (shared device, phone, email, national ID, payout or beneficiary account, invoice). Split by dataset so no customer appears in two splits; the test seeds were used once, after selection.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {(["train", "validation", "test"] as const).map((k) => (
          <div key={k} className="rounded-xl border border-line bg-surface p-3 shadow-card"><div className="text-xs capitalize text-ink-3">{k === "test" ? "sealed test" : k}</div><div className="mt-1 font-semibold">Seed {c.splits[k].seeds.join(", ")}</div><div className="text-xs text-ink-2">{c.splits[k].customers} customers, {c.splits[k].positives} fraud-linked</div></div>
        ))}
      </div>
      <Card title="Candidates (average precision is the fair metric with 5% positives)" padded={false}>
        <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-line text-xs text-ink-3"><tr>{["Model", "Train AP", "Validation AUC", "Validation AP", "Test AUC", "Test AP"].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-line">{c.candidates.map((m) => (
            <tr key={m.name} className={m.name === c.name ? "bg-accent-wash/50" : ""}><td className="px-4 py-2">{m.name}{m.name === c.name && " ✓"}</td><td className="px-4 py-2 tabular">{m.train.ap}</td><td className="px-4 py-2 tabular">{m.validation.auc}</td><td className="px-4 py-2 tabular">{m.validation.ap}</td><td className="px-4 py-2 tabular">{m.test.auc}</td><td className="px-4 py-2 tabular">{m.test.ap}</td></tr>
          ))}</tbody>
        </table></div>
        <div className="space-y-1 border-t border-line px-4 py-3 text-xs text-ink-2">
          <p>Operating threshold {c.threshold}, set on validation for precision ≥ 0.8. On the sealed test seeds it flags {c.test.flagged} customers: precision {c.test.precision}, recall {c.test.recall}.</p>
          <p>Without the enriched fields ({c.ablation.removed.join(", ")}) the same architecture reaches test AP {c.ablation.test.ap} vs {c.test.ap}.</p>
          <p>Synthetic data with planted scenarios: these numbers show the method generalises across datasets, not real-world accuracy. Train AP of 1.0 shows the model can memorise; held-out numbers are the ones that count.</p>
        </div>
      </Card>
    </section>
  );
}
