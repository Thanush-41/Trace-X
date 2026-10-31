import { median, mad, quantile, robustZ } from "@/lib/util/stats";
import type { DetectionContext, Txn } from "./context";

/**
 * Unsupervised anomaly layer: an Isolation Forest (Liu, Ting & Zhou, 2008) trained on every outgoing
 * transfer in the workspace. Points that random axis-aligned splits isolate quickly are unusual relative
 * to the whole population. The score complements the per-account rules; it never raises an alert alone.
 * Training is seeded, so the same data always gives the same scores.
 */

export const FEATURES = [
  "amount (log)",
  "amount vs this account's history",
  "hour of day",
  "new beneficiary",
  "channel rarity for this account",
  "account age",
  "transfers in the previous 24 h",
  "outflow vs recent inflow",
] as const;

export type AnomalyResult = { score: number; percentile: number; drivers: string[] };

type Tree = { size: number } | { feature: number; split: number; left: Tree; right: Tree };

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Average path length of an unsuccessful BST search; normalises path lengths. */
const c = (n: number) => (n <= 1 ? 0 : 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1)) / n);

function build(rows: number[][], depth: number, maxDepth: number, rand: () => number): Tree {
  if (depth >= maxDepth || rows.length <= 1) return { size: rows.length };
  const dims = rows[0].length;
  for (let attempt = 0; attempt < dims; attempt++) {
    const feature = Math.floor(rand() * dims);
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of rows) {
      if (r[feature] < lo) lo = r[feature];
      if (r[feature] > hi) hi = r[feature];
    }
    if (hi <= lo) continue;
    const split = lo + rand() * (hi - lo);
    const left = rows.filter((r) => r[feature] < split);
    const right = rows.filter((r) => r[feature] >= split);
    return { feature, split, left: build(left, depth + 1, maxDepth, rand), right: build(right, depth + 1, maxDepth, rand) };
  }
  return { size: rows.length };
}

function pathLength(x: number[], node: Tree, depth = 0): number {
  if ("size" in node) return depth + c(node.size);
  return pathLength(x, x[node.feature] < node.split ? node.left : node.right, depth + 1);
}

export class IsolationForest {
  private trees: Tree[] = [];
  private sampleSize = 0;

  constructor(private nTrees: number, private maxSamples: number, private seed: number) {}

  fit(data: number[][]): this {
    const rand = mulberry32(this.seed);
    this.sampleSize = Math.min(this.maxSamples, data.length);
    const maxDepth = Math.ceil(Math.log2(Math.max(2, this.sampleSize)));
    for (let t = 0; t < this.nTrees; t++) {
      const sample: number[][] = [];
      for (let i = 0; i < this.sampleSize; i++) sample.push(data[Math.floor(rand() * data.length)]);
      this.trees.push(build(sample, 0, maxDepth, rand));
    }
    return this;
  }

  /** 0–1; values near 1 are anomalies, around 0.5 or below are normal. */
  score(x: number[]): number {
    if (this.trees.length === 0) return 0;
    const avg = this.trees.reduce((s, tr) => s + pathLength(x, tr), 0) / this.trees.length;
    return Math.pow(2, -avg / c(this.sampleSize));
  }
}

function featuresFor(ctx: DetectionContext, t: Txn): number[] {
  const out = ctx.outByAccount.get(t.account_id) ?? [];
  const gap = ctx.policy.fd01.params.baselineGapHours * 3600000;
  const history = out.filter((x) => x.ts < t.ts - gap);
  const amounts = history.map((x) => x.amount);
  const z = amounts.length >= ctx.policy.fd01.params.minHistory ? Math.max(-5, Math.min(25, robustZ(t.amount, amounts))) : 0;
  const prior = out.filter((x) => x.ts < t.ts);
  const newBeneficiary = prior.length > 0 && !prior.some((x) => x.beneficiary_account === t.beneficiary_account) ? 1 : 0;
  const channelShare = history.length ? history.filter((x) => x.channel === t.channel).length / history.length : 1;
  const acc = ctx.accounts.get(t.account_id);
  const ageDays = acc ? Math.max(0, (t.ts - acc.opened) / 86400000) : 365;
  const last24 = out.filter((x) => x.ts < t.ts && x.ts >= t.ts - 86400000).length;
  const inflow = (ctx.inByAccount.get(t.account_id) ?? []).filter((x) => x.ts <= t.ts && x.ts >= t.ts - 7 * 86400000).reduce((s, x) => s + x.amount, 0);
  const outflow = out.filter((x) => x.ts <= t.ts && x.ts >= t.ts - 86400000).reduce((s, x) => s + x.amount, 0);
  return [
    Math.log10(Math.max(1, t.amount)),
    z,
    new Date(t.ts).getUTCHours(),
    newBeneficiary,
    1 - channelShare,
    Math.log10(1 + ageDays),
    Math.min(last24, 20),
    inflow > 0 ? Math.min(outflow / inflow, 3) : 0,
  ];
}

/** Scores every outgoing transfer; returns results keyed by transaction ID. */
export function scoreTransfers(ctx: DetectionContext): Map<string, AnomalyResult> {
  const ml = ctx.policy.ml;
  const result = new Map<string, AnomalyResult>();
  const txns = [...ctx.outByAccount.values()].flat().filter((t) => t.status !== "reversed");
  if (!ml.enabled || txns.length < ml.minTransactions) return result;

  const rows = txns.map((t) => featuresFor(ctx, t));
  const forest = new IsolationForest(ml.trees, ml.sampleSize, ml.seed).fit(rows);
  const scores = rows.map((r) => forest.score(r));
  const sorted = [...scores].sort((a, b) => a - b);
  // Robust spread of each feature, used to name which features made a point unusual.
  const centre = FEATURES.map((_, j) => median(rows.map((r) => r[j])));
  const spread = FEATURES.map((_, j) => {
    const col = rows.map((r) => r[j]);
    return mad(col) || (quantile(col, 0.9) - quantile(col, 0.1)) / 2.56 || 1;
  });
  txns.forEach((t, i) => {
    const s = scores[i];
    let below = 0;
    while (below < sorted.length && sorted[below] < s) below++;
    const drivers = FEATURES.map((name, j) => ({ name, d: Math.abs(rows[i][j] - centre[j]) / spread[j] }))
      .filter((x) => x.d > 2)
      .sort((a, b) => b.d - a.d)
      .slice(0, 3)
      .map((x) => x.name);
    result.set(t.transaction_id, { score: Math.round(s * 1000) / 1000, percentile: Math.round((below / sorted.length) * 1000) / 10, drivers });
  });
  return result;
}
