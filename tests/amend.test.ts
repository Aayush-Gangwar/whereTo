import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { call, defaultProviders, newCtx } from "./mocks";
import { makeTools, seedFromHistory } from "../lib/agent/tools";
import { prefsToRaw } from "../lib/agent/prefs";

vi.mock("../lib/agent/providers", async (orig) => {
  const actual = await orig<typeof import("../lib/agent/providers")>();
  return { ...actual, geocode: vi.fn(), saturdayWeather: vi.fn(), overpassPlaces: vi.fn(), nominatimPlaces: vi.fn(), geocodePlace: vi.fn(), nominatimCity: vi.fn() };
});
let choices: any[] = [];
vi.mock("../lib/agent/llm", async (orig) => ({ ...(await orig<typeof import("../lib/agent/llm")>()), usableChoices: () => choices }));
import { POST } from "../app/api/chat/route";

const prefs = (o: object = {}) => ({ city: "Bangalore", budget: 300, availableHours: 5, startHour: 10, people: 1, mood: "bored", interests: ["art"], constraints: ["vegetarian"], flags: { vegetarian: true, vegan: false, avoidCrowds: false, lowWalking: false, noAlcohol: false }, ...o });

describe("a budget the user raises in chat stays raised", () => {
  beforeEach(() => defaultProviders());

  it("a later parse that only says the new budget keeps everything else", async () => {
    const ctx = newCtx();
    ctx.prefs = prefs() as any;
    ctx.latestUserText = "600 rupees and add food";
    const out = await call(makeTools(ctx), "parse_preferences", { budget_inr: 600 });
    expect(out.prefs).toMatchObject({ city: "Bangalore", budget: 600, availableHours: 5, people: 1 });
    expect(out.missing).toEqual([]);
    expect(ctx.prefs?.budget).toBe(600);
  });

  it("but a bigger number the user did not write is not taken", async () => {
    const ctx = newCtx();
    ctx.prefs = prefs() as any;
    ctx.latestUserText = "add some food please";
    const out = await call(makeTools(ctx), "parse_preferences", { budget_inr: 5000 });
    expect(out.prefs.budget).toBe(300);
  });

  it("the raised budget is still in force on the next turn (rebuilt from the earlier plan)", () => {
    const ctx = newCtx();
    const history = [
      { role: "assistant", parts: [{ type: "tool-parse_preferences", state: "output-available", output: { prefs: prefs() } }, { type: "tool-build_itinerary", state: "output-available", output: { itinerary: { totals: { budget: 600, availableMinutes: 300 } } } }] },
    ];
    seedFromHistory(ctx, history);
    expect(ctx.prefs?.budget).toBe(600);
  });

  it("a cheaper draft does not lower the stored budget", () => {
    const ctx = newCtx();
    seedFromHistory(ctx, [{ role: "assistant", parts: [{ type: "tool-parse_preferences", state: "output-available", output: { prefs: prefs() } }, { type: "tool-build_itinerary", state: "output-available", output: { itinerary: { totals: { budget: 210, availableMinutes: 300 } } } }] }]);
    expect(ctx.prefs?.budget).toBe(300);
  });

  it("prefsToRaw round-trips what the parser needs", () => {
    expect(prefsToRaw(prefs({ startHour: 17.5 }) as any)).toMatchObject({ city: "Bangalore", budget_inr: 300, available_time: "5", start_time: "17:30", people: 1 });
  });
});

describe("an endless repair loop is stopped", () => {
  beforeEach(() => defaultProviders());
  it("after the allowed drafts build_itinerary tells the model to stop and be honest", async () => {
    const ctx = newCtx();
    ctx.prefs = prefs() as any;
    const t = makeTools(ctx);
    const acts = await call(t, "get_activity_options", { city: "Bangalore", interests: ["art"] });
    const ids = acts.options.slice(0, 2).map((o: any) => o.id);
    const draft = () => call(t, "build_itinerary", { title: "t", stops: ids.map((id: string) => ({ place_id: id, why: "w" })) });
    for (let i = 0; i < 5; i++) expect((await draft()).error).toBeUndefined();
    const sixth = await draft();
    expect(sixth.error).toBe("repair_limit");
    expect(sixth.message).toMatch(/Do NOT call build_itinerary again/);
  });
});

describe("the run always ends with a written answer", () => {
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const toolStep = () => ({ stream: convertArrayToReadableStream<any>([{ type: "stream-start", warnings: [] }, { type: "tool-call", toolCallId: "c" + Math.random(), toolName: "get_weather", input: JSON.stringify({ city: "Bangalore" }) }, { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage }]) });
  const textStep = () => ({ stream: convertArrayToReadableStream<any>([{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Here is where things stand." }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }]) });

  it("a model that keeps calling tools is made to write on its last step", async () => {
    defaultProviders();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = new MockLanguageModelV4({ doStream: async (o: any) => (o.toolChoice?.type === "none" ? textStep() : toolStep()) });
    choices = [{ id: "groq", modelId: "m", label: "groq/m", model }];
    const form = { id: "u", role: "user", parts: [{ type: "text", text: "Plan my perfect Saturday. Here are my details:\n" + JSON.stringify({ city: "Bangalore", budget: 2500, available_time: "4 hours", start_time: "10:00", interests: ["art"] }) }] };
    const res = await POST(new Request("http://l/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" }, body: JSON.stringify({ messages: [form] }) }));
    const chunks = (await res.text()).split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
    expect(model.doStreamCalls).toHaveLength(8); // every allowed step used...
    expect(model.doStreamCalls.at(-1)!.toolChoice).toMatchObject({ type: "none" }); // ...and the last one could not call a tool
    expect(chunks.some((c) => c.type === "text-delta" && /where things stand/.test(c.delta))).toBe(true);
    expect(chunks.at(-1).type).toBe("finish");
  });
});
