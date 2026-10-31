import { policy } from "@/lib/policy";
import { sha256 } from "@/lib/util/hash";

/**
 * Agent Trust & Autonomy Engine: per-category Beta-Binomial model of how often the agent's recommendation is
 * accepted by a human, with a conservative lower credible bound and a volume discount.
 *
 *   successes s = Σ grounding of accepted recommendations      (evidence quality counts)
 *   failures  f = Σ (1 − grounding) of accepted + 1 per corrected/rejected recommendation
 *   posterior = Beta(1 + s, 1 + f)
 *   trust     = (lowerBound_5%(posterior) − lowerBound_5%(prior)) / (1 − lowerBound_5%(prior)) × min(1, n / referenceFeedback)
 *
 * Zero feedback gives exactly zero trust; a single success cannot exceed the volume discount; one wrong
 * recommendation lowers it. Only the "train" share of feedback feeds trust; the "holdout" share is never learned
 * from and is used to check that the trust is not just memorised feedback.
 */
export const AGENT_CATEGORIES = [
  "Account takeover", "Shared-device coordination", "Identity fraud", "Loan fraud", "Insurance fraud", "Suspicious transfers", "Cross-system fraud",
] as const;
export type AgentCategory = (typeof AGENT_CATEGORIES)[number];

const BY_DETECTOR: Record<string, AgentCategory> = {
  "FD-01": "Suspicious transfers", "FD-02": "Shared-device coordination", "FD-03": "Account takeover", "FD-04": "Identity fraud",
  "FD-05": "Loan fraud", "FD-06": "Cross-system fraud", "FD-07": "Insurance fraud", "FD-08": "Suspicious transfers", "FD-ML": "Suspicious transfers", "FD-GNN": "Cross-system fraud",
};
export const categoryOfDetector = (d: string): AgentCategory => BY_DETECTOR[d] ?? "Suspicious transfers";

export type FeedbackRow = {
  id: number; assessment_id?: number; case_id: string; predicted_category: string; outcome: "accepted" | "corrected" | "rejected"; corrected_category: string | null;
  grounding: number; source: string; split: "train" | "holdout"; signature: string; created_at: string; actor: string; reasoning?: string | null;
};

export const splitFor = (caseId: string): "train" | "holdout" =>
  parseInt(sha256(caseId).slice(0, 8), 16) % 100 < Math.round(policy.agent.holdoutShare * 100) ? "holdout" : "train";

