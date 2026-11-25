import { beforeEach, describe, expect, it, vi } from "vitest";
import { lastAssistantMessageIsCompleteWithToolCalls, readUIMessageStream } from "ai";
import { shouldResumeAfterHuman } from "../lib/hitl";
import { runFallback } from "../lib/agent/fallback";
import { defaultProviders, geo, newCtx } from "./mocks";

vi.mock("../lib/agent/providers", async (orig) => {
  const actual = await orig<typeof import("../lib/agent/providers")>();
  return { ...actual, geocode: vi.fn(), saturdayWeather: vi.fn(), overpassPlaces: vi.fn(), nominatimPlaces: vi.fn(), geocodePlace: vi.fn(), nominatimCity: vi.fn() };
});
import * as prov from "../lib/agent/providers";

const msg = (role: string, parts: any[]) => ({ role, parts });
const ask = (state: string) => ({ type: "tool-ask_user_preferences", state, toolCallId: "t1", input: {}, ...(state === "output-available" ? { output: { city: "Pune" } } : {}) });

describe("shouldResumeAfterHuman: when the client sends the conversation back automatically", () => {
  it("resumes right after the human answered the in-chat form", () => {
    expect(shouldResumeAfterHuman({ messages: [msg("user", []), msg("assistant", [{ type: "text", text: "Did you mean X?" }, ask("output-available")])] })).toBe(true);
  });

  it("waits while the form is still unanswered", () => {
    expect(shouldResumeAfterHuman({ messages: [msg("assistant", [ask("input-available")])] })).toBe(false);
    expect(shouldResumeAfterHuman({ messages: [msg("assistant", [ask("input-streaming")])] })).toBe(false);
  });

  it("does not loop: once the resumed run appends anything after the answered form, it stops resuming", () => {
    const resumed = msg("assistant", [ask("output-available"), { type: "step-start" }, { type: "tool-get_weather", state: "output-available" }, { type: "text", text: "Here is your plan", state: "done" }]);
    expect(shouldResumeAfterHuman({ messages: [resumed] })).toBe(false);
  });

  it("ignores other answered tools, user messages and empty conversations", () => {
    expect(shouldResumeAfterHuman({ messages: [msg("assistant", [{ type: "tool-get_weather", state: "output-available" }])] })).toBe(false);
    expect(shouldResumeAfterHuman({ messages: [msg("user", [ask("output-available")])] })).toBe(false);
    expect(shouldResumeAfterHuman({ messages: [] })).toBe(false);
    expect(shouldResumeAfterHuman({ messages: [msg("assistant", [])] })).toBe(false);
  });
});

/** Streams what the server would send for this conversation and folds it into the assistant message the UI would hold. */
async function assistantMessageFor(messages: any[]) {
  const chunks: any[] = [{ type: "start" }, { type: "start-step" }];
  await runFallback(newCtx(), messages, (c) => chunks.push(c), null);
  chunks.push({ type: "finish-step" }, { type: "finish" });
  const stream = new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); } });
  let last: any;
  for await (const m of readUIMessageStream({ stream })) last = m;
  return last;
}

const form = (o: object): any => ({ id: "u1", role: "user", parts: [{ type: "text", text: "Plan my perfect Saturday. Here are my details:\n" + JSON.stringify(o) }] });
const typical = { city: "Bangalore", budget: 2500, available_time: "4 hours", start_time: "10:00", interests: ["food", "art"], constraints: [] };

describe("against real streamed output of the built-in planner", () => {
  beforeEach(() => defaultProviders());

  it("a finished plan never triggers another automatic send (the AI SDK's stock check would, forever)", async () => {
    const m = await assistantMessageFor([form(typical)]);
    expect(m.parts.some((p: any) => p.type === "tool-build_itinerary")).toBe(true);
    expect(lastAssistantMessageIsCompleteWithToolCalls({ messages: [m] as any })).toBe(true); // why the stock helper cannot be used
    expect(shouldResumeAfterHuman({ messages: [m] })).toBe(false);
  });

  it("a question to the user pauses; answering it resumes exactly once", async () => {
    vi.mocked(prov.geocode).mockResolvedValue(geo("Albacete", "Spain") as any);
    const m = await assistantMessageFor([form({ ...typical, city: "abc" })]);
    const askPart = m.parts.find((p: any) => p.type === "tool-ask_user_preferences");
    expect(askPart.state).toBe("input-available");
    expect(m.parts.at(-1)).toBe(askPart); // the form is the last thing in the message
    expect(shouldResumeAfterHuman({ messages: [m] })).toBe(false); // waiting for the human

    askPart.state = "output-available"; // the client records the answer
    askPart.output = { city: "Albacete" };
    expect(shouldResumeAfterHuman({ messages: [m] })).toBe(true);

    // the resumed run adds its parts after the form, so the rule turns false again
    m.parts.push({ type: "step-start" }, { type: "tool-get_weather", state: "output-available", toolCallId: "t2", input: {}, output: {} });
    expect(shouldResumeAfterHuman({ messages: [m] })).toBe(false);
  });
});
