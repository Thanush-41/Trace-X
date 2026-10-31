/**
 * Small multilayer perceptron (one hidden ReLU layer, sigmoid output) trained with Adam on weighted binary
 * cross-entropy. Seeded, so training is reproducible. With hidden = 0 it is plain logistic regression.
 */
export type MlpModel = { mean: number[]; std: number[]; W1: number[][]; b1: number[]; W2: number[]; b2: number; hidden: number };

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const sig = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export function predict(m: MlpModel, x: number[]): number {
  const z = x.map((v, j) => (v - m.mean[j]) / m.std[j]);
  if (m.hidden === 0) return sig(m.W2.reduce((s, w, j) => s + w * z[j], m.b2));
  const h = m.W1.map((row, k) => Math.max(0, row.reduce((s, w, j) => s + w * z[j], m.b1[k])));
  return sig(h.reduce((s, v, k) => s + v * m.W2[k], m.b2));
}

export function train(X: number[][], y: number[], opts: { hidden: number; epochs: number; lr: number; l2: number; seed: number; posWeight?: number }): MlpModel {
  const d = X[0].length;
  const mean = Array.from({ length: d }, (_, j) => X.reduce((s, r) => s + r[j], 0) / X.length);
  const std = Array.from({ length: d }, (_, j) => Math.sqrt(X.reduce((s, r) => s + (r[j] - mean[j]) ** 2, 0) / X.length) || 1);
  const Z = X.map((r) => r.map((v, j) => (v - mean[j]) / std[j]));
  const rand = rng(opts.seed);
  const H = opts.hidden;
  const init = (fan: number) => (rand() * 2 - 1) * Math.sqrt(6 / fan);
  const W1 = Array.from({ length: H }, () => Array.from({ length: d }, () => init(d + H)));
  const b1 = new Array(H).fill(0);
  const W2 = Array.from({ length: H || d }, () => init((H || d) + 1));
  let b2 = 0;
  const pos = y.filter((v) => v === 1).length;
  const pw = opts.posWeight ?? Math.max(1, (y.length - pos) / Math.max(1, pos));
  // Adam state
  const params = () => [...W1.flat(), ...b1, ...W2, b2];
  const m = new Array(params().length).fill(0);
  const v = new Array(params().length).fill(0);
  const b1a = 0.9, b2a = 0.999, eps = 1e-8;
  const order = Z.map((_, i) => i);
  let step = 0;
  for (let ep = 0; ep < opts.epochs; ep++) {
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const gW1 = W1.map((r) => r.map(() => 0)), gb1 = new Array(H).fill(0), gW2 = new Array(W2.length).fill(0);
    let gb2 = 0;
    for (const i of order) {
      const z = Z[i];
      const w = y[i] === 1 ? pw : 1;
      if (H === 0) {
        const p = sig(W2.reduce((s, wt, j) => s + wt * z[j], b2));
        const g = (p - y[i]) * w;
        for (let j = 0; j < d; j++) gW2[j] += g * z[j];
        gb2 += g;
      } else {
        const pre = W1.map((row, k) => row.reduce((s, wt, j) => s + wt * z[j], b1[k]));
        const h = pre.map((x) => Math.max(0, x));
        const p = sig(h.reduce((s, x, k) => s + x * W2[k], b2));
        const g = (p - y[i]) * w;
        for (let k = 0; k < H; k++) {
          gW2[k] += g * h[k];
          if (pre[k] > 0) { const gh = g * W2[k]; for (let j = 0; j < d; j++) gW1[k][j] += gh * z[j]; gb1[k] += gh; }
        }
        gb2 += g;
      }
    }
    const n = order.length;
    const grads = [...gW1.flat().map((g, idx) => g / n + opts.l2 * W1[Math.floor(idx / d)][idx % d]), ...gb1.map((g) => g / n), ...gW2.map((g, k) => g / n + opts.l2 * W2[k]), gb2 / n];
    step++;
    const cur = params();
    const next = cur.map((p, k) => {
      m[k] = b1a * m[k] + (1 - b1a) * grads[k];
      v[k] = b2a * v[k] + (1 - b2a) * grads[k] ** 2;
      const mh = m[k] / (1 - b1a ** step), vh = v[k] / (1 - b2a ** step);
      return p - (opts.lr * mh) / (Math.sqrt(vh) + eps);
    });
    let k = 0;
    for (let a = 0; a < H; a++) for (let j = 0; j < d; j++) W1[a][j] = next[k++];
    for (let a = 0; a < H; a++) b1[a] = next[k++];
    for (let a = 0; a < W2.length; a++) W2[a] = next[k++];
    b2 = next[k];
  }
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  return { mean: mean.map(r6), std: std.map(r6), W1: W1.map((r) => r.map(r6)), b1: b1.map(r6), W2: W2.map(r6), b2: r6(b2), hidden: H };
}

/** Area under the ROC curve, and average precision (area under precision-recall). */
export function metrics(scores: number[], y: number[]) {
  const idx = scores.map((s, i) => [s, y[i]] as const).sort((a, b) => b[0] - a[0]);
  const P = y.filter((v) => v === 1).length, N = y.length - P;
  let tp = 0, fp = 0, auc = 0, ap = 0;
  for (const [, l] of idx) {
    if (l === 1) { tp++; ap += tp / (tp + fp); } else { fp++; auc += tp; }
  }
  return { auc: P && N ? Math.round((auc / (P * N)) * 1000) / 1000 : null, ap: P ? Math.round((ap / P) * 1000) / 1000 : null, positives: P, n: y.length };
}

export function atThreshold(scores: number[], y: number[], t: number) {
  let tp = 0, fp = 0, fn = 0;
  scores.forEach((s, i) => { if (s >= t) { if (y[i]) tp++; else fp++; } else if (y[i]) fn++; });
  return { threshold: t, precision: tp + fp ? Math.round((tp / (tp + fp)) * 1000) / 1000 : null, recall: tp + fn ? Math.round((tp / (tp + fn)) * 1000) / 1000 : null, flagged: tp + fp };
}
