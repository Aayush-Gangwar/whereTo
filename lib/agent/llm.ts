import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/**
 * Model providers, in priority order. Every provider whose API key is set is used; when one fails (quota, outage, bad
 * key) the request moves to the next, and only when all fail does the built-in planner take over.
 *
 *   Environment (set any subset)               Default model
 *   GOOGLE_GENERATIVE_AI_API_KEY | GEMINI_API_KEY   GEMINI_MODEL      gemini-3.5-flash
 *   GROQ_API_KEY                                    GROQ_MODEL        openai/gpt-oss-120b
 *   OPENROUTER_API_KEY                              OPENROUTER_MODEL  openrouter/free
 *   CEREBRAS_API_KEY                                CEREBRAS_MODEL    gpt-oss-120b
 *   MISTRAL_API_KEY                                 MISTRAL_MODEL     mistral-small-latest
 *   ZAI_API_KEY                                     ZAI_MODEL         glm-4.5-flash   (ZAI_THINKING=enabled turns its reasoning on)
 *   LLM_PROVIDERS=google,groq,openrouter,cerebras,mistral,zai   optional: priority order (default shown)
 */

export type ProviderId = "google" | "groq" | "openrouter" | "cerebras" | "mistral" | "zai";

export type LlmChoice = {
  id: ProviderId;
  modelId: string;
  /** Shown in the trace, for example "gemini-3.5-flash" or "groq/openai/gpt-oss-120b". */
  label: string;
  model: LanguageModel;
  providerOptions?: Record<string, any>;
};

const DEFAULT_ORDER: ProviderId[] = ["google", "groq", "openrouter", "cerebras", "mistral", "zai"];

