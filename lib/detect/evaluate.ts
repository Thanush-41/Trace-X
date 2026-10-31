import { z } from "zod";
import type { Level } from "@/lib/policy";

const entitySchema = z.object({
  customer_ids: z.array(z.string()).optional(),
  account_ids: z.array(z.string()).optional(),
  transaction_ids: z.array(z.string()).optional(),
  device_ids: z.array(z.string()).optional(),
  application_ids: z.array(z.string()).optional(),
});
const itemSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), scenario: z.string(), kind: z.literal("fraud"), detector: z.string(), expected_level: z.enum(["High", "Medium"]), entities: entitySchema, note: z.string().optional() }),
  z.object({ id: z.string(), scenario: z.string(), kind: z.literal("lookalike"), detector: z.string(), max_level: z.enum(["Low", "None"]), entities: entitySchema, note: z.string().optional() }),
]);
export const groundTruthSchema = z.object({ seed: z.number().optional(), items: z.array(itemSchema).min(1) });
export type GroundTruth = z.infer<typeof groundTruthSchema>;
type EntityKey = keyof z.infer<typeof entitySchema>;

export type EvalAlert = {
  alert_id: string;
  detector: string;
  level: Level;
  score: number;
  title: string;
  entities: Record<EntityKey, string[]>;
};

export type ItemResult = {
  id: string; scenario: string; kind: "fraud" | "lookalike"; detector: string; expectation: string;
  pass: boolean; matched: { alert_id: string; level: Level; score: number; title: string }[]; note?: string;
};

export type Evaluation = {
  items: ItemResult[];
  fraud_detected: number; fraud_total: number; recall: number;
  lookalikes_clean: number; lookalikes_total: number; lookalike_false_positive_rate: number;
  actionable_alerts: number; actionable_alerts_on_planted: number; precision: number;
};

const RANK: Record<Level | "None", number> = { None: 0, Low: 1, Medium: 2, High: 3 };

/** An alert matches an item when, for every entity type the item lists, they share at least one ID. */
function matches(alert: EvalAlert, entities: Partial<Record<EntityKey, string[]>>): boolean {
  const keys = Object.keys(entities) as EntityKey[];
  return keys.length > 0 && keys.every((k) => (entities[k] ?? []).some((id) => alert.entities[k]?.includes(id)));
}

export function evaluate(truth: GroundTruth, alerts: EvalAlert[]): Evaluation {
  const items: ItemResult[] = truth.items.map((item) => {
    const candidates = alerts.filter((a) => a.detector === item.detector && matches(a, item.entities));
    const summary = (xs: EvalAlert[]) => xs.map((a) => ({ alert_id: a.alert_id, level: a.level, score: a.score, title: a.title }));
    if (item.kind === "fraud") {
      const hits = candidates.filter((a) => RANK[a.level] >= RANK[item.expected_level]);
      return { id: item.id, scenario: item.scenario, kind: item.kind, detector: item.detector, expectation: `${item.expected_level} or higher`, pass: hits.length > 0, matched: summary(hits.length ? hits : candidates), note: item.note };
    }
    const breaches = candidates.filter((a) => RANK[a.level] > RANK[item.max_level]);
    return { id: item.id, scenario: item.scenario, kind: item.kind, detector: item.detector, expectation: item.max_level === "None" ? "no alert" : `at most ${item.max_level}`, pass: breaches.length === 0, matched: summary(breaches.length ? breaches : candidates), note: item.note };
  });

  const fraud = items.filter((i) => i.kind === "fraud");
  const look = items.filter((i) => i.kind === "lookalike");
  const fraudEntities = truth.items.filter((i) => i.kind === "fraud").map((i) => i.entities);
  const actionable = alerts.filter((a) => a.level !== "Low");
  const onPlanted = actionable.filter((a) => fraudEntities.some((e) =>
    (Object.keys(e) as EntityKey[]).some((k) => (e[k] ?? []).some((id) => a.entities[k]?.includes(id)))));
  return {
    items,
    fraud_detected: fraud.filter((i) => i.pass).length,
    fraud_total: fraud.length,
    recall: fraud.length ? fraud.filter((i) => i.pass).length / fraud.length : 1,
    lookalikes_clean: look.filter((i) => i.pass).length,
    lookalikes_total: look.length,
    lookalike_false_positive_rate: look.length ? look.filter((i) => !i.pass).length / look.length : 0,
    actionable_alerts: actionable.length,
    actionable_alerts_on_planted: onPlanted.length,
    precision: actionable.length ? onPlanted.length / actionable.length : 1,
  };
}
