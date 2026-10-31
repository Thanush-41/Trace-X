import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { EvaluationClient } from "@/components/evaluation-client";
import { AgentEvaluationView } from "@/components/agent-evaluation";
import { ModelCard } from "@/components/model-card";
import { agentEvaluation } from "@/lib/agent/evaluation";
import { PageHeader } from "@/components/ui";
import { listSamples } from "@/lib/ingest/samples";
import { workspaceIdentity } from "@/lib/queries";

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
  const [samples, ws] = await Promise.all([listSamples(), workspaceIdentity()]);
  const agent = await agentEvaluation();
  return (
    <div className="space-y-8">
      <EvaluationClient seeds={samples.map((s) => s.seed)} loadedSeeds={ws.seeds} />
      <ModelCard />
      <AgentEvaluationView data={agent} />
    </div>
  );
}