// Regularised incomplete beta by continued fraction (Numerical Recipes), enough for a credible bound.
function lnGamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let t = x + 5.5;
  t -= (x + 0.5) * Math.log(t);
  let s = 1.000000000190015;
  for (const ci of c) s += ci / ++y;
  return -t + Math.log((2.5066282746310005 * s) / x);
}
function betacf(a: number, b: number, x: number): number {
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}
export function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
export function betaQuantile(p: number, a: number, b: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (betaCdf(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export type Stats = { n: number; accepted: number; corrected: number; rejected: number; s: number; f: number };
const empty = (): Stats => ({ n: 0, accepted: 0, corrected: 0, rejected: 0, s: 0, f: 0 });
function add(st: Stats, r: FeedbackRow) {
  st.n++;
  if (r.outcome === "accepted") { st.accepted++; st.s += r.grounding; st.f += 1 - r.grounding; }
  else { st[r.outcome]++; st.f += 1; }
}
export const trustFrom = (st: Stats) => {
  const lower = betaQuantile(policy.agent.credibleLevel, 1 + st.s, 1 + st.f);
  const volume = Math.min(1, st.n / policy.agent.referenceFeedback);
  // Measured above what the uninformed prior already gives, so zero feedback and a lone failure both sit at exactly zero.
  const floor = betaQuantile(policy.agent.credibleLevel, 1, 1);
  const earned = Math.max(0, (lower - floor) / (1 - floor));
  return { lower, volume, trust: st.n === 0 ? 0 : Math.round(earned * volume * 1000) / 1000 };
};

export type Thresholds = typeof policy.agent.levels;
export type Level = 0 | 1 | 2 | 3;
export const LEVEL_NAME = ["L0 — Observe", "L1 — Assist", "L2 — Recommend", "L3 — Limited autonomy"] as const;

export function levelFor(trainN: number, trust: number, holdoutN: number, holdoutAcc: number, t: Thresholds = policy.agent.levels): { level: Level; next: string } {
  const l1 = trainN >= t.L1.minFeedback;
  const l2 = trainN >= t.L2.minFeedback && trust >= t.L2.minTrust;
  const l3 = trainN >= t.L3.minFeedback && trust >= t.L3.minTrust && holdoutN >= t.L3.minHoldout && holdoutAcc >= t.L3.minHoldoutAccuracy;
  const level: Level = l3 ? 3 : l2 ? 2 : l1 ? 1 : 0;
  const need: string[] = [];
  if (level < 1) need.push(`${t.L1.minFeedback - trainN} validated decision(s) for L1`);
  else if (level < 2) { if (trainN < t.L2.minFeedback) need.push(`${t.L2.minFeedback - trainN} more decision(s)`); if (trust < t.L2.minTrust) need.push(`trust ${trust.toFixed(2)} → ${t.L2.minTrust}`); need[0] = `for L2: ${need[0] ?? ""}`; }
  else if (level < 3) {
    const miss: string[] = [];
    if (trainN < t.L3.minFeedback) miss.push(`${t.L3.minFeedback - trainN} more training decision(s)`);
    if (trust < t.L3.minTrust) miss.push(`trust ${trust.toFixed(2)} → ${t.L3.minTrust}`);
    if (holdoutN < t.L3.minHoldout) miss.push(`${t.L3.minHoldout - holdoutN} more held-out decision(s)`);
    else if (holdoutAcc < t.L3.minHoldoutAccuracy) miss.push(`held-out accuracy ${Math.round(holdoutAcc * 100)}% → ${Math.round(t.L3.minHoldoutAccuracy * 100)}%`);
    need.push(`for L3: ${miss.join(", ")}`);
  }
  return { level, next: need.join("; ") || "Highest level reached; the kill switch and approval rules still apply" };
}

export type TrendPoint = { feedback_id: number; at: string; case_id: string; outcome: string; n: number; trust: number; delta: number; level: Level; why: string };
export type CategoryTrust = {
  category: AgentCategory; n: number; accepted: number; corrected: number; rejected: number; trust: number; lower_bound: number; volume_factor: number; level: Level; level_name: string;
  next_step: string; holdout: { n: number; accuracy: number | null; lower_bound: number | null }; trend: TrendPoint[]; last_change: string | null; simulated_share: number;
};

/** Replays feedback in order to produce each category's current trust, level and history. Nothing is stored or scripted. */
export function computeTrust(feedback: FeedbackRow[], t: Thresholds = policy.agent.levels, opts: { includeSimulated?: boolean } = {}): CategoryTrust[] {
  const rows = [...feedback].filter((r) => opts.includeSimulated !== false || r.source !== "answer_key_replay").sort((a, b) => a.id - b.id);
  return AGENT_CATEGORIES.map((category) => {
    const mine = rows.filter((r) => r.predicted_category === category);
    const train = empty();
    const hold = empty();
    const trend: TrendPoint[] = [];
    let prev = 0;
    for (const r of mine) {
      if (r.split === "holdout") { add(hold, r); continue; }
      add(train, r);
      const { trust } = trustFrom(train);
      const lvl = levelFor(train.n, trust, hold.n, hold.n ? hold.accepted / hold.n : 0, t).level;
      const verb = r.outcome === "accepted" ? "accepted" : r.outcome === "corrected" ? `corrected to ${r.corrected_category}` : "rejected";
      trend.push({ feedback_id: r.id, at: r.created_at, case_id: r.case_id, outcome: r.outcome, n: train.n, trust, delta: Math.round((trust - prev) * 1000) / 1000, level: lvl, why: `${r.case_id}: recommendation ${verb}` });
      prev = trust;
    }
    const { lower, volume, trust } = trustFrom(train);
    const holdAcc = hold.n ? hold.accepted / hold.n : null;
    const { level, next } = levelFor(train.n, trust, hold.n, holdAcc ?? 0, t);
    const last = trend[trend.length - 1];
    return {
      category, n: train.n, accepted: train.accepted, corrected: train.corrected, rejected: train.rejected, trust, lower_bound: Math.round(lower * 1000) / 1000, volume_factor: volume,
      level, level_name: LEVEL_NAME[level], next_step: next,
      holdout: { n: hold.n, accuracy: holdAcc === null ? null : Math.round(holdAcc * 1000) / 1000, lower_bound: hold.n ? Math.round(betaQuantile(policy.agent.credibleLevel, 1 + hold.s, 1 + hold.f) * 1000) / 1000 : null },
      trend,
      last_change: last ? `Trust ${last.delta >= 0 ? "rose" : "fell"} by ${Math.abs(last.delta).toFixed(3)} to ${last.trust.toFixed(3)} after ${last.why}` : null,
      simulated_share: mine.length ? mine.filter((r) => r.source === "answer_key_replay").length / mine.length : 0,
    };
  });
}

/** Online learning from corrected conclusions: per detector-signature, how often each category was right or the right answer. */
export type Learned = { accept: Record<string, Record<string, number>>; reject: Record<string, Record<string, number>>; corrected_to: Record<string, Record<string, number>> };
export function learnFrom(feedback: FeedbackRow[]): Learned {
  const L: Learned = { accept: {}, reject: {}, corrected_to: {} };
  const bump = (m: Record<string, Record<string, number>>, sig: string, cat: string) => { (m[sig] ??= {})[cat] = (m[sig][cat] ?? 0) + 1; };
  for (const r of feedback) {
    if (r.split !== "train") continue;
    if (r.outcome === "accepted") bump(L.accept, r.signature, r.predicted_category);
    else { bump(L.reject, r.signature, r.predicted_category); if (r.outcome === "corrected" && r.corrected_category) bump(L.corrected_to, r.signature, r.corrected_category); }
  }
  return L;
}
/** Multiplier on a hypothesis for this signature: Laplace-smoothed past accuracy, boosted when analysts corrected toward it. */
export function adjustment(L: Learned, sig: string, category: string): number {
  const a = L.accept[sig]?.[category] ?? 0;
  const r = L.reject[sig]?.[category] ?? 0;
  const to = L.corrected_to[sig]?.[category] ?? 0;
  return ((a + 1) / (a + r + 2)) * 2 * (1 + 0.25 * Math.min(4, to));
}
