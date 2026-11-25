import { beforeEach, describe, expect, it, vi } from "vitest";
import { isStepCount, streamText } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { makeTools } from "../lib/agent/tools";
import { formToRaw, normalizePrefs } from "../lib/agent/prefs";
import { defaultProviders, newCtx } from "./mocks";

vi.mock("../lib/agent/providers", async (orig) => {
  const actual = await orig<typeof import("../lib/agent/providers")>();
  return { ...actual, geocode: vi.fn(), saturdayWeather: vi.fn(), overpassPlaces: vi.fn(), nominatimPlaces: vi.fn(), geocodePlace: vi.fn(), nominatimCity: vi.fn() };
});

/**
 * Token budget regression guard. Runs the same 4-step agent loop twice against the real tools: once as the model
 * sees things now (compact results), once with the old behaviour (every tool result sent in full, internal trace
 * data included). Characters are a close proxy for tokens (about 4 characters per token for this kind of text).
 */
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const toolStep = (calls: { name: string; input: object }[]) => ({
  stream: convertArrayToReadableStream<any>([
    { type: "stream-start", warnings: [] },
    ...calls.map((c, i) => ({ type: "tool-call", toolCallId: `${c.name}_${i}`, toolName: c.name, input: JSON.stringify(c.input) })),
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
  ]),
});
const textStep = () => ({ stream: convertArrayToReadableStream<any>([{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "ok" }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }]) });

/**
 * old        every tool result sent in full, one tool step before the search step (the previous behaviour)
 * compact    compact results, same step structure
 * current    compact results and the first step runs parse, weather and both searches together
 */
type Mode = "old" | "compact" | "current";

async function measure(mode: Mode, city = "Bangalore") {
  const ctx = newCtx();
  ctx.formPrefs = { city, budget: 2500, available_time: "4 hours", start_time: "10:00", people: 1, interests: ["art", "walks", "music"], constraints: ["vegetarian"] };
  ctx.prefs = normalizePrefs(formToRaw(ctx.formPrefs)).prefs!; // what the route does for a form submission
  const tools: any = makeTools(ctx);
  if (mode === "old") for (const t of Object.values(tools) as any[]) delete t.toModelOutput; // send results as they are
  const parallel = mode === "current";
  const searches = [
    { name: "get_weather", input: { city } },
    { name: "get_activity_options", input: { city, interests: ["art", "walks", "music"] } },
    { name: "get_food_options", input: { city, budget_per_meal_inr: 600, vegetarian: true } },
  ];
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async (opts: any) => {
      const step = n++;
      if (parallel ? step === 0 : step === 0 || step === 1) {
        return toolStep(parallel ? [{ name: "parse_preferences", input: { city } }, ...searches] : step === 0 ? [{ name: "parse_preferences", input: { city } }] : searches);
      }
      if (step === (parallel ? 1 : 2)) {
        const text = JSON.stringify(opts.prompt);
        const ids = [...new Set([...text.matchAll(/(?:cur|osm)-[a-z0-9-]+/g)].map((m) => m[0]))];
        const food = ids.find((id) => /mtr|dyu|koshys|vidyarthi|ctr|saravana|ich|triveni_cafe|samovar/.test(id)) ?? ids[1];
        const act = ids.find((id) => id !== food) ?? ids[0];
        return toolStep([{ name: "build_itinerary", input: { title: "Day", stops: [{ place_id: act, why: "Matches your interests" }, { place_id: food, why: "A meal break" }] } }]);
      }
      return textStep();
    },
  });
  const result = streamText({ model, tools, system: "s", prompt: "go", stopWhen: isStepCount(6) });
  const parts: any[] = [];
  for await (const p of result.stream as any) parts.push(p);
  const plan = parts.find((p) => p.type === "tool-result" && p.toolName === "build_itinerary")?.output?.itinerary;
  const perStep = model.doStreamCalls.map((c) => JSON.stringify(c.prompt).length + JSON.stringify(c.tools ?? []).length);
  return { perStep, total: perStep.reduce((a, b) => a + b, 0), plan, calls: model.doStreamCalls.length };
}

const pct = (after: number, before: number) => Math.round((1 - after / before) * 100);

describe("token budget", () => {
  beforeEach(() => defaultProviders());

  it("reads far less than before, and makes fewer model calls", async () => {
    const old = await measure("old");
    const compact = await measure("compact");
    const current = await measure("current");
    console.log(
      `
  model input characters (about 4 per token), Bangalore, scripted model
` +
        `    old      : ${old.calls} model calls, ${String(old.total).padStart(6)} chars  (~${Math.round(old.total / 4)} tokens)
` +
        `    compact  : ${compact.calls} model calls, ${String(compact.total).padStart(6)} chars  (${pct(compact.total, old.total)}% less)
` +
        `    current  : ${current.calls} model calls, ${String(current.total).padStart(6)} chars  (${pct(current.total, old.total)}% less, ~${Math.round(current.total / 4)} tokens)
` +
        `    per step, old     : ${old.perStep.join(", ")}
    per step, current : ${current.perStep.join(", ")}
`,
    );
    expect(compact.total).toBeLessThan(old.total * 0.8);
    expect(current.total).toBeLessThan(old.total * 0.6); // at least 40% less across the run; never regress past this
    expect(current.calls).toBe(old.calls - 1); // one round trip fewer
    // every variant still produces the same valid plan
    for (const r of [old, compact, current]) expect(r.plan?.validation.ok).toBe(true);
  });

  it("holds for another city too", async () => {
    const old = await measure("old", "Delhi");
    const current = await measure("current", "Delhi");
    expect(current.total).toBeLessThan(old.total * 0.6);
    expect(current.plan?.validation.ok).toBe(true);
  });
});
