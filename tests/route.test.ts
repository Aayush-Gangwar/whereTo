import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WARNING_MARK } from "../lib/marks";
import { defaultProviders } from "./mocks";

vi.mock("../lib/agent/providers", async (orig) => {
  const actual = await orig<typeof import("../lib/agent/providers")>();
  return { ...actual, geocode: vi.fn(), saturdayWeather: vi.fn(), overpassPlaces: vi.fn(), nominatimPlaces: vi.fn(), geocodePlace: vi.fn(), nominatimCity: vi.fn() };
});
vi.mock("ai", async (orig) => ({ ...(await orig<typeof import("ai")>()), streamText: vi.fn(), toUIMessageStream: vi.fn() }));
vi.mock("@ai-sdk/google", () => ({ createGoogleGenerativeAI: () => (id: string) => ({ modelId: id }) }));

import { streamText, toUIMessageStream } from "ai";
import { POST } from "../app/api/chat/route";

const formMessage = {
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "Plan my perfect Saturday. Here are my details:\n" + JSON.stringify({ city: "Bangalore", budget: 2500, available_time: "4 hours", start_time: "10:00", interests: ["food", "art"], constraints: ["vegetarian"] }) }],
};

let ipCounter = 0;
const request = (body: unknown, ip = `10.0.0.${++ipCounter}`) =>
  new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const readStream = async (res: Response) => {
  const text = await res.text();
  return text.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
};

/** Makes the mocked AI SDK emit these UI chunks, as the model loop would. */
const modelEmits = (chunks: any[]) => {
  vi.mocked(streamText).mockReturnValue({ stream: "model-stream" } as any);
  vi.mocked(toUIMessageStream).mockReturnValue(new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); } }) as any);
};

