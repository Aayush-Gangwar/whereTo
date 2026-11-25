import { beforeEach, describe, expect, it } from "vitest";
import { stripReasoning, buildChoice, classifyError, COOLDOWN_MS, isCooling, markFailed, providerOrder, resetHealth, usableChoices } from "../lib/agent/llm";

describe("which providers are used, and in what order", () => {
  it("uses only providers that have a key, in the default priority order", () => {
    expect(providerOrder({ GROQ_API_KEY: "g", GEMINI_API_KEY: "k", CEREBRAS_API_KEY: "c" })).toEqual(["google", "groq", "cerebras"]);
    expect(providerOrder({ OPENROUTER_API_KEY: "o" })).toEqual(["openrouter"]);
    expect(providerOrder({})).toEqual([]);
  });

  it("Mistral is last by default, and a missing Cerebras key is simply skipped", () => {
    expect(providerOrder({ GEMINI_API_KEY: "k", GROQ_API_KEY: "g", MISTRAL_API_KEY: "m" })).toEqual(["google", "groq", "mistral"]);
    expect(providerOrder({ MISTRAL_API_KEY: "m", OPENROUTER_API_KEY: "o" })).toEqual(["openrouter", "mistral"]);
  });

  it("accepts either Google key name", () => {
    expect(providerOrder({ GOOGLE_GENERATIVE_AI_API_KEY: "a" })).toEqual(["google"]);
    expect(providerOrder({ GEMINI_API_KEY: "b" })).toEqual(["google"]);
  });

  it("ignores blank or whitespace-only keys", () => {
    expect(providerOrder({ GROQ_API_KEY: "", GEMINI_API_KEY: "   ", OPENROUTER_API_KEY: "o" })).toEqual(["openrouter"]);
  });

  it("LLM_PROVIDERS overrides the priority, drops unknown names and duplicates, and still needs a key", () => {
    const env = { GROQ_API_KEY: "g", GEMINI_API_KEY: "k", OPENROUTER_API_KEY: "o", LLM_PROVIDERS: " Groq , nonsense, openrouter, groq, cerebras " };
    expect(providerOrder(env)).toEqual(["groq", "openrouter"]); // cerebras has no key
  });

  it("an empty LLM_PROVIDERS falls back to the default order", () => {
    expect(providerOrder({ GROQ_API_KEY: "g", GEMINI_API_KEY: "k", LLM_PROVIDERS: "" })).toEqual(["google", "groq"]);
  });
});

describe("building a provider's model", () => {
  it("uses sensible default models and labels them for the trace", () => {
    expect(buildChoice("google", { GEMINI_API_KEY: "k" })).toMatchObject({ id: "google", modelId: "gemini-3.5-flash", label: "gemini-3.5-flash" });
    expect(buildChoice("groq", { GROQ_API_KEY: "g" })).toMatchObject({ modelId: "openai/gpt-oss-120b", label: "groq/openai/gpt-oss-120b" });
    expect(buildChoice("openrouter", { OPENROUTER_API_KEY: "o" })).toMatchObject({ modelId: "openrouter/free", label: "openrouter/openrouter/free" });
    expect(buildChoice("cerebras", { CEREBRAS_API_KEY: "c" })).toMatchObject({ modelId: "gpt-oss-120b", label: "cerebras/gpt-oss-120b" });
    expect(buildChoice("mistral", { MISTRAL_API_KEY: "m" })).toMatchObject({ modelId: "mistral-small-latest", label: "mistral/mistral-small-latest" });
    expect(buildChoice("zai", { ZAI_API_KEY: "z" })).toMatchObject({ modelId: "glm-4.5-flash", label: "zai/glm-4.5-flash" });
  });

  it("each model id can be overridden from the environment", () => {
    expect(buildChoice("google", { GEMINI_API_KEY: "k", GEMINI_MODEL: "gemini-3.5-flash-lite" }).modelId).toBe("gemini-3.5-flash-lite");
    expect(buildChoice("groq", { GROQ_API_KEY: "g", GROQ_MODEL: "llama-x" }).modelId).toBe("llama-x");
    expect(buildChoice("openrouter", { OPENROUTER_API_KEY: "o", OPENROUTER_MODEL: "vendor/model:free" }).label).toBe("openrouter/vendor/model:free");
  });

  it("Z.ai is last by default and runs with thinking off unless asked", () => {
    expect(providerOrder({ ZAI_API_KEY: "z", GROQ_API_KEY: "g", MISTRAL_API_KEY: "m" })).toEqual(["groq", "mistral", "zai"]);
    expect(buildChoice("zai", { ZAI_API_KEY: "z" }).providerOptions).toEqual({ zai: { thinking: { type: "disabled" } } });
    expect(buildChoice("zai", { ZAI_API_KEY: "z", ZAI_THINKING: "enabled" }).providerOptions).toEqual({ zai: { thinking: { type: "enabled" } } });
  });

  it("only Google gets the thinking setting; the reasoning models get short thinking", () => {
    expect(buildChoice("google", { GEMINI_API_KEY: "k" }).providerOptions).toEqual({ google: { thinkingConfig: { thinkingLevel: "low" } } });
    expect(buildChoice("google", { GEMINI_API_KEY: "k", GEMINI_THINKING: "minimal" }).providerOptions).toEqual({ google: { thinkingConfig: { thinkingLevel: "minimal" } } });
    expect(buildChoice("groq", { GROQ_API_KEY: "g" }).providerOptions).toEqual({ groq: { reasoningEffort: "low" } });
    expect(buildChoice("groq", { GROQ_API_KEY: "g", GROQ_MODEL: "llama-3.3-70b-versatile" }).providerOptions).toBeUndefined(); // not a reasoning model
    expect(buildChoice("openrouter", { OPENROUTER_API_KEY: "o" }).providerOptions).toEqual({ openrouter: { reasoning: { effort: "low" } } });
    expect(buildChoice("cerebras", { CEREBRAS_API_KEY: "c" }).providerOptions).toBeUndefined();
  });

  it("produces real model objects the SDK can call", () => {
    const m: any = buildChoice("groq", { GROQ_API_KEY: "g" }).model;
    expect(m.specificationVersion).toBe("v4");
    expect(m.modelId).toBe("openai/gpt-oss-120b");
    expect((buildChoice("google", { GEMINI_API_KEY: "k" }).model as any).modelId).toBe("gemini-3.5-flash");
  });
});

