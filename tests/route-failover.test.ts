import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WARNING_MARK } from "../lib/marks";
import { defaultProviders } from "./mocks";

vi.mock("../lib/agent/providers", async (orig) => {
  const actual = await orig<typeof import("../lib/agent/providers")>();
  return { ...actual, geocode: vi.fn(), saturdayWeather: vi.fn(), overpassPlaces: vi.fn(), nominatimPlaces: vi.fn(), geocodePlace: vi.fn(), nominatimCity: vi.fn() };
});
vi.mock("ai", async (orig) => ({ ...(await orig<typeof import("ai")>()), streamText: vi.fn(), toUIMessageStream: vi.fn() }));
// every provider's model is a tagged stand-in, so the tests can see which one a request was sent to
vi.mock("@ai-sdk/google", () => ({ createGoogleGenerativeAI: () => (id: string) => ({ tag: "google", modelId: id }) }));
vi.mock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible: ({ name }: { name: string }) => ({ chatModel: (id: string) => ({ tag: name, modelId: id }) }) }));

import { streamText, toUIMessageStream } from "ai";
import { POST } from "../app/api/chat/route";
import { isCooling, resetHealth } from "../lib/agent/llm";

const form = (o: Record<string, unknown> = {}) => ({
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "Plan my perfect Saturday. Here are my details:\n" + JSON.stringify({ city: "Bangalore", budget: 2500, available_time: "4 hours", start_time: "10:00", interests: ["food", "art"], constraints: ["vegetarian"], ...o }) }],
});

let ipN = 0;
const send = async (messages: unknown[]) => {
  const res = await POST(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `192.0.2.${++ipN}` }, body: JSON.stringify({ messages }) }));
  const text = await res.text();
  return { status: res.status, chunks: text.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6))) };
};

/** What each tagged provider's stream produces. */
const ok = (text = "plan ready") => [
  { type: "start" }, { type: "start-step" }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text }, { type: "text-end", id: "t" }, { type: "finish-step" }, { type: "finish" },
];
const failing = (message: string, withTools = false) => [
  { type: "start" }, { type: "start-step" },
  ...(withTools ? [{ type: "tool-input-available", toolCallId: "g1", toolName: "get_weather", input: {} }, { type: "tool-output-available", toolCallId: "g1", output: { weather: "clear" } }] : []),
  { type: "error", errorText: message },
];
function providersBehave(script: Record<string, any[]>) {
  vi.mocked(streamText).mockImplementation(((opts: any) => ({ stream: opts.model.tag })) as any);
  vi.mocked(toUIMessageStream).mockImplementation((({ stream }: any) => new ReadableStream({ start(c) { (script[stream] ?? []).forEach((x) => c.enqueue(x)); c.close(); } })) as any);
}
const usedProviders = () => vi.mocked(streamText).mock.calls.map((c: any[]) => c[0].model.tag);
const KEYS = ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY", "CEREBRAS_API_KEY", "LLM_PROVIDERS"];

