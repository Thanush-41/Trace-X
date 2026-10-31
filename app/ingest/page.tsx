import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { IngestClient } from "@/components/ingest-client";
import { ResetButton } from "@/components/reset-button";
import { Card, PageHeader, Pill, fmtTime } from "@/components/ui";
import { listBatches } from "@/lib/ingest/batches";
import { DATASET_LABELS, type DatasetType } from "@/lib/ingest/fields";
import { listSamples } from "@/lib/ingest/samples";

export const metadata: Metadata = { title: "Data ingestion" };

export default function IngestPage() {
  return (
    <>
      <PageHeader
        title="Data ingestion"
        description="Bring in records from core banking, lending and digital channels. Every row is validated; rejected rows and warnings are listed with the reason, never dropped silently."
        actions={<ResetButton />}
      />
      <div className="space-y-6">
        <Suspense fallback={<p className="text-sm text-ink-3">Loading…</p>}>
          <Uploader />
        </Suspense>
        <Suspense fallback={null}>
          <History />
        </Suspense>
      </div>
    </>
  );
}

async function Uploader() {
  await connection();
  const samples = await listSamples();
  return <IngestClient seeds={samples.map((s) => s.seed)} />;
}

async function History() {
  await connection();
  const batches = await listBatches(50);
  return (
    <Card title="Import history" padded={false}>
      {batches.length === 0 ? (
        <p className="p-4 text-sm text-ink-3">Nothing imported yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-line text-xs text-ink-3">
              <tr>
                {["Imported (UTC)", "File", "Dataset", "Rows", "Accepted", "Rejected", "Duplicates", "Warnings", ""].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {batches.map((b) => {
                const meta = JSON.parse(b.meta_json) as { sheet: string | null };
                return (
                  <tr key={b.batch_id}>
                    <td className="px-4 py-2 text-xs text-ink-2 tabular">{fmtTime(b.created_at)}</td>
                    <td className="max-w-[16rem] truncate px-4 py-2">{b.filename}{meta.sheet ? ` › ${meta.sheet}` : ""}</td>
                    <td className="px-4 py-2"><Pill>{DATASET_LABELS[b.dataset_type as DatasetType] ?? b.dataset_type}</Pill></td>
                    <td className="px-4 py-2 tabular">{b.total_rows}</td>
                    <td className="px-4 py-2 tabular text-good-ink">{b.accepted}</td>
                    <td className={`px-4 py-2 tabular ${b.rejected ? "font-medium text-risk-high" : "text-ink-3"}`}>{b.rejected}</td>
                    <td className="px-4 py-2 tabular text-ink-2">{b.duplicates}</td>
                    <td className="px-4 py-2 tabular text-ink-2">{b.warnings}</td>
                    <td className="px-4 py-2 text-right">
                      {b.rejected + b.duplicates + b.warnings > 0 && (
                        <a href={`/api/batches/${b.batch_id}/errors`} className="text-xs text-accent-ink hover:underline">Issue report</a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
