import modelCard from "@/config/model.json";
import type { DetectionContext } from "@/lib/detect/context";
import { customerGraph, graphFeatures, nodeFeatures } from "./features";
import { predict, type MlpModel } from "./mlp";

export type GraphScore = { customer_id: string; score: number; drivers: string[]; neighbours: { customer_id: string; via: string[]; score: number }[] };
export const MODEL = modelCard as unknown as { name: string; version: string; graph: boolean; threshold: number; features: string[]; test: { auc: number; ap: number; precision: number; recall: number }; model: MlpModel };

/**
 * Scores every customer with the trained graph model. Drivers come from occlusion: each feature is replaced by its
 * training mean and the features whose removal lowers the score most are reported.
 */
export function scoreCustomers(ctx: DetectionContext): Map<string, GraphScore> {
  const { ids, X } = nodeFeatures(ctx);
  if (ids.length === 0) return new Map();
  const { edges, reasons } = customerGraph(ctx, ids);
  const F = MODEL.graph ? graphFeatures(ids.length, edges, X) : X;
  const m = MODEL.model;
  const scores = F.map((x) => predict(m, x));
  const nbrs = new Map<number, { j: number; key: string }[]>();
  for (const [a, b] of edges) {
    const key = `${[ids[a], ids[b]].sort().join("|")}`;
    nbrs.set(a, [...(nbrs.get(a) ?? []), { j: b, key }]);
    nbrs.set(b, [...(nbrs.get(b) ?? []), { j: a, key }]);
  }
  const out = new Map<string, GraphScore>();
  ids.forEach((id, i) => {
    let drivers: string[] = [];
    if (scores[i] >= 0.1) {
      drivers = F[i].map((_, j) => {
        const x = [...F[i]];
        x[j] = m.mean[j];
        return { name: MODEL.features[j], drop: scores[i] - predict(m, x) };
      }).filter((d) => d.drop > 0.01).sort((a, b) => b.drop - a.drop).slice(0, 4).map((d) => d.name);
    }
    const neighbours = (nbrs.get(i) ?? []).map(({ j, key }) => ({ customer_id: ids[j], via: reasons.get(key) ?? [], score: Math.round(scores[j] * 1000) / 1000 }))
      .sort((a, b) => b.score - a.score).slice(0, 6);
    out.set(id, { customer_id: id, score: Math.round(scores[i] * 1000) / 1000, drivers, neighbours });
  });
  return out;
}
