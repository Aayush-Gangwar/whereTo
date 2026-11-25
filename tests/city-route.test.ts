import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WARNING_MARK } from "../lib/marks";
import { defaultProviders, geo } from "./mocks";

vi.mock("../lib/agent/providers", async (orig) => {
  const actual = await orig<typeof import("../lib/agent/providers")>();
  return { ...actual, geocode: vi.fn(), saturdayWeather: vi.fn(), overpassPlaces: vi.fn(), nominatimPlaces: vi.fn(), geocodePlace: vi.fn(), nominatimCity: vi.fn() };
});
vi.mock("ai", async (orig) => ({ ...(await orig<typeof import("ai")>()), streamText: vi.fn(), toUIMessageStream: vi.fn() }));
vi.mock("@ai-sdk/google", () => ({ createGoogleGenerativeAI: () => (id: string) => ({ modelId: id }) }));

import { streamText, toUIMessageStream } from "ai";
import * as prov from "../lib/agent/providers";
import { POST } from "../app/api/chat/route";

const details = { budget: 2500, available_time: "4 hours", start_time: "10:00", interests: ["food", "art"], constraints: ["vegetarian"] };
const formMessage = (city: string | null) => ({
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "Plan my perfect Saturday. Here are my details:\n" + JSON.stringify(city === null ? details : { city, ...details }) }],
});
const answeredForm = (city: string) => ({ id: "a1", role: "assistant", parts: [{ type: "tool-ask_user_preferences", state: "output-available", input: {}, output: { city, ...details } }] });
const feedbackMessage = { id: "f1", role: "user", parts: [{ type: "text", text: "[feedback] Make the plan cheaper" }] };

let ip = 0;
const send = async (messages: unknown[]) => {
  const res = await POST(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `172.16.0.${++ip}` }, body: JSON.stringify({ messages }) }));
  const text = await res.text();
  return { status: res.status, chunks: text.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6))) };
};
const modelWorks = () => {
  vi.mocked(streamText).mockReturnValue({ stream: "s" } as any);
  vi.mocked(toUIMessageStream).mockReturnValue(new ReadableStream({ start(c) { c.enqueue({ type: "start" }); c.enqueue({ type: "finish" }); c.close(); } }) as any);
};
const askCall = (chunks: any[]) => chunks.find((c) => c.type === "tool-input-available" && c.toolName === "ask_user_preferences");

describe("city input check before any model call", () => {
  beforeEach(() => {
    defaultProviders();
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";
    vi.mocked(streamText).mockReset();
    vi.mocked(toUIMessageStream).mockReset();
  });
  afterEach(() => {
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  });

  it("an unknown city never reaches the model: zero AI calls, the form reopens", async () => {
    const { chunks, status } = await send([formMessage("Zzzxqwland")]);
    expect(status).toBe(200);
    expect(streamText).not.toHaveBeenCalled();
    const ask = askCall(chunks);
    expect(ask).toBeDefined();
    expect(ask.input.prefill.city).toBe("");
    expect(ask.input.suggestion).toBeUndefined();
    const meta = chunks.find((c) => c.type === "message-metadata").messageMetadata.trace;
    expect(meta.model).toBe("input check (no AI call)");
    expect(meta.llm).toEqual([]);
    expect(chunks.at(-1).type).toBe("finish");
    expect(chunks.filter((c) => c.type === "start")).toHaveLength(1);
  });

  it("a doubtful city (abc -> Albacete) also never reaches the model and offers the suggestion", async () => {
    vi.mocked(prov.geocode).mockResolvedValue(geo("Albacete", "Spain") as any);
    const { chunks } = await send([formMessage("abc")]);
    expect(streamText).not.toHaveBeenCalled();
    expect(askCall(chunks).input.suggestion).toEqual({ city: "Albacete", country: "Spain" });
    const body = chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join(" ");
    expect(body).toContain("Did you mean Albacete, Spain?");
  });

  it("shows no 'built-in planner / AI unavailable' notice, because the AI was never the problem", async () => {
    const { chunks } = await send([formMessage("Zzzxqwland")]);
    expect(JSON.stringify(chunks)).not.toContain(WARNING_MARK);
    expect(JSON.stringify(chunks)).not.toMatch(/quota|AI key|AI model/i);
  });

  it("works the same with no API key configured", async () => {
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const { chunks } = await send([formMessage("Zzzxqwland")]);
    expect(askCall(chunks)).toBeDefined();
    expect(JSON.stringify(chunks)).not.toMatch(/key is not configured/i);
  });

  it("a known city goes straight on to the model", async () => {
    modelWorks();
    await send([formMessage("Bangalore")]);
    expect(streamText).toHaveBeenCalledOnce();
  });

  it("a typo is trusted and goes on to the model (the plan will say what was understood)", async () => {
    vi.mocked(prov.geocode).mockResolvedValue(geo("Jaipur") as any);
    modelWorks();
    await send([formMessage("Jaipor")]);
    expect(streamText).toHaveBeenCalledOnce();
  });

  it("looks the city up only once for a good request", async () => {
    modelWorks();
    await send([formMessage("Bangalore")]);
    expect(prov.geocode).toHaveBeenCalledOnce();
  });

  it("checks the answer to a reopened form: a corrected city goes on, another bad one stops again", async () => {
    modelWorks();
    await send([formMessage("abc"), answeredForm("Bangalore")]);
    expect(streamText).toHaveBeenCalledOnce();

    vi.mocked(streamText).mockClear();
    const { chunks } = await send([formMessage("abc"), answeredForm("Zzzxqwland")]);
    expect(streamText).not.toHaveBeenCalled();
    expect(askCall(chunks)).toBeDefined();
  });

  it("does not re-check on later turns (feedback, follow-ups): no lookup, normal flow", async () => {
    modelWorks();
    const plan = { id: "a", role: "assistant", parts: [{ type: "text", text: "Here is your plan" }] };
    await send([formMessage("Bangalore"), plan, feedbackMessage]);
    expect(prov.geocode).not.toHaveBeenCalled();
    expect(streamText).toHaveBeenCalledOnce();
  });

  it("a request without a city is left to the normal flow (the model or form asks for it)", async () => {
    modelWorks();
    await send([formMessage(null)]);
    expect(prov.geocode).not.toHaveBeenCalled();
    expect(streamText).toHaveBeenCalledOnce();
  });

  it("free-text requests are not checked up front; the tools handle their city", async () => {
    modelWorks();
    await send([{ id: "u", role: "user", parts: [{ type: "text", text: "something fun in abc this Saturday" }] }]);
    expect(prov.geocode).not.toHaveBeenCalled();
    expect(streamText).toHaveBeenCalledOnce();
  });
});
