import { beforeEach, describe, expect, it, vi } from "vitest";
import { runFallback } from "../lib/agent/fallback";
import { WARNING_MARK } from "../lib/marks";
import { makeTools, seedFromHistory } from "../lib/agent/tools";
import type { Itinerary } from "../lib/types";
import { call, defaultProviders, geo, newCtx } from "./mocks";
import { place } from "./fixtures";

vi.mock("../lib/agent/providers", async (orig) => {
  const actual = await orig<typeof import("../lib/agent/providers")>();
  return { ...actual, geocode: vi.fn(), saturdayWeather: vi.fn(), overpassPlaces: vi.fn(), nominatimPlaces: vi.fn(), geocodePlace: vi.fn(), nominatimCity: vi.fn() };
});
import * as prov from "../lib/agent/providers";

const geoHit = (g: unknown) => vi.mocked(prov.geocode).mockResolvedValue(g as any);

describe("agent tools: understanding the city", () => {
  beforeEach(() => defaultProviders());

  it("a city that only looks like a match is not planned: city_unclear with a suggestion and clear instructions", async () => {
    geoHit(geo("Albacete", "Spain"));
    const ctx = newCtx();
    const out = await call(makeTools(ctx), "get_weather", { city: "abc" });
    expect(out.error).toBe("city_unclear");
    expect(out.suggestion).toEqual({ city: "Albacete", country: "Spain" });
    expect(out.message).toMatch(/Do not plan yet/);
    expect(out.message).toMatch(/Did you mean Albacete, Spain\?/);
    expect(out.message).toMatch(/ask_user_preferences/);
    expect(ctx.center).toBeUndefined(); // nothing downstream can run on a guessed city
    expect(prov.saturdayWeather).not.toHaveBeenCalled();
  });

  it("place searches refuse an unclear city as well", async () => {
    geoHit(geo("Albacete", "Spain"));
    const t = makeTools(newCtx());
    expect((await call(t, "get_activity_options", { city: "abc", interests: ["food"] })).error).toBe("city_not_found");
    expect((await call(t, "get_food_options", { city: "abc", budget_per_meal_inr: 500 })).error).toBe("city_not_found");
  });

  it("a typo proceeds, and the interpretation is recorded in the output, trace note and context", async () => {
    geoHit(geo("Jaipur"));
    const ctx = newCtx();
    const out = await call(makeTools(ctx), "get_weather", { city: "Jaipor" });
    expect(out.error).toBeUndefined();
    expect(out.interpreted_from).toBe("Jaipor");
    expect(out.city).toBe("Jaipur");
    expect((out._spans as any[]).find((s) => s.name === "get_weather").note).toMatch(/interpreted "Jaipor" as Jaipur, India/);
    expect(ctx.place).toEqual({ name: "Jaipur", country: "India", typed: "Jaipor" });
  });

  it("an exact city carries no interpretation", async () => {
    geoHit(geo("Jaipur"));
    const out = await call(makeTools(newCtx()), "get_weather", { city: "Jaipur" });
    expect(out.interpreted_from).toBeUndefined();
  });

  it("the plan states which place it is for", async () => {
    const ctx = newCtx();
    const t = makeTools(ctx);
    await call(t, "get_weather", { city: "bangalore" });
    ctx.places.set("p1", place({ id: "p1" }));
    ctx.places.set("p2", place({ id: "p2", lat: 12.971, lon: 77.591 }));
    const out = await call(t, "build_itinerary", { city: "bangalore", title: "t", budget_inr: 1000, available_hours: 3, start_time: "10:00", stops: [{ place_id: "p1", why: "w" }, { place_id: "p2", why: "w" }] });
    expect(out.itinerary.place).toMatchObject({ name: "Bengaluru", country: "India" });
  });

  it("the interpretation survives follow-up turns (restored from history)", () => {
    const ctx = newCtx();
    seedFromHistory(ctx, [{ role: "assistant", parts: [{ type: "tool-get_weather", state: "output-available", output: { city: "Jaipur", country: "India", interpreted_from: "Jaipor", center: { lat: 26.9, lon: 75.8 }, weather: "clear", rain_chance: 5, temp_max: 28, outdoor_ok: true } }] }]);
    expect(ctx.place).toEqual({ name: "Jaipur", country: "India", typed: "Jaipor" });
  });

  it("looks the city up once per request even though three tools ask for it", async () => {
    geoHit(geo("Jaipur"));
    const t = makeTools(newCtx());
    await call(t, "get_weather", { city: "Jaipur" });
    await call(t, "get_activity_options", { city: "Jaipur", interests: ["food"] });
    await call(t, "get_food_options", { city: "Jaipur", budget_per_meal_inr: 500 });
    expect(prov.geocode).toHaveBeenCalledOnce();
  });

  it("ask_user_preferences accepts a suggested city for the one-tap button", async () => {
    const schema = (makeTools(newCtx()).ask_user_preferences as any).inputSchema;
    const ok = async (v: unknown) => (await schema.validate(v)).success;
    expect(await ok({ reason: "Did you mean Albacete?", suggestion: { city: "Albacete", country: "Spain" } })).toBe(true);
    expect(await ok({ reason: "x" })).toBe(true);
    expect(await ok({ reason: "x", suggestion: null })).toBe(true); // null means "none"
    expect(await ok({ reason: "x", suggestion: { country: "Spain" } })).toBe(false);
  });
});

