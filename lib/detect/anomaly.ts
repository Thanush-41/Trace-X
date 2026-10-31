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
  "hour of day (sin, local time)",
  "hour of day (cos, local time)",
  "hours away from this customer's usual time",
  "new beneficiary",
  "beneficiary's number of senders (log)",
  "channel rarity for this account",
  "account age",
  "transfers in the previous 24 h",
  "outflow vs recent inflow",
  "gap since previous transfer vs usual gap",
  "amount vs declared monthly income",
  "weekend",
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

const MAX_HISTORY = 200;

/** First index in a time-sorted list whose ts is >= t. */
function lowerBound(xs: Txn[], t: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid].ts < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function offsetHours(offset: string): number {
  const m = offset.match(/^([+-])(\d{2}):?(\d{2})$/);
  return m ? (m[1] === "-" ? -1 : 1) * (+m[2] + +m[3] / 60) : 0;
}

/** Signed circular distance between two hours on a 24-hour clock. */
const hourGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % 24;
  return Math.min(d, 24 - d);
};

/**
 * Features for one transfer. Windows use binary search on the account's time-sorted transfers and the
 * baseline is capped at the last 200 transfers, so a 10k-transaction account stays fast.
 */
function featuresFor(ctx: DetectionContext, t: Txn, indegree: Map<string, number>, tzHours: number): number[] {
  const p = ctx.policy.fd01.params;
  const out = ctx.outByAccount.get(t.account_id) ?? [];
  const self = lowerBound(out, t.ts);
  const baseEnd = lowerBound(out, t.ts - p.baselineGapHours * 3600000);
  const history = out.slice(Math.max(0, baseEnd - MAX_HISTORY), baseEnd);
  const amounts = history.map((x) => x.amount);
  const z = amounts.length >= p.minHistory ? Math.max(-5, Math.min(25, robustZ(t.amount, amounts))) : 0;
  const recentPrior = out.slice(Math.max(0, self - MAX_HISTORY), self);
  const newBeneficiary = recentPrior.length > 0 && !recentPrior.some((x) => x.beneficiary_account === t.beneficiary_account) ? 1 : 0;
  const channelShare = history.length ? history.filter((x) => x.channel === t.channel).length / history.length : 1;
  const acc = ctx.accounts.get(t.account_id);
  const ageDays = acc ? Math.max(0, (t.ts - acc.opened) / 86400000) : 365;
  const last24 = self - lowerBound(out, t.ts - 86400000);
  const inflows = ctx.inByAccount.get(t.account_id) ?? [];
  const inflow = inflows.slice(lowerBound(inflows, t.ts - 7 * 86400000), lowerBound(inflows, t.ts + 1)).reduce((s, x) => s + x.amount, 0);
  const outflow = out.slice(lowerBound(out, t.ts - 86400000), lowerBound(out, t.ts + 1)).reduce((s, x) => s + x.amount, 0);

  const localHour = (ts: number) => (((new Date(ts).getUTCHours() + new Date(ts).getUTCMinutes() / 60 + tzHours) % 24) + 24) % 24;
  const hour = localHour(t.ts);
  const usualHour = history.length >= p.minHistory ? median(history.map((x) => localHour(x.ts))) : hour;
  const gaps = recentPrior.slice(1).map((x, i) => x.ts - recentPrior[i].ts).filter((g) => g > 0);
  const lastGap = self > 0 ? t.ts - out[self - 1].ts : 0;
  const gapRatio = gaps.length >= 3 && lastGap > 0 ? Math.max(-4, Math.min(4, Math.log10(lastGap / median(gaps)))) : 0;
  const owner = acc ? ctx.customers.get(acc.customer_id) : undefined;
  const monthlyIncome = owner?.declared_income ? owner.declared_income / 12 : 0;
  const day = new Date(t.ts + tzHours * 3600000).getUTCDay();

  return [
    Math.log10(Math.max(1, t.amount)),
    z,
    Math.sin((2 * Math.PI * hour) / 24),
    Math.cos((2 * Math.PI * hour) / 24),
    hourGap(hour, usualHour),
    newBeneficiary,
    Math.log10(1 + (indegree.get(t.beneficiary_account) ?? 0)),
    1 - channelShare,
    Math.log10(1 + ageDays),
    Math.min(last24, 20),
    inflow > 0 ? Math.min(outflow / inflow, 3) : 0,
    gapRatio,
    monthlyIncome > 0 ? Math.min(t.amount / monthlyIncome, 20) : 0,
    day === 0 || day === 6 ? 1 : 0,
  ];
}

/** Scores every outgoing transfer; returns results keyed by transaction ID. */
export function scoreTransfers(ctx: DetectionContext): Map<string, AnomalyResult> {
  const ml = ctx.policy.ml;
  const result = new Map<string, AnomalyResult>();
  const txns = [...ctx.outByAccount.values()].flat().filter((t) => t.status !== "reversed");
  if (!ml.enabled || txns.length < ml.minTransactions) return result;

  const indegree = new Map<string, number>();
  for (const [b, senders] of ctx.sendersByBeneficiary) indegree.set(b, new Set(senders.map((s) => s.customer)).size);
  const tzHours = offsetHours(ctx.policy.ingest.defaultTimezone);
  const rows = txns.map((t) => featuresFor(ctx, t, indegree, tzHours));
  const forest = new IsolationForest(ml.trees, ml.sampleSize, ml.seed).fit(rows);
  const scores = rows.map((r) => forest.score(r));
  const sorted = [...scores].sort((a, b) => a - b);
  const rank = (s: number) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < s) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  // Robust spread of each feature, used to name which features made a point unusual.
  const centre = FEATURES.map((_, j) => median(rows.map((r) => r[j])));
  const spread = FEATURES.map((_, j) => {
    const col = rows.map((r) => r[j]);
    return mad(col) || (quantile(col, 0.9) - quantile(col, 0.1)) / 2.56 || 1;
  });
  txns.forEach((t, i) => {
    const drivers = FEATURES.map((name, j) => ({ name, d: Math.abs(rows[i][j] - centre[j]) / spread[j] }))
      .filter((x) => x.d > 2)
      .sort((a, b) => b.d - a.d)
      .slice(0, 3)
      .map((x) => x.name);
    result.set(t.transaction_id, { score: Math.round(scores[i] * 1000) / 1000, percentile: Math.round((rank(scores[i]) / sorted.length) * 1000) / 10, drivers });
  });
  return result;
}
