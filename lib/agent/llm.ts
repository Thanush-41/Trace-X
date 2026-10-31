/**
 * Minimal OpenAI chat client (JSON mode). The key is read from OPENAI_API_KEY at call time and never logged or stored.
 * Without a key every caller falls back to the deterministic agent.
 */
export const llmModel = () => process.env.OPENAI_MODEL || "gpt-4o-mini";
export const llmEnabled = () => !!process.env.OPENAI_API_KEY && process.env.TRACEX_LLM !== "off";

export type LlmResult<T> = { json: T; ms: number; tokens: number; model: string };

export async function chatJson<T>(system: string, user: string, opts: { maxTokens?: number; temperature?: number; timeoutMs?: number } = {}): Promise<LlmResult<T>> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 45000);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: llmModel(), temperature: opts.temperature ?? 0.1, max_tokens: opts.maxTokens ?? 1500,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { total_tokens?: number }; model?: string; error?: { message?: string } };
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${body.error?.message ?? "request failed"}`);
    const text = body.choices?.[0]?.message?.content ?? "{}";
    return { json: JSON.parse(text) as T, ms: Date.now() - started, tokens: body.usage?.total_tokens ?? 0, model: body.model ?? llmModel() };
  } finally {
    clearTimeout(timer);
  }
}
