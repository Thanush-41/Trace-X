export function quantile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(values: number[]): number {
  return quantile(values, 0.5);
}

/** Median absolute deviation. */
export function mad(values: number[]): number {
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

/**
 * Robust z-score using median and MAD (scaled to match a standard deviation for normal data).
 * Falls back to a small fraction of the median when MAD is 0 (identical history), so a
 * genuinely different amount still stands out instead of dividing by zero.
 */
export function robustZ(value: number, history: number[]): number {
  const m = median(history);
  let scale = 1.4826 * mad(history);
  if (scale === 0) scale = Math.max(Math.abs(m) * 0.1, 1);
  return (value - m) / scale;
}
