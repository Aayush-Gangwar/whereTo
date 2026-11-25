import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { WARNING_MARK } from "../lib/marks";
import { defaultProviders } from "./mocks";

vi.mock("../lib/agent/providers", async (orig) => {
  const actual = await orig<typeof import("../lib/agent/providers")>();
  return { ...actual, geocode: vi.fn(), saturdayWeather: vi.fn(), overpassPlaces: vi.fn(), nominatimPlaces: vi.fn(), geocodePlace: vi.fn(), nominatimCity: vi.fn() };
});

/**
 * Two providers through the REAL AI SDK loop (only the models are scripted): the first completes the tool step and then
 * fails; the second must carry on from there instead of repeating the tool calls.
 */
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const toolStep = (calls: { name: string; input: object }[]) => ({
  stream: convertArrayToReadableStream<any>([
    { type: "stream-start", warnings: [] },
    ...calls.map((c, i) => ({ type: "tool-call", toolCallId: `${c.name}_${i}`, toolName: c.name, input: JSON.stringify(c.input) })),
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
  ]),
});
const textStep = (t: string) => ({ stream: convertArrayToReadableStream<any>([{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: t }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }]) });

const first = ["parse_preferences", "get_weather", "get_activity_options", "get_food_options"];
const firstStep = () => toolStep([
  { name: "parse_preferences", input: { city: "Bangalore" } },
  { name: "get_weather", input: { city: "Bangalore" } },
  { name: "get_activity_options", input: { city: "Bangalore", interests: ["art"] } },
  { name: "get_food_options", input: { city: "Bangalore", budget_per_meal_inr: 600, vegetarian: true } },
]);

let modelA: MockLanguageModelV4;
let modelB: MockLanguageModelV4;
let choices: any[];
vi.mock("../lib/agent/llm", async (orig) => ({ ...(await orig<typeof import("../lib/agent/llm")>()), usableChoices: () => choices }));
import { POST } from "../app/api/chat/route";

let ip = 0;
const form = { id: "u", role: "user", parts: [{ type: "text", text: "Plan my perfect Saturday. Here are my details:\n" + JSON.stringify({ city: "Bangalore", budget: 2500, available_time: "4 hours", start_time: "10:00", interests: ["art"], constraints: ["vegetarian"] }) }] };
const run = async () => {
  const res = await POST(new Request("http://l/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${++ip}` }, body: JSON.stringify({ messages: [form] }) }));
  const text = await res.text();
  return text.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
};
const toolCallsIn = (chunks: any[]) => chunks.filter((c) => c.type === "tool-input-available").map((c) => c.toolName);

describe("a provider fails after finishing the tool step", () => {
  beforeEach(() => {
    defaultProviders();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let a = 0;
    modelA = new MockLanguageModelV4({ doStream: async () => { if (a++ === 0) return firstStep(); throw new Error("You exceeded your current quota"); } });
    modelB = new MockLanguageModelV4({
      doStream: async (opts: any) => {
        const text = JSON.stringify(opts.prompt.filter((m: any) => m.role !== "system")); // the system prompt names every tool
        const ids = [...new Set([...text.matchAll(/(?:cur|osm)-[a-z0-9-]+/g)].map((m) => m[0]))];
        if (!/get_weather/.test(text)) return firstStep(); // history carried over: nothing to redo
        if (!/build_itinerary/.test(text) && ids.length >= 2) return toolStep([{ name: "build_itinerary", input: { title: "Day", stops: ids.slice(0, 2).map((id) => ({ place_id: id, why: "Matches your interests" })) } }]);
        return textStep("Here is your plan.");
      },
    });
    choices = [
      { id: "google", modelId: "a", label: "gemini-x", model: modelA },
      { id: "groq", modelId: "b", label: "groq/b", model: modelB },
    ];
  });

  it("the next provider carries on from the completed steps instead of repeating the tool calls", async () => {
    const chunks = await run();
    const calls = toolCallsIn(chunks);
    for (const t of first) expect(calls.filter((c) => c === t)).toHaveLength(1); // each tool ran once, not twice
    expect(calls).toContain("build_itinerary");
    expect(chunks.at(-1).type).toBe("finish");
    expect(chunks.some((c) => c.type === "error")).toBe(false);
    // the second provider was shown the earlier tool results
    const seen = JSON.stringify(modelB.doStreamCalls[0].prompt);
    expect(seen).toContain("get_weather");
    expect(seen).toContain("get_activity_options");
    const plan = chunks.filter((c) => c.type === "tool-output-available" && c.output?.itinerary).at(-1)?.output.itinerary;
    expect(plan?.validation.ok).toBe(true);
  });

  it("says in the chat that it switched, in the existing callout style, and keeps steps balanced", async () => {
    const chunks = await run();
    const note = chunks.find((c) => c.type === "text-delta" && String(c.delta).startsWith(WARNING_MARK));
    expect(note.delta).toMatch(/Gemini hit its quota\. Continuing with Groq/);
    expect(note.delta).toMatch(/steps already done/);
    expect(chunks.filter((c) => c.type === "start-step")).toHaveLength(chunks.filter((c) => c.type === "finish-step").length);
    expect(chunks.filter((c) => c.type === "start")).toHaveLength(1);
  });

  it("the trace keeps a per-step provider, so the switch is visible there too", async () => {
    const chunks = await run();
    const trace = chunks.filter((c) => c.type === "message-metadata").at(-1).messageMetadata.trace;
    expect([...new Set(trace.llm.map((s: any) => s.provider))]).toEqual(["gemini-x", "groq/b"]);
    expect(trace.providers[0]).toMatchObject({ provider: "gemini-x", status: "failed", kind: "quota" });
  });

  it("no switch notice when the first provider serves the request", async () => {
    choices = [{ id: "groq", modelId: "b", label: "groq/b", model: modelB }];
    const chunks = await run();
    expect(chunks.some((c) => c.type === "text-delta" && String(c.delta).startsWith(WARNING_MARK))).toBe(false);
  });
});

describe("the next provider rejects the carried-over steps", () => {
  it("is retried once from a clean start instead of being written off", async () => {
    defaultProviders();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let a = 0;
    modelA = new MockLanguageModelV4({ doStream: async () => { if (a++ === 0) return firstStep(); throw new Error("You exceeded your current quota"); } });
    let b = 0;
    modelB = new MockLanguageModelV4({
      doStream: async (opts: any) => {
        const text = JSON.stringify(opts.prompt.filter((m: any) => m.role !== "system")); // the system prompt names every tool
        if (/get_weather/.test(text) && b++ === 0) throw new Error("400 invalid tool_call_id format"); // dislikes the other provider's history
        if (!/get_weather/.test(text)) return firstStep();
        return textStep("Done.");
      },
    });
    choices = [{ id: "google", modelId: "a", label: "gemini-x", model: modelA }, { id: "groq", modelId: "b", label: "groq/b", model: modelB }];
    const chunks = await run();
    expect(modelB.doStreamCalls.length).toBeGreaterThanOrEqual(2);
    expect(chunks.at(-1).type).toBe("finish");
    expect(chunks.some((c) => c.type === "error")).toBe(false);
    expect(toolCallsIn(chunks)).toContain("get_weather");
  });
});