describe("provider failover before the built-in planner", () => {
  beforeEach(() => {
    defaultProviders();
    resetHealth();
    vi.mocked(streamText).mockReset();
    vi.mocked(toUIMessageStream).mockReset();
    KEYS.forEach((k) => delete process.env[k]);
    process.env.GEMINI_API_KEY = "g-key";
    process.env.GROQ_API_KEY = "q-key";
    process.env.OPENROUTER_API_KEY = "o-key";
  });
  afterEach(() => KEYS.forEach((k) => delete process.env[k]));

  it("uses the first provider when it works, and never touches the others", async () => {
    providersBehave({ google: ok("from google") });
    const { chunks } = await send([form()]);
    expect(usedProviders()).toEqual(["google"]);
    expect(JSON.stringify(chunks)).toContain("from google");
  });

  it("a quota error moves the request to the next provider, with one well-formed stream", async () => {
    providersBehave({ google: failing("You exceeded your current quota"), groq: ok("from groq") });
    const { chunks, status } = await send([form()]);
    expect(status).toBe(200);
    expect(usedProviders()).toEqual(["google", "groq"]);
    expect(JSON.stringify(chunks)).toContain("from groq");
    expect(chunks.some((c) => c.type === "error")).toBe(false); // the failed provider's error never reaches the client
    expect(chunks.filter((c) => c.type === "start")).toHaveLength(1);
    // steps stay balanced even though the first provider died mid-step
    expect(chunks.filter((c) => c.type === "start-step").length).toBe(chunks.filter((c) => c.type === "finish-step").length);
    expect(chunks.at(-1).type).toBe("finish");
  });

  it("tries every provider in order before giving up", async () => {
    providersBehave({ google: failing("429 quota"), groq: failing("503 overloaded"), openrouter: ok("from openrouter") });
    const { chunks } = await send([form()]);
    expect(usedProviders()).toEqual(["google", "groq", "openrouter"]);
    expect(JSON.stringify(chunks)).toContain("from openrouter");
    const notes = chunks.filter((c) => c.type === "text-delta" && String(c.delta).startsWith(WARNING_MARK)).map((c) => c.delta);
    expect(notes).toHaveLength(2); // one small notice per switch, and no built-in planner notice
    expect(notes[0]).toMatch(/Gemini hit its quota\. Continuing with Groq/);
    expect(notes[1]).toMatch(/Groq is unavailable\. Continuing with OpenRouter/);
  });

  it("recovers when a provider fails after it already streamed tool calls", async () => {
    providersBehave({ google: failing("503 overloaded", true), groq: ok("recovered") });
    const { chunks } = await send([form()]);
    expect(usedProviders()).toEqual(["google", "groq"]);
    expect(chunks.some((c) => c.type === "tool-output-available" && c.toolCallId === "g1")).toBe(true); // what already ran stays visible
    expect(JSON.stringify(chunks)).toContain("recovered");
    expect(chunks.filter((c) => c.type === "start-step").length).toBe(chunks.filter((c) => c.type === "finish-step").length);
  });

  it("a provider that stops with nothing (output limit hit while thinking) counts as failed, and the next one answers", async () => {
    const step = (finishReason: string, text = "", toolCalls: any[] = []) => ({ finishReason, text, toolCalls });
    vi.mocked(streamText).mockImplementation(((opts: any) => {
      const t = opts.model.tag;
      const run: any = { stream: t };
      // the real SDK reports each finished step to onStepEnd
      setTimeout(() => opts.onStepEnd?.(t === "google" ? step("length") : step("stop", "all good")), 0);
      return run;
    }) as any);
    vi.mocked(toUIMessageStream).mockImplementation((({ stream }: any) => new ReadableStream({
      async start(c) {
        await new Promise((r) => setTimeout(r, 5));
        (stream === "google" ? [{ type: "start" }, { type: "start-step" }, { type: "finish-step" }, { type: "finish" }] : ok("from groq")).forEach((x) => c.enqueue(x));
        c.close();
      },
    })) as any);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { chunks } = await send([form()]);
    expect(usedProviders()).toEqual(["google", "groq"]);
    expect(JSON.stringify(chunks)).toContain("from groq");
    expect(isCooling("google")).toBe(true);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/output limit/); // the reason is logged, and recorded in the trace attempts
    expect(chunks.at(-1).type).toBe("finish");
  });

  it("when the last provider also ends with nothing, the built-in planner still delivers a plan", async () => {
    vi.mocked(streamText).mockImplementation(((opts: any) => {
      setTimeout(() => opts.onStepEnd?.({ finishReason: "length", text: "", toolCalls: [] }), 0);
      return { stream: opts.model.tag };
    }) as any);
    vi.mocked(toUIMessageStream).mockImplementation((() => new ReadableStream({ async start(c) { await new Promise((r) => setTimeout(r, 5)); [{ type: "start" }, { type: "start-step" }, { type: "finish-step" }, { type: "finish" }].forEach((x) => c.enqueue(x)); c.close(); } })) as any);
    const { chunks } = await send([form()]);
    expect(JSON.stringify(chunks)).toContain("build_itinerary");
    expect(JSON.stringify(chunks)).toContain(WARNING_MARK);
    expect(chunks.at(-1).type).toBe("finish");
  });

  it("the in-chat form is pre-filled by the server even when the model passes no prefill", async () => {
    const ask = (input: object) => [{ type: "start" }, { type: "start-step" }, { type: "tool-input-available", toolCallId: "a1", toolName: "ask_user_preferences", input }, { type: "finish-step" }, { type: "finish" }];
    providersBehave({ google: ask({ reason: "Raise the per-meal budget?" }) });
    const { chunks } = await send([form({ budget: 300, available_time: "5 hours", mood: "bored" })]);
    const shown = chunks.find((c) => c.type === "tool-input-available" && c.toolName === "ask_user_preferences");
    expect(shown.input.reason).toBe("Raise the per-meal budget?");
    expect(shown.input.prefill).toMatchObject({ city: "Bangalore", budget: 300, available_time: "5 hours", mood: "bored", constraints: ["vegetarian"] });
  });

  it("a provider that just failed is skipped on the next request", async () => {
    providersBehave({ google: failing("quota exceeded"), groq: ok() });
    await send([form()]);
    expect(isCooling("google")).toBe(true);
    vi.mocked(streamText).mockClear();
    await send([form()]);
    expect(usedProviders()).toEqual(["groq"]); // no time wasted on the exhausted provider
  });

  it("every kind of failure puts the provider on cooldown", async () => {
    providersBehave({ google: failing("401 invalid API key"), groq: failing("fetch failed"), openrouter: ok() });
    await send([form()]);
    expect(isCooling("google")).toBe(true);
    expect(isCooling("groq")).toBe(true);
    expect(isCooling("openrouter")).toBe(false);
  });

  it("fails fast on all but the last provider (retrying a spent quota is pointless)", async () => {
    providersBehave({ google: failing("quota"), groq: failing("quota"), openrouter: ok() });
    await send([form()]);
    const retries = vi.mocked(streamText).mock.calls.map((c: any[]) => c[0].maxRetries);
    expect(retries).toEqual([0, 0, 1]);
  });

  it("with a single provider it keeps its one retry", async () => {
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    providersBehave({ google: ok() });
    await send([form()]);
    expect(vi.mocked(streamText).mock.calls[0][0].maxRetries).toBe(1);
  });

  describe("when every provider fails, the built-in planner delivers a validated plan", () => {
    it("with the reason shown and each attempt recorded in the trace", async () => {
      providersBehave({ google: failing("You exceeded your current quota"), groq: failing("429 rate limit"), openrouter: failing("503 overloaded") });
      const { chunks } = await send([form()]);
      expect(usedProviders()).toEqual(["google", "groq", "openrouter"]);
      const callouts = chunks.filter((c) => c.type === "text-delta" && String(c.delta).startsWith(WARNING_MARK)).map((c) => String(c.delta));
      expect(callouts.some((d) => /Built-in planner used/.test(d))).toBe(true);
      expect(callouts.filter((d) => /Continuing with/.test(d))).toHaveLength(2); // the two switches before it
      const plan = chunks.filter((c) => c.type === "tool-output-available" && c.output?.itinerary).at(-1).output.itinerary;
      expect(plan.validation.ok).toBe(true);
      const trace = chunks.find((c) => c.type === "message-metadata").messageMetadata.trace;
      expect(trace.model).toMatch(/built-in planner/);
      expect(trace.providers.map((p: any) => [p.provider, p.status, p.kind])).toEqual([
        ["gemini-3.5-flash", "failed", "quota"],
        ["groq/openai/gpt-oss-120b", "failed", "quota"],
        ["openrouter/openrouter/free", "failed", "transient"],
      ]);
      expect(chunks.filter((c) => c.type === "start")).toHaveLength(1);
      expect(chunks.at(-1).type).toBe("finish");
    });

    it("no keys configured at all: says so, and still plans", async () => {
      KEYS.forEach((k) => delete process.env[k]);
      const { chunks } = await send([form()]);
      expect(streamText).not.toHaveBeenCalled();
      expect(chunks.find((c) => c.type === "text-delta" && String(c.delta).startsWith(WARNING_MARK)).delta).toMatch(/key is not configured/i);
      expect(chunks.some((c) => c.type === "tool-output-available" && c.output?.itinerary)).toBe(true);
    });

    it("all providers cooling: no model call, and an outage is not reported as a quota problem", async () => {
      providersBehave({ google: failing("503 overloaded"), groq: failing("503 overloaded"), openrouter: failing("fetch failed") });
      await send([form()]); // puts all three on cooldown
      vi.mocked(streamText).mockClear();
      const { chunks } = await send([form()]);
      expect(streamText).not.toHaveBeenCalled();
      const callout = chunks.find((c) => c.type === "text-delta" && String(c.delta).startsWith(WARNING_MARK)).delta;
      expect(callout).toMatch(/temporarily unavailable/);
      expect(callout).not.toMatch(/quota/i);
    });
  });

  it("LLM_PROVIDERS sets the priority order", async () => {
    process.env.LLM_PROVIDERS = "openrouter,groq";
    providersBehave({ openrouter: failing("quota"), groq: ok("from groq") });
    await send([form()]);
    expect(usedProviders()).toEqual(["openrouter", "groq"]); // Gemini is not in the list, so it is never used
  });

  describe("every provider gets the same guarded request", () => {
    it("same tools, caps, system prompt and compact history for each attempt", async () => {
      providersBehave({ google: failing("quota"), groq: ok() });
      await send([form()]);
      const [a, b] = vi.mocked(streamText).mock.calls.map((c: any[]) => c[0]);
      for (const o of [a, b]) {
        expect(Object.keys(o.tools).sort()).toEqual(["ask_user_preferences", "build_itinerary", "get_activity_options", "get_food_options", "get_weather", "parse_preferences"]);
        expect(o.maxOutputTokens).toBe(1500);
        expect(o.stopWhen).toBeDefined();
        expect(o.system).toBe(a.system);
        expect(o.messages).toEqual(a.messages);
      }
      expect(a.providerOptions).toEqual({ google: { thinkingConfig: { thinkingLevel: "low" } } }); // Gemini-only setting
      expect(b.providerOptions).toEqual({ groq: { reasoningEffort: "low" } }); // short thinking for the reasoning model
    });

    it("the system prompt carries the faithfulness rules", async () => {
      providersBehave({ google: ok() });
      await send([form()]);
      const system: string = vi.mocked(streamText).mock.calls[0][0].system as string;
      expect(system).toMatch(/ONLY facts from the options table/);
      expect(system).toMatch(/Do not write prices or amounts in rupees/);
      expect(system).toMatch(/do not state costs or durations/);
      expect(system).toMatch(/never invent places/i);
    });

    it("a form the user ignored does not break the conversation sent to the provider", async () => {
      providersBehave({ google: ok() });
      const ignored = { id: "a1", role: "assistant", parts: [{ type: "tool-ask_user_preferences", toolCallId: "c1", state: "input-available", input: { reason: "x" } }] };
      const { status } = await send([{ id: "u0", role: "user", parts: [{ type: "text", text: "plan something" }] }, ignored, { id: "u2", role: "user", parts: [{ type: "text", text: "Pune, 2000 rupees, 4 hours please" }] }]);
      expect(status).toBe(200);
      expect(JSON.stringify(vi.mocked(streamText).mock.calls[0][0].messages)).not.toContain("ask_user_preferences");
    });

    it("the user's budget is already authoritative in the first step, before parse_preferences has run", async () => {
      providersBehave({ google: ok() });
      await send([form({ budget: 2500, available_time: "4 hours" })]);
      const tools: any = vi.mocked(streamText).mock.calls[0][0].tools;
      const run = (name: string, input: object) => tools[name].execute(input, { toolCallId: name, messages: [] });
      const acts = await run("get_activity_options", { city: "Bangalore", interests: ["art", "walks"] });
      const ids = acts.options.slice(0, 2).map((o: any) => o.id);
      const built = await run("build_itinerary", { title: "t", budget_inr: 90000, available_hours: 20, stops: ids.map((id: string) => ({ place_id: id, why: "A place" })) });
      expect(built.itinerary.totals.budget).toBe(2500);
      expect(built.itinerary.totals.availableMinutes).toBe(240);
    });

    it("the user's form values override whatever the model passes to parse_preferences", async () => {
      providersBehave({ google: ok() });
      await send([form({ budget: 2500, available_time: "4 hours" })]);
      const tools: any = vi.mocked(streamText).mock.calls[0][0].tools;
      const out = await tools.parse_preferences.execute({ city: "Bangalore", budget_inr: 99999, available_time: "30 hours" }, { toolCallId: "x", messages: [] });
      expect(out.prefs).toMatchObject({ budget: 2500, availableHours: 4 });
    });
  });
});
