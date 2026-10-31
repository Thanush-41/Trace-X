"use client";

import { useMemo, useState } from "react";

type Row = { day: string; level: string; n: number };
const LEVELS = ["High", "Medium", "Low"] as const;
const FILL: Record<string, string> = { High: "var(--risk-high)", Medium: "var(--risk-medium)", Low: "var(--risk-low)" };

/** Stacked daily alert counts by risk level, from the latest detection run. */
export function AlertsOverTime({ rows }: { rows: Row[] }) {
  const days = useMemo(() => {
    if (rows.length === 0) return [];
    const byDay = new Map<string, Record<string, number>>();
    for (const r of rows) byDay.set(r.day, { ...(byDay.get(r.day) ?? {}), [r.level]: r.n });
    const first = new Date(rows[0].day + "T00:00:00Z");
    const last = new Date(rows[rows.length - 1].day + "T00:00:00Z");
    const out: { day: string; counts: Record<string, number>; total: number }[] = [];
    for (let d = first; d <= last; d = new Date(d.getTime() + 86400000)) {
      const key = d.toISOString().slice(0, 10);
      const counts = byDay.get(key) ?? {};
      out.push({ day: key, counts, total: LEVELS.reduce((s, l) => s + (counts[l] ?? 0), 0) });
    }
    return out;
  }, [rows]);
  const [hover, setHover] = useState<number | null>(null);
  if (days.length === 0) return <p className="text-sm text-ink-3">Run detection to see alerts over time.</p>;

  const W = 720;
  const H = 180;
  const pad = { l: 28, r: 8, t: 8, b: 22 };
  const max = Math.max(1, ...days.map((d) => d.total));
  const step = (W - pad.l - pad.r) / days.length;
  const bw = Math.max(2, step - 2);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, Math.ceil(max / 2), max];
  const labelEvery = Math.ceil(days.length / 6);
  const h = hover !== null ? days[hover] : null;

  return (
    <div className="relative">
      <div className="mb-2 flex flex-wrap gap-3 text-xs text-ink-2" aria-hidden>
        {LEVELS.map((l) => (
          <span key={l} className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: FILL[l] }} />{l}</span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Alerts per day by risk level over ${days.length} days; peak ${max} on one day`} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill="var(--text-3)">{t}</text>
          </g>
        ))}
        {days.map((d, i) => {
          let acc = 0;
          const x = pad.l + i * step + (step - bw) / 2;
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)}>
              <rect x={pad.l + i * step} y={pad.t} width={step} height={H - pad.t - pad.b} fill="transparent" />
              {LEVELS.map((l) => {
                const v = d.counts[l] ?? 0;
                if (!v) return null;
                const top = y(acc + v);
                const height = y(acc) - top;
                acc += v;
                return <rect key={l} x={x} y={top + 1} width={bw} height={Math.max(1, height - 1)} rx={1.5} fill={FILL[l]} opacity={hover === null || hover === i ? 1 : 0.45} />;
              })}
              {i % labelEvery === 0 && <text x={x + bw / 2} y={H - 6} textAnchor="middle" fontSize={10} fill="var(--text-3)">{d.day.slice(5)}</text>}
            </g>
          );
        })}
      </svg>
      {h && (
        <div className="pointer-events-none absolute right-2 top-0 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs shadow-card" role="status">
          <div className="font-medium">{h.day}</div>
          {LEVELS.map((l) => <div key={l} className="flex justify-between gap-4 tabular"><span className="text-ink-2">{l}</span><span>{h.counts[l] ?? 0}</span></div>)}
        </div>
      )}
    </div>
  );
}