// ---------------------------------------------------------------- built-in planner

const form = (o: Record<string, unknown>): any => ({
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "Plan my perfect Saturday. Here are my details:\n" + JSON.stringify(o) }],
});
const typical = { city: "Bangalore", budget: 2500, available_time: "4 hours", start_time: "10:00", mood: "relaxed", interests: ["food", "art", "walks"], constraints: ["vegetarian"] };

async function plan(messages: any[], reason: string | null = "You exceeded your current quota") {
  const chunks: any[] = [];
  await runFallback(newCtx(), messages, (c) => chunks.push(c), reason);
  const calls = chunks.filter((c) => c.type === "tool-input-available").map((c) => ({ id: c.toolCallId, name: c.toolName, input: c.input }));
  const outputs = new Map(chunks.filter((c) => c.type === "tool-output-available").map((c) => [c.toolCallId, c.output]));
  const texts = chunks.filter((c) => c.type === "text-delta").map((c) => c.delta as string);
  const builds = calls.filter((c) => c.name === "build_itinerary").map((c) => outputs.get(c.id).itinerary as Itinerary);
  return { calls, outputs, texts, builds, final: builds.at(-1), body: texts.filter((t) => !t.startsWith(WARNING_MARK)).join("\n") };
}

describe("built-in planner: unclear and misspelled cities", () => {
  beforeEach(() => defaultProviders());

  it("a doubtful match (abc -> Albacete) asks 'did you mean' with a one-tap suggestion and plans nothing", async () => {
    geoHit(geo("Albacete", "Spain"));
    const r = await plan([form({ ...typical, city: "abc" })]);
    expect(r.builds).toHaveLength(0);
    expect(r.calls.map((c) => c.name)).toEqual(["parse_preferences", "get_weather", "ask_user_preferences"]);
    const ask = r.calls.find((c) => c.name === "ask_user_preferences")!;
    expect(ask.input.suggestion).toEqual({ city: "Albacete", country: "Spain" });
    expect(ask.input.prefill.city).toBe("");
    expect(ask.input.prefill.budget).toBe(2500);
    expect(r.outputs.has(ask.id)).toBe(false);
    expect(r.body).toContain(`I couldn't find a city called "abc". Did you mean Albacete, Spain?`);
    expect(prov.overpassPlaces).not.toHaveBeenCalled(); // no place searches on a guessed city
    expect(prov.nominatimPlaces).not.toHaveBeenCalled();
  });

  it("answering the reopened form continues with the corrected city", async () => {
    const answered = { id: "a", role: "assistant", parts: [{ type: "tool-ask_user_preferences", state: "output-available", output: { ...typical, city: "Bangalore" } }] };
    const r = await plan([form({ ...typical, city: "abc" }), answered as any]);
    expect(r.final?.validation.ok).toBe(true);
    expect(r.final!.place?.name).toBe("Bengaluru");
  });

  it("a typo is planned, and the plan says what it understood", async () => {
    geoHit(geo("Jaipur"));
    vi.mocked(prov.nominatimPlaces).mockImplementation(async (_lat, _lon, cats) =>
      (cats as string[]).flatMap((c, i) => [
        place({ id: `osm-n${c}1`, name: `${c} one`, category: c as any, source: "osm", cost: 100, lat: 26.9 + i * 0.002, lon: 75.78, opens: 9, closes: 21 }),
        place({ id: `osm-n${c}2`, name: `${c} two`, category: c as any, source: "osm", cost: 150, lat: 26.903 + i * 0.002, lon: 75.781, opens: 9, closes: 21 }),
      ]),
    );
    const r = await plan([form({ ...typical, city: "Jaipor", constraints: [] })]);
    expect(r.final?.validation.ok).toBe(true);
    expect(r.final!.place).toMatchObject({ name: "Jaipur", typed: "Jaipor" });
    expect(r.final!.title).toContain("Jaipur");
  });

  it("without a reason (input check, no AI involved) there is no built-in-planner notice", async () => {
    const r = await plan([form({ ...typical, city: "Zzzxqwland" })], null);
    expect(r.texts.some((t) => t.startsWith(WARNING_MARK))).toBe(false);
    expect(r.body).toContain("couldn't find");
  });

  it("with a reason the notice is still shown", async () => {
    const r = await plan([form({ ...typical, city: "Zzzxqwland" })], "quota exceeded");
    expect(r.texts[0].startsWith(WARNING_MARK)).toBe(true);
  });
});