describe("POST /api/chat", () => {
  beforeEach(() => {
    defaultProviders();
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";
    vi.mocked(streamText).mockReset();
    vi.mocked(toUIMessageStream).mockReset();
  });
  afterEach(() => {
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  describe("LLM mode", () => {
    it("streams the model's output through untouched when the model works", async () => {
      modelEmits([
        { type: "start" }, { type: "start-step" },
        { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Here is your plan" }, { type: "text-end", id: "t" },
        { type: "finish-step" }, { type: "finish" },
      ]);
      const chunks = await readStream(await POST(request({ messages: [formMessage] })));
      expect(chunks.map((c) => c.type)).toEqual(["start", "start-step", "text-start", "text-delta", "text-end", "finish-step", "finish"]);
      expect(JSON.stringify(chunks)).not.toContain(WARNING_MARK);
    });

    it("gives the model exactly the guarded tool set, with the human-in-the-loop tool having no executor", async () => {
      modelEmits([{ type: "start" }, { type: "finish" }]);
      await (await POST(request({ messages: [formMessage] }))).text();
      const opts: any = vi.mocked(streamText).mock.calls[0][0];
      expect(Object.keys(opts.tools).sort()).toEqual(["ask_user_preferences", "build_itinerary", "get_activity_options", "get_food_options", "get_weather", "parse_preferences"]);
      expect(opts.tools.ask_user_preferences.execute).toBeUndefined();
      expect(opts.tools.build_itinerary.execute).toBeTypeOf("function");
    });

    it("applies the cost and safety caps", async () => {
      modelEmits([{ type: "start" }, { type: "finish" }]);
      await (await POST(request({ messages: [formMessage] }))).text();
      const opts: any = vi.mocked(streamText).mock.calls[0][0];
      expect(opts.maxOutputTokens).toBe(1500);
      expect(opts.maxRetries).toBe(1);
      expect(opts.stopWhen).toBeDefined();
      expect(opts.system).toMatch(/ONLY|only/);
    });

    it("does not call the model with the key missing from the request path (key comes from the server env)", async () => {
      modelEmits([{ type: "start" }, { type: "finish" }]);
      const res = await POST(request({ messages: [formMessage], apiKey: "attacker-key" }));
      expect(res.status).toBe(200);
      expect(JSON.stringify(vi.mocked(streamText).mock.calls[0][0])).not.toContain("attacker-key");
    });
  });

  describe("switch to the built-in planner", () => {
    it("model error before any output: the user still gets a validated plan and a warning", async () => {
      modelEmits([{ type: "start" }, { type: "start-step" }, { type: "error", errorText: "You exceeded your current quota" }]);
      const chunks = await readStream(await POST(request({ messages: [formMessage] })));
      const texts = chunks.filter((c) => c.type === "text-delta").map((c) => c.delta as string);
      expect(texts[0]).toContain(WARNING_MARK);
      expect(texts[0]).toMatch(/quota/i);
      const builds = chunks.filter((c) => c.type === "tool-output-available" && c.output?.itinerary);
      expect(builds.length).toBeGreaterThan(0);
      expect(builds.at(-1).output.itinerary.validation.ok).toBe(true);
      expect(chunks.at(-1).type).toBe("finish");
      const meta = chunks.find((c) => c.type === "message-metadata");
      expect(meta.messageMetadata.trace.model).toMatch(/built-in planner/);
      expect(meta.messageMetadata.trace.fallback).toBe(true);
    });

    it("the stream stays well-formed: exactly one start, and the error chunk never reaches the client", async () => {
      modelEmits([{ type: "start" }, { type: "start-step" }, { type: "error", errorText: "boom" }]);
      const chunks = await readStream(await POST(request({ messages: [formMessage] })));
      expect(chunks.filter((c) => c.type === "start")).toHaveLength(1);
      expect(chunks.some((c) => c.type === "error")).toBe(false);
    });

    it("model error after the model already produced tool calls: still recovers", async () => {
      modelEmits([
        { type: "start" }, { type: "start-step" },
        { type: "tool-input-available", toolCallId: "m1", toolName: "parse_preferences", input: {} },
        { type: "tool-output-available", toolCallId: "m1", output: { missing: [] } },
        { type: "finish-step" }, { type: "start-step" },
        { type: "error", errorText: "503 overloaded" },
      ]);
      const chunks = await readStream(await POST(request({ messages: [formMessage] })));
      expect(chunks.some((c) => c.type === "tool-output-available" && c.output?.itinerary)).toBe(true);
      expect(chunks.at(-1).type).toBe("finish");
    });

    it("no API key at all: runs on the built-in planner without ever calling the model", async () => {
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      const chunks = await readStream(await POST(request({ messages: [formMessage] })));
      expect(streamText).not.toHaveBeenCalled();
      expect(chunks[0].type).toBe("start");
      const texts = chunks.filter((c) => c.type === "text-delta").map((c) => c.delta as string);
      expect(texts[0]).toMatch(/key is not configured/i);
      expect(chunks.some((c) => c.type === "tool-output-available" && c.output?.itinerary)).toBe(true);
    });

    it("model fails and the request is missing details: shows the form instead of guessing", async () => {
      modelEmits([{ type: "start" }, { type: "error", errorText: "quota" }]);
      const vague = { id: "u", role: "user", parts: [{ type: "text", text: "surprise me" }] };
      const chunks = await readStream(await POST(request({ messages: [vague] })));
      expect(chunks.some((c) => c.type === "tool-input-available" && c.toolName === "ask_user_preferences")).toBe(true);
    });

    it("model fails and the city does not exist: honest message, no plan", async () => {
      modelEmits([{ type: "start" }, { type: "error", errorText: "quota" }]);
      const bad = { ...formMessage, parts: [{ type: "text", text: "Plan my perfect Saturday. Here are my details:\n" + JSON.stringify({ city: "Zzzxqwland", budget: 1500, available_time: "3 hours" }) }] };
      const chunks = await readStream(await POST(request({ messages: [bad] })));
      expect(chunks.some((c) => c.type === "tool-output-available" && c.output?.itinerary)).toBe(false);
      const body = chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join(" ");
      expect(body).toMatch(/could not locate|couldn't find/i);
    });
  });

  describe("request guards", () => {
    it("rejects malformed JSON, missing messages and empty conversations with 400", async () => {
      for (const body of ["{not json", {}, { messages: "nope" }, { messages: [] }]) {
        const res = await POST(request(body));
        expect(res.status).toBe(400);
      }
    });

    it("rejects absurdly long conversations with 413", async () => {
      const many = Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, role: "user", parts: [{ type: "text", text: "hi" }] }));
      expect((await POST(request({ messages: many }))).status).toBe(413);
    });

    it("rate limits a single client at 12 requests per minute and does not affect others", async () => {
      modelEmits([{ type: "start" }, { type: "finish" }]);
      const ip = "203.0.113.9";
      const statuses: number[] = [];
      for (let i = 0; i < 14; i++) {
        modelEmits([{ type: "start" }, { type: "finish" }]);
        statuses.push((await POST(request({ messages: [formMessage] }, ip))).status);
      }
      expect(statuses.slice(0, 12).every((s) => s === 200)).toBe(true);
      expect(statuses.slice(12)).toEqual([429, 429]);
      modelEmits([{ type: "start" }, { type: "finish" }]);
      expect((await POST(request({ messages: [formMessage] }, "198.51.100.7"))).status).toBe(200);
    });
  });
});
