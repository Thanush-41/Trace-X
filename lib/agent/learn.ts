import { all, getDb } from "@/lib/db/client";
import { chatJson, llmEnabled } from "./llm";
import type { Assessment } from "./investigate";

/**
 * Feedback-learning agent. It compares the agent's assessment with the analyst's verdict and writes one short,
 * general lesson ("when X, prefer Y because Z"). Lessons are retrieved into later investigations of cases with the
 * same detector signature (in-context learning). Only training-split feedback creates lessons; held-out cases never
 * teach the agent, so they stay an honest test of it.
 */
export async function learnLesson(input: { feedback_id: number; assessment: Assessment; outcome: string; human_category: string | null; reasoning: string; split: string }) {
  if (input.split !== "train") return null;
  const a = input.assessment;
  const agree = input.outcome === "accepted";
  let lesson: string;
  let source = "template";
  if (llmEnabled()) {
    try {
      const r = await chatJson<{ lesson: string }>(
        "You coach a fraud-investigation agent. Compare its conclusion with the human analyst's verdict and write ONE general lesson (max 35 words) that would help on similar future cases. No customer IDs, account numbers or names. Name the detector combination and the concrete evidence pattern (e.g. failed-login burst then new device then payee added; shared payout account across new profiles; name-check mismatch). If the human disagreed, say what the agent over- or under-weighted. Avoid generic advice such as 'always investigate'. Reply as JSON: {\"lesson\": string}.",
        JSON.stringify({ detectors: a.learning.signature, agent_category: a.predicted_category, agent_likely_benign: a.likely_benign, agent_top_hypotheses: a.hypotheses.slice(0, 3).map((h) => ({ category: h.category, confidence: h.confidence, claim: h.supports[0]?.text?.slice(0, 200) })), human_outcome: input.outcome, human_category: input.human_category, human_reasoning: input.reasoning }),
        { maxTokens: 150 },
      );
      lesson = String(r.json.lesson ?? "").replace(/\b(?:CUS|ACC|TXN|LGN|APP|CLM|EXT)[0-9A-F]{4,}\b/g, "[id]").slice(0, 300);
      source = "llm";
    } catch {
      lesson = "";
    }
  } else lesson = "";
  if (!lesson) {
    lesson = agree
      ? `For ${a.learning.signature} cases, the ${a.predicted_category} conclusion was confirmed by an analyst.`
      : input.outcome === "corrected"
        ? `For ${a.learning.signature} cases, analysts classified a case the agent called ${a.predicted_category} as ${input.human_category}: ${input.reasoning.slice(0, 120)}`
        : `For ${a.learning.signature} cases, an analyst rejected the ${a.predicted_category} conclusion as not fraud: ${input.reasoning.slice(0, 120)}`;
  }
  await (await getDb()).execute({
    sql: "INSERT INTO agent_lessons (feedback_id, signature, predicted_category, human_category, lesson, source, created_at) VALUES (?,?,?,?,?,?,?)",
    args: [input.feedback_id, a.learning.signature, a.predicted_category, input.human_category, lesson, source, new Date().toISOString()],
  });
  return lesson;
}

/** Lessons for a signature: corrections first (they carry the most information), then confirmations; most recent first. */
export async function lessonsFor(signature: string, limit = 6): Promise<string[]> {
  const rows = await all<{ lesson: string }>(
    `SELECT lesson FROM agent_lessons WHERE signature = ? OR ? LIKE '%' || signature || '%'
     ORDER BY (human_category IS NOT NULL AND human_category != predicted_category) DESC, id DESC LIMIT ?`, [signature, signature, limit]);
  return [...new Set(rows.map((r) => r.lesson))];
}

export async function listLessons(limit = 30) {
  return all<{ id: number; feedback_id: number; signature: string; predicted_category: string; human_category: string | null; lesson: string; source: string; created_at: string }>("SELECT * FROM agent_lessons ORDER BY id DESC LIMIT ?", [limit]);
}
