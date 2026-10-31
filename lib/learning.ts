import { all } from "@/lib/db/client";
import { policy } from "@/lib/policy";

export type WeightSuggestion = {
  detector: string; code: string; label: string; current: number; suggested: number;
  cases: number; confirmed: number; falsePositives: number; coefficient: number;
};
export type LearningResult = { decided: number; minimum: number; suggestions: WeightSuggestion[] };

const MIN_DECIDED = 5;
const KEY: Record<string, keyof typeof policy> = { "FD-01": "fd01", "FD-02": "fd02", "FD-03": "fd03", "FD-04": "fd04", "FD-05": "fd05", "FD-07": "fd07", "FD-08": "fd08" };

/**
 * Learns from analyst decisions: a logistic regression on which signals were present in each decided case
 * (confirmed = requires investigation or escalated; rejected = false positive or dismissed). The output is a
 * suggestion per signal; policy weights are never changed automatically, so versioning and immutability hold.
 */
export async function learnFromDecisions(): Promise<LearningResult> {
  const rows = await all<{ case_id: string; decision: string; signals_json: string; detector: string }>(
    `SELECT c.case_id, d.decision, a.signals_json, a.detector
     FROM cases c
     JOIN case_decisions d ON d.id = (SELECT MAX(id) FROM case_decisions WHERE case_id = c.case_id)
     JOIN case_alerts_effective ca ON ca.case_id = c.case_id JOIN alerts a ON a.alert_id = ca.alert_id
     WHERE a.detector <> 'FD-06'`,
  );
  const byCase = new Map<string, { label: number; signals: Set<string> }>();
  const meta = new Map<string, { detector: string; label: string }>();
  for (const r of rows) {
    const label = r.decision === "FALSE_POSITIVE" || r.decision === "DISMISSED" ? 0 : 1;
    const c = byCase.get(r.case_id) ?? { label, signals: new Set<string>() };
    for (const s of JSON.parse(r.signals_json) as { code: string; label: string; weight: number }[]) {
      const key = `${r.detector}:${s.code}`;
      c.signals.add(key);
      meta.set(key, { detector: r.detector, label: s.label });
    }
    byCase.set(r.case_id, c);
  }
  const cases = [...byCase.values()];
  if (cases.length < MIN_DECIDED) return { decided: cases.length, minimum: MIN_DECIDED, suggestions: [] };

  const features = [...meta.keys()].sort();
  const X: number[][] = cases.map((c) => features.map((f) => (c.signals.has(f) ? 1 : 0)));
  const y = cases.map((c) => c.label);
  // L2-regularised logistic regression by gradient descent; deterministic (zero init, fixed steps).
  const w = new Array(features.length).fill(0);
  let b = 0;
  const lr = 0.3;
  const lambda = 0.1;
  for (let step = 0; step < 2000; step++) {
    const gw = new Array(features.length).fill(0);
    let gb = 0;
    X.forEach((x, i) => {
      const z = b + x.reduce((s, v, j) => s + v * w[j], 0);
      const err = 1 / (1 + Math.exp(-z)) - y[i];
      gb += err;
      x.forEach((v, j) => (gw[j] += err * v));
    });
    b -= (lr * gb) / X.length;
    for (let j = 0; j < w.length; j++) w[j] -= lr * (gw[j] / X.length + lambda * w[j]);
  }

  const suggestions = features.map((f, j) => {
    const { detector, label } = meta.get(f)!;
    const code = f.split(":")[1];
    const defs = (policy[KEY[detector]] as { signals?: Record<string, { weight: number }> } | undefined)?.signals;
    const current = defs?.[code]?.weight ?? 0;
    const withSignal = cases.filter((c) => c.signals.has(f));
    // Positive coefficient: analysts confirm cases with this signal more often than the baseline.
    const suggested = Math.max(0, Math.round(current * (1 + Math.tanh(w[j]) / 2)));
    return {
      detector, code, label, current, suggested, coefficient: Math.round(w[j] * 100) / 100,
      cases: withSignal.length, confirmed: withSignal.filter((c) => c.label === 1).length, falsePositives: withSignal.filter((c) => c.label === 0).length,
    };
  }).filter((s) => s.current > 0).sort((a, b) => Math.abs(b.suggested - b.current) - Math.abs(a.suggested - a.current));
  return { decided: cases.length, minimum: MIN_DECIDED, suggestions };
}
