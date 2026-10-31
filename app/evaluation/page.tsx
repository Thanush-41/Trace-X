import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { EvaluationClient } from "@/components/evaluation-client";
import { PageHeader } from "@/components/ui";
import { listSamples } from "@/lib/ingest/samples";

export const metadata: Metadata = { title: "Evaluation" };

export default function EvaluationPage() {
  return (
    <>
      <PageHeader
        title="Detection evaluation"
        description="Scores the latest detection run against a ground-truth answer key: planted fraud that must be caught, and legitimate lookalikes that must stay Low. Results are measured on synthetic data, not validated real-world accuracy."
      />
      <Suspense fallback={null}>
        <Loader />
      </Suspense>
    </>
  );
}

async function Loader() {
  await connection();
  const samples = await listSamples();
  return <EvaluationClient seeds={samples.map((s) => s.seed)} />;
}
