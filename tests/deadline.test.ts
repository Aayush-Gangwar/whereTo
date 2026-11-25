import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { WARNING_MARK } from "../lib/marks";
import { defaultProviders } from "./mocks";

vi.hoisted(() => {
  process.env.RUN_DEADLINE_MS = "400";
  process.env.MIN_ATTEMPT_MS = "50";
});
vi.mock("../lib/agent/providers", async (orig) => {
  const actual = await orig<typeof import("../lib/agent/providers")>();
  return { ...actual, geocode: vi.fn(), saturdayWeather: vi.fn(), overpassPlaces: vi.fn(), nominatimPlaces: vi.fn(), geocodePlace: vi.fn(), nominatimCity: vi.fn() };
});
let choices: any[] = [];
vi.mock("../lib/agent/llm", async (orig) => ({ ...(await orig<typeof import("../lib/agent/llm")>()), usableChoices: () => choices }));
import { POST } from "../app/api/chat/route";
import { vegOf } from "../lib/agent/providers";

const form = { id: "u", role: "user", parts: [{ type: "text", text: "Plan my perfect Saturday. Here are my details:\n" + JSON.stringify({ city: "Bangalore", budget: 2500, available_time: "4 hours", start_time: "10:00", interests: ["art"], constraints: ["vegetarian"] }) }] };

describe("a model that is too slow cannot leave the user with an empty run", () => {
  beforeEach(() => {
    defaultProviders();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("the built-in planner delivers a plan before the function time limit", async () => {
    // never answers, but honours the abort signal like a real HTTP call
    const slow = new MockLanguageModelV4({
      doStream: ((o: any) => new Promise((_, rej) => o.abortSignal?.addEventListener("abort", () => rej(new Error("The operation was aborted due to timeout"))))) as any,
    });
    choices = [{ id: "google", modelId: "a", label: "gemini-x", model: slow }, { id: "groq", modelId: "b", label: "groq/b", model: slow }];
    const t0 = Date.now();
    const res = await POST(new Request("http://l/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.50" }, body: JSON.stringify({ messages: [form] }) }));
    const chunks = (await res.text()).split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
    expect(Date.now() - t0).toBeLessThan(3000);
    const plan = chunks.filter((c) => c.type === "tool-output-available" && c.output?.itinerary).at(-1)?.output.itinerary;
    expect(plan?.validation.ok).toBe(true);
    expect(chunks.some((c) => c.type === "text-delta" && String(c.delta).startsWith(WARNING_MARK) && /Built-in planner used/.test(c.delta))).toBe(true);
    expect(chunks.at(-1).type).toBe("finish");
    expect(chunks.some((c) => c.type === "error")).toBe(false);
  });
});

describe("the deadline hits after a validated plan already exists", () => {
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const toolStep = (calls: { name: string; input: object }[]) => ({
    stream: convertArrayToReadableStream<any>([
      { type: "stream-start", warnings: [] },
      ...calls.map((c, i) => ({ type: "tool-call", toolCallId: `${c.name}_${i}`, toolName: c.name, input: JSON.stringify(c.input) })),
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
    ]),
  });

  it("keeps that plan, adds a short note, and does not run the built-in planner", async () => {
    defaultProviders();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = new MockLanguageModelV4({
      doStream: (async (o: any) => {
        const text = JSON.stringify(o.prompt.filter((m: any) => m.role !== "system"));
        if (!/get_weather/.test(text)) {
          return toolStep([{ name: "get_weather", input: { city: "Bangalore" } }, { name: "get_activity_options", input: { city: "Bangalore", interests: ["art"] } }, { name: "get_food_options", input: { city: "Bangalore", budget_per_meal_inr: 600, vegetarian: true } }]);
        }
        if (!/build_itinerary/.test(text)) {
          const ids = [...new Set([...text.matchAll(/(?:cur|osm)-[a-z0-9-]+/g)].map((m) => m[0]))];
          return toolStep([{ name: "build_itinerary", input: { title: "Day", stops: ids.slice(0, 2).map((id) => ({ place_id: id, why: "Matches your interests" })) } }]);
        }
        return new Promise((_, rej) => o.abortSignal?.addEventListener("abort", () => rej(new Error("aborted")))); // the summary never arrives
      }) as any,
    });
    choices = [{ id: "google", modelId: "a", label: "gemini-x", model }];
    const res = await POST(new Request("http://l/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.60" }, body: JSON.stringify({ messages: [form] }) }));
    const chunks = (await res.text()).split(String.fromCharCode(10)).filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
    const plans = chunks.filter((c) => c.type === "tool-output-available" && c.output?.itinerary);
    expect(plans).toHaveLength(1); // one plan, not two
    expect(plans[0].output.itinerary.validation.ok).toBe(true);
    const notes = chunks.filter((c) => c.type === "text-delta" && String(c.delta).startsWith(WARNING_MARK)).map((c) => c.delta);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/Time limit reached/);
    expect(notes[0]).not.toMatch(/Built-in planner used/);
    expect(chunks.filter((c) => c.type === "start-step")).toHaveLength(chunks.filter((c) => c.type === "finish-step").length);
    expect(chunks.at(-1).type).toBe("finish");
  });
});

describe("OpenStreetMap places with no diet tag", () => {
  it.each([
    ["Dindigul Thalapakkatti", undefined, "no"],
    ["Meghana Foods", "biryani", "no"],
    ["Hotel Chicken Corner", undefined, "no"],
    ["Saravana Bhavan", "south_indian", "unknown"],
    ["Green Leaf", "vegetarian", "yes"],
    ["Biryani Zone", undefined, "no"],
  ])("%s (%s) is %s", (name, cuisine, expected) => expect(vegOf({ name, ...(cuisine ? { cuisine } : {}) } as any)).toBe(expected));

  it("an explicit vegetarian tag always wins over the name", () => {
    expect(vegOf({ name: "Chicken Free Biryani House", "diet:vegetarian": "only" } as any)).toBe("only");
  });
});
