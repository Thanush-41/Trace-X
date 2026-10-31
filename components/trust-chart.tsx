import type { CategoryTrust } from "@/lib/agent/trust";

const COLORS = ["#2563eb", "#7c3aed", "#be185d", "#15803d", "#c2410c", "#0e7490", "#b45309"];

/** Trust over successive validated decisions, one line per category, computed from stored feedback. Red rings mark drops. */
export function TrustChart({ categories }: { categories: CategoryTrust[] }) {
  const W = 760, H = 280, L = 40, R = 16, T = 12, B = 34;
  const max = Math.max(5, ...categories.map((c) => c.trend.length));
  const x = (i: number) => L + ((W - L - R) * i) / max;
  const y = (v: number) => T + (H - T - B) * (1 - v);
  const live = categories.map((c, i) => ({ c, color: COLORS[i % COLORS.length] })).filter((s) => s.c.trend.length > 0);
  if (live.length === 0) return <p className="text-sm text-ink-3">No validated decisions yet, so every category sits at zero trust. Run the agent on a case and review its recommendation to start the curve.</p>;
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Agent trust per category over validated decisions" className="w-full">
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth="1" /><text x={L - 6} y={y(v) + 3} textAnchor="end" fontSize="10" fill="var(--ink-3)">{v.toFixed(2)}</text></g>
        ))}
        <text x={L + (W - L - R) / 2} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--ink-3)">validated training decisions in the category</text>
        {[0.7, 0.45].map((t) => <line key={t} x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--ink-3)" strokeDasharray="3 4" strokeWidth="0.8" />)}
        <text x={W - R} y={y(0.7) - 3} textAnchor="end" fontSize="9" fill="var(--ink-3)">L3 trust floor</text>
        <text x={W - R} y={y(0.45) - 3} textAnchor="end" fontSize="9" fill="var(--ink-3)">L2 trust floor</text>
        {live.map(({ c, color }) => {
          const pts = [[0, 0], ...c.trend.map((p, i) => [i + 1, p.trust])] as [number, number][];
          return (
            <g key={c.category}>
              <polyline fill="none" stroke={color} strokeWidth="2" points={pts.map(([i, v]) => `${x(i)},${y(v)}`).join(" ")} />
              {c.trend.map((p, i) => (
                <circle key={p.feedback_id} cx={x(i + 1)} cy={y(p.trust)} r={p.delta < 0 ? 5 : 3} fill={color} stroke={p.delta < 0 ? "var(--risk-high)" : "var(--surface)"} strokeWidth={p.delta < 0 ? 2 : 1.5}>
                  <title>{`${c.category}: ${p.why}. Trust ${p.trust.toFixed(3)} (${p.delta >= 0 ? "+" : ""}${p.delta.toFixed(3)}), ${p.n} decisions`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
        {live.map(({ c, color }) => <span key={c.category} className="flex items-center gap-1.5"><span aria-hidden className="h-2 w-4 rounded-sm" style={{ background: color }} />{c.category} ({c.trend.length})</span>)}
        <span className="flex items-center gap-1.5"><span aria-hidden className="h-3 w-3 rounded-full border-2 border-risk-high" />trust fell after a wrong recommendation</span>
      </figcaption>
    </figure>
  );
}
