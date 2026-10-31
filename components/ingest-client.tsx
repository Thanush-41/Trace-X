"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import type { IngestFailure, IngestResult } from "@/lib/ingest/load";
import { buttonClass, cx, inputClass } from "@/components/ui";
import { RunDetectionButton } from "@/components/run-detection";

type Result = IngestResult | IngestFailure;
const TYPES = [
  ["auto", "Detect from columns"],
  ["customers", "Customers"],
  ["accounts", "Accounts"],
  ["transactions", "Transactions"],
  ["login_events", "Device & login events"],
  ["loan_applications", "Loan applications"],
  ["insurance_claims", "Insurance claims"],
] as const;

export function IngestClient({ seeds }: { seeds: number[] }) {
  const router = useRouter();
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seed, setSeed] = useState(String(seeds[0] ?? 1));
  const [type, setType] = useState("auto");
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [, startTransition] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);

  async function send(label: string, request: () => Promise<Response>) {
    setBusy(label);
    setError(null);
    try {
      const res = await request();
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Request failed");
      setResults(body.results);
      startTransition(() => router.refresh());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const loadSample = () =>
    send("sample", () => fetch("/api/samples/load", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seed: Number(seed) }) }));

  const upload = () => {
    const form = new FormData();
    files.forEach((f) => form.append("file", f));
    form.append("type", type);
    return send("upload", () => fetch("/api/ingest", { method: "POST", body: form })).then(() => {
      setFiles([]);
      if (fileInput.current) fileInput.current.value = "";
    });
  };

  const accepted = results.reduce((s, r) => s + (r.ok ? r.accepted : 0), 0);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-line bg-surface p-4">
          <h2 className="text-sm font-semibold">Select a bundled dataset</h2>
          <p className="mt-1 text-sm text-ink-2">
            Linked customers, accounts, transactions, logins and loan applications. Each seed is a different population with the same planted scenarios.
          </p>
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <label className="text-sm">
              <span className="mb-1 block text-xs text-ink-2">Sample</span>
              <select value={seed} onChange={(e) => setSeed(e.target.value)} className={cx(inputClass, "w-40")}>
                {seeds.map((s) => <option key={s} value={s}>Seed {s}</option>)}
              </select>
            </label>
            <button type="button" onClick={loadSample} disabled={!!busy || seeds.length === 0} className={buttonClass("primary")}>
              {busy === "sample" ? "Loading…" : "Load sample"}
            </button>
          </div>
          <div className="mt-4 border-t border-line pt-3 text-xs text-ink-2">
            Demo files for seed {seed}:{" "}
            {[
              ["transactions_with_errors.csv", "file with errors"],
              ["logins_alt_headers.csv", "other system's headers"],
              ["tracex.xlsx", "Excel workbook"],
              ["tracex.json", "JSON"],
            ].map(([f, label], i) => (
              <span key={f}>
                {i > 0 && " · "}
                <a className="text-accent-ink hover:underline" href={`/api/samples?seed=${seed}&file=${f}`}>{label}</a>
              </span>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-line bg-surface p-4">
          <h2 className="text-sm font-semibold">Upload files</h2>
          <p className="mt-1 text-sm text-ink-2">CSV, Excel (one sheet per dataset) or JSON. Column names from other systems are mapped automatically.</p>
          <label
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); setFiles([...e.dataTransfer.files]); }}
            className={cx("mt-3 flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-4 py-5 text-center text-sm transition-colors",
              dragging ? "border-accent bg-accent-wash" : "border-line-strong hover:bg-surface-2")}
          >
            <input ref={fileInput} type="file" multiple accept=".csv,.txt,.xlsx,.xls,.json" className="sr-only" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
            {files.length ? <span className="font-medium">{files.map((f) => f.name).join(", ")}</span> : <span className="text-ink-2">Drop files here or <span className="text-accent-ink underline">browse</span></span>}
          </label>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="text-sm">
              <span className="mb-1 block text-xs text-ink-2">Dataset type</span>
              <select value={type} onChange={(e) => setType(e.target.value)} className={cx(inputClass, "w-56")}>
                {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <button type="button" onClick={upload} disabled={!!busy || files.length === 0} className={buttonClass("primary")}>
              {busy === "upload" ? "Importing…" : `Import ${files.length || ""} file${files.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </section>
      </div>

      {error && <p role="alert" className="rounded-md border border-risk-high/40 bg-surface px-3 py-2 text-sm text-risk-high">{error}</p>}

      {results.length > 0 && (
        <section aria-live="polite" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">Import results</h2>
            {accepted > 0 && <RunDetectionButton />}
          </div>
          {results.map((r, i) => <ResultCard key={i} r={r} />)}
        </section>
      )}
    </div>
  );
}

function ResultCard({ r }: { r: Result }) {
  const [showMap, setShowMap] = useState(false);
  if (!r.ok) {
    return (
      <div className="rounded-lg border border-risk-high/40 bg-surface p-4 text-sm">
        <div className="font-medium">{r.filename}{r.sheet ? ` › ${r.sheet}` : ""}</div>
        <div className="mt-1 text-risk-high">Not imported: {r.error}</div>
      </div>
    );
  }
  const counts: [string, number, string][] = [
    ["rows", r.total, "text-ink"],
    ["accepted", r.accepted, "text-good-ink"],
    ["rejected", r.rejected, r.rejected ? "text-risk-high" : "text-ink-3"],
    ["duplicates", r.duplicates, r.duplicates ? "text-ink" : "text-ink-3"],
    ["with warnings", r.warnings, r.warnings ? "text-ink" : "text-ink-3"],
  ];
  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <div className="truncate font-medium">{r.filename}{r.sheet ? ` › ${r.sheet}` : ""}</div>
          <div className="text-xs text-ink-2">Detected as <span className="font-medium text-ink">{r.dataset_label}</span> · {r.format.toUpperCase()} · batch <span className="font-mono">{r.batch_id}</span></div>
        </div>
        <dl className="flex flex-wrap gap-4 text-sm">
          {counts.map(([label, n, tone]) => (
            <div key={label} className="text-right">
              <dt className="text-xs text-ink-3">{label}</dt>
              <dd className={cx("font-semibold tabular", tone)}>{n}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="space-y-3 px-4 py-3 text-sm">
        {r.notices.map((n, i) => <p key={i} className="rounded bg-surface-2 px-2 py-1 text-xs">⚠ {n}</p>)}
        <button type="button" onClick={() => setShowMap(!showMap)} className="text-xs text-accent-ink hover:underline" aria-expanded={showMap}>
          {showMap ? "Hide" : "Show"} column mapping ({Object.keys(r.header_map).length} mapped{r.unmapped.length ? `, ${r.unmapped.length} ignored` : ""})
        </button>
        {showMap && (
          <div className="flex flex-wrap gap-1.5 text-xs">
            {Object.entries(r.header_map).map(([src, field]) => (
              <span key={src} className="rounded border border-line px-1.5 py-0.5"><span className="text-ink-2">{src}</span> → <span className="font-mono">{field}</span></span>
            ))}
            {r.unmapped.map((h) => <span key={h} className="rounded border border-dashed border-line-strong px-1.5 py-0.5 text-ink-3">{h} (not used)</span>)}
          </div>
        )}
        {r.issues.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-ink-3">
                <tr><th className="py-1 pr-3 font-medium">Row</th><th className="py-1 pr-3 font-medium">Type</th><th className="py-1 pr-3 font-medium">Field</th><th className="py-1 font-medium">Problem</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {r.issues.slice(0, 12).map((x, i) => (
                  <tr key={i}>
                    <td className="py-1 pr-3 tabular">{x.source_row}</td>
                    <td className={cx("py-1 pr-3", x.severity === "error" ? "text-risk-high" : "text-ink-2")}>{x.severity === "error" ? "Rejected" : x.severity === "duplicate" ? "Duplicate" : "Warning"}</td>
                    <td className="py-1 pr-3 font-mono">{x.field ?? "—"}</td>
                    <td className="py-1">{x.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 text-xs text-ink-2">
              {r.issues.length > 12 || r.issues_truncated ? `Showing 12 of ${r.issues_truncated ? "200+" : r.issues.length} issues. ` : ""}
              <Link href={`/api/batches/${r.batch_id}/errors`} className="text-accent-ink hover:underline" prefetch={false}>Download full issue report (CSV)</Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