describe("classifyError", () => {
  it.each([
    ["You exceeded your current quota, please check your plan and billing details", "quota"],
    ["Request failed with status 429", "quota"],
    ["Rate limit reached for model in organization", "quota"],
    ["RESOURCE_EXHAUSTED", "quota"],
    ["Too many requests", "quota"],
    ["401 Unauthorized", "auth"],
    ["API key not valid. Please pass a valid API key.", "auth"],
    ["403 Forbidden", "auth"],
    ["Payment Required", "auth"],
    ["You need a subscription to access this API. billing_no_api_budget_configured", "auth"],
    ["PERMISSION_DENIED", "auth"],
    ["503 Service Unavailable", "transient"],
    ["The model is overloaded. Please try again later.", "transient"],
    ["fetch failed", "transient"],
    ["ETIMEDOUT", "transient"],
    ["something unexpected happened", "other"],
  ])("%j is %s", (msg, kind) => expect(classifyError(msg)).toBe(kind));

  it("a 429 inside a longer message is still a quota problem, not a generic failure", () => {
    expect(classifyError("Failed after 3 attempts. Last error: 429 Too Many Requests (503 upstream)")).toBe("quota");
  });
});

describe("cooldown: do not keep calling a provider that just failed", () => {
  beforeEach(() => resetHealth());
  const env = { GEMINI_API_KEY: "k", GROQ_API_KEY: "g", OPENROUTER_API_KEY: "o" };

  it("a failed provider is skipped, the others stay in order", () => {
    markFailed("google", "quota", 1_000);
    expect(usableChoices(env, 2_000).map((c) => c.id)).toEqual(["groq", "openrouter"]);
  });

  it("it comes back after its cooldown, and the cooldown depends on the kind of failure", () => {
    markFailed("google", "transient", 0);
    expect(isCooling("google", COOLDOWN_MS.transient - 1)).toBe(true);
    expect(isCooling("google", COOLDOWN_MS.transient + 1)).toBe(false);
    expect(COOLDOWN_MS.quota).toBeGreaterThan(COOLDOWN_MS.transient);
    expect(COOLDOWN_MS.auth).toBeGreaterThanOrEqual(COOLDOWN_MS.quota);
  });

  it("when every provider is cooling there is nothing to try (the built-in planner takes over)", () => {
    for (const id of ["google", "groq", "openrouter"] as const) markFailed(id, "quota", 0);
    expect(usableChoices(env, 10)).toEqual([]);
  });

  it("failures are tracked per provider", () => {
    markFailed("groq", "auth", 0);
    expect(isCooling("groq", 5)).toBe(true);
    expect(isCooling("google", 5)).toBe(false);
  });

  it("resetHealth clears everything", () => {
    markFailed("google", "quota", 0);
    resetHealth();
    expect(isCooling("google", 1)).toBe(false);
  });
});

describe("stripReasoning: providers that reject echoed thinking", () => {
  it("removes reasoning_content from assistant messages only, and keeps everything else", () => {
    const out: any = stripReasoning({
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: null, reasoning_content: "thinking", tool_calls: [{ id: "1" }] },
        { role: "tool", tool_call_id: "1", content: "ok" },
      ],
    });
    expect(out.model).toBe("m");
    expect(out.messages[1]).toEqual({ role: "assistant", content: null, tool_calls: [{ id: "1" }] });
    expect(out.messages[0]).toEqual({ role: "user", content: "hi" });
    expect(out.messages[2].content).toBe("ok");
  });
  it("leaves bodies without messages alone", () => expect(stripReasoning({ a: 1 })).toEqual({ a: 1 }));
});

describe("the Groq request on the wire", () => {
  it("never carries reasoning_content, even when the SDK would echo it", async () => {
    const { generateText, tool } = await import("ai");
    const { z } = await import("zod");
    const sent: any[] = [];
    const real = globalThis.fetch;
    let n = 0;
    globalThis.fetch = (async (_u: any, init: any) => {
      sent.push(JSON.parse(init.body));
      const msg = n++ === 0
        ? { role: "assistant", content: null, reasoning_content: "thinking...", tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }] }
        : { role: "assistant", content: "done" };
      return new Response(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: msg, finish_reason: n === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { headers: { "content-type": "application/json" } });
    }) as any;
    try {
      const { isStepCount } = await import("ai");
      await generateText({ model: buildChoice("groq", { GROQ_API_KEY: "g" }).model, prompt: "hi", tools: { t: tool({ description: "d", inputSchema: z.object({}), execute: async () => "ok" }) }, stopWhen: isStepCount(3) });
    } finally { globalThis.fetch = real; }
    expect(sent.length).toBe(2);
    expect(JSON.stringify(sent[1])).not.toContain("reasoning_content");
    expect(JSON.stringify(sent[1])).toContain("tool_calls");
  });
});