const SPEC: Record<ProviderId, { keys: string[]; modelEnv: string; defaultModel: string; baseURL?: string }> = {
  google: { keys: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"], modelEnv: "GEMINI_MODEL", defaultModel: "gemini-3.5-flash" },
  groq: { keys: ["GROQ_API_KEY"], modelEnv: "GROQ_MODEL", defaultModel: "openai/gpt-oss-120b", baseURL: "https://api.groq.com/openai/v1" },
  openrouter: { keys: ["OPENROUTER_API_KEY"], modelEnv: "OPENROUTER_MODEL", defaultModel: "openrouter/free", baseURL: "https://openrouter.ai/api/v1" },
  cerebras: { keys: ["CEREBRAS_API_KEY"], modelEnv: "CEREBRAS_MODEL", defaultModel: "gpt-oss-120b", baseURL: "https://api.cerebras.ai/v1" },
  mistral: { keys: ["MISTRAL_API_KEY"], modelEnv: "MISTRAL_MODEL", defaultModel: "mistral-small-latest", baseURL: "https://api.mistral.ai/v1" },
  zai: { keys: ["ZAI_API_KEY"], modelEnv: "ZAI_MODEL", defaultModel: "glm-4.5-flash", baseURL: "https://api.z.ai/api/paas/v4" },
};

type Env = Record<string, string | undefined>;

/**
 * Reasoning models (gpt-oss) return their thinking, and the SDK echoes it back on the next step as `reasoning_content`
 * on assistant messages. Groq and others reject that field with a 400. The thinking is not needed to continue, so it is
 * removed from the outgoing request body only; traces and the UI are unaffected.
 */
export function stripReasoning(body: unknown): unknown {
  const b = body as { messages?: any[] } | null;
  if (!b || !Array.isArray(b.messages)) return body;
  return {
    ...b,
    messages: b.messages.map((m) => {
      if (!m || m.role !== "assistant") return m;
      const { reasoning_content: _a, reasoning: _b, ...rest } = m;
      return rest;
    }),
  };
}

function withoutReasoningEcho(base: typeof fetch = (...a) => fetch(...a)): typeof fetch {
  return (async (url: any, init?: RequestInit) => {
    if (typeof init?.body === "string") {
      try { init = { ...init, body: JSON.stringify(stripReasoning(JSON.parse(init.body))) }; } catch { /* send as is */ }
    }
    return base(url, init);
  }) as typeof fetch;
}

const keyFor = (id: ProviderId, env: Env) => SPEC[id].keys.map((k) => env[k]?.trim()).find(Boolean);

/** Providers in priority order that have a key. An unknown name in LLM_PROVIDERS is ignored. */
export function providerOrder(env: Env = process.env): ProviderId[] {
  const asked = (env.LLM_PROVIDERS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) as ProviderId[];
  const order = asked.length ? asked.filter((p) => p in SPEC) : DEFAULT_ORDER;
  return [...new Set(order)].filter((p) => keyFor(p, env));
}

export function buildChoice(id: ProviderId, env: Env = process.env): LlmChoice {
  const spec = SPEC[id];
  const apiKey = keyFor(id, env)!;
  const modelId = env[spec.modelEnv]?.trim() || spec.defaultModel;
  if (id === "google") {
    return {
      id,
      modelId,
      label: modelId,
      model: createGoogleGenerativeAI({ apiKey })(modelId),
      providerOptions: { google: { thinkingConfig: { thinkingLevel: env.GEMINI_THINKING ?? "low" } } },
    };
  }
  const provider = createOpenAICompatible({ name: id, baseURL: spec.baseURL!, apiKey, fetch: withoutReasoningEcho() });
  // GLM models think by default, and that thinking would eat the output cap; the plan needs tool calls, not essays.
  // Reasoning models can spend the whole output cap thinking and answer nothing, so keep their thinking short.
  const providerOptions =
    id === "zai" ? { zai: { thinking: { type: env.ZAI_THINKING === "enabled" ? "enabled" : "disabled" } } }
    : id === "openrouter" ? { openrouter: { reasoning: { effort: "low" } } }
    : id === "groq" && /gpt-oss/i.test(modelId) ? { groq: { reasoningEffort: "low" } }
    : undefined;
  return { id, modelId, label: `${id}/${modelId}`, model: provider.chatModel(modelId), providerOptions };
}

// ------------------------------------------------------------------ health: do not keep calling a provider that just failed

export type FailureKind = "quota" | "auth" | "transient" | "other";

/** Order matters: a 429 is a quota problem even though it is also "a 4xx/5xx". */
export function classifyError(message: string): FailureKind {
  if (/quota|\b429\b|rate.?limit|RESOURCE_EXHAUSTED|too many requests|exceeded your/i.test(message)) return "quota";
  if (/\b40[123]\b|payment required|billing|subscription|api key|invalid.*key|unauthori[sz]ed|permission.?denied|PERMISSION_DENIED|forbidden/i.test(message)) return "auth";
  if (/\b5\d\d\b|overload|unavailable|time.?out|timed out|aborted|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|network|socket/i.test(message)) return "transient";
  return "other";
}

/** How long to skip a provider after a failure of this kind (per server instance). */
export const COOLDOWN_MS: Record<FailureKind, number> = {
  quota: 30 * 60_000, // daily and per-minute quotas do not recover within a request
  auth: 60 * 60_000, // a wrong key stays wrong
  transient: 60_000,
  other: 30_000,
};

const coolingUntil = new Map<ProviderId, number>();

export function markFailed(id: ProviderId, kind: FailureKind, now = Date.now()) {
  coolingUntil.set(id, now + COOLDOWN_MS[kind]);
}
export const isCooling = (id: ProviderId, now = Date.now()) => (coolingUntil.get(id) ?? 0) > now;
export const resetHealth = () => coolingUntil.clear();

/** Providers to try for this request, best first, skipping any that failed recently. */
export function usableChoices(env: Env = process.env, now = Date.now()): LlmChoice[] {
  return providerOrder(env).filter((id) => !isCooling(id, now)).map((id) => buildChoice(id, env));
}
