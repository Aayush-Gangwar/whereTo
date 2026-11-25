import { beforeEach, describe, expect, it, vi } from "vitest";
import { asSchema } from "ai";
import { makeTools } from "../lib/agent/tools";
import { resolveCityCached } from "../lib/agent/city";
import { formToRaw, normalizePrefs } from "../lib/agent/prefs";
import { call, defaultProviders, geo, newCtx } from "./mocks";

vi.mock("../lib/agent/providers", async (orig) => {
  const actual = await orig<typeof import("../lib/agent/providers")>();
  return { ...actual, geocode: vi.fn(), saturdayWeather: vi.fn(), overpassPlaces: vi.fn(), nominatimPlaces: vi.fn(), geocodePlace: vi.fn(), nominatimCity: vi.fn() };
});
import * as prov from "../lib/agent/providers";

describe("formToRaw: the submitted form in the shape the parser expects", () => {
  it("maps every field and skips empty ones", () => {
    expect(formToRaw({ city: "Pune", budget: 2500, available_time: "4 hours", start_time: "10:00", start_location: "FC Road", people: 2, mood: "calm", interests: ["food"], constraints: ["vegetarian"] })).toEqual({
      city: "Pune", budget_inr: 2500, available_time: "4 hours", start_time: "10:00", start_location: "FC Road", people: 2, mood: "calm", interests: ["food"], constraints: ["vegetarian"],
    });
    expect(formToRaw({ city: "", budget: 0, start_location: "", interests: "not-an-array" })).toEqual({});
  });

  it("round-trips into valid preferences", () => {
    const { prefs } = normalizePrefs(formToRaw({ city: "Pune", budget: 2500, available_time: "4 hours", start_time: "17:30", people: 4, constraints: ["no non-veg"] }));
    expect(prefs).toMatchObject({ city: "Pune", budget: 2500, availableHours: 4, startHour: 17.5, people: 4 });
    expect(prefs?.flags.vegetarian).toBe(true);
  });
});

describe("the first step runs several tools at once", () => {
  beforeEach(() => defaultProviders());

  it("parallel lookups of the same city share one request", async () => {
    vi.mocked(prov.geocode).mockImplementation(async () => { await new Promise((r) => setTimeout(r, 20)); return geo("Jaipur") as any; });
    const ctx = newCtx();
    const results = await Promise.all([resolveCityCached(ctx, "Jaipur"), resolveCityCached(ctx, "jaipur"), resolveCityCached(ctx, "  JAIPUR ")]);
    expect(prov.geocode).toHaveBeenCalledOnce();
    expect(results[0]).toBe(results[1]);
  });

  it("weather and both searches running together make a single forecast request and a single city lookup", async () => {
    const ctx = newCtx();
    const t = makeTools(ctx);
    const [w, a, f] = await Promise.all([
      call(t, "get_weather", { city: "Bangalore" }),
      call(t, "get_activity_options", { city: "Bangalore", interests: ["walks", "art"] }),
      call(t, "get_food_options", { city: "Bangalore", budget_per_meal_inr: 700, vegetarian: true }),
    ]);
    expect(w.error).toBeUndefined();
    expect(a.count).toBeGreaterThan(0);
    expect(f.count).toBeGreaterThan(0);
    expect(prov.saturdayWeather).toHaveBeenCalledOnce();
    expect(prov.geocode).toHaveBeenCalledOnce();
  });

  it("a slow forecast is still requested only once when weather and a search overlap", async () => {
    vi.mocked(prov.saturdayWeather).mockImplementation(async () => { await new Promise((r) => setTimeout(r, 60)); return { date: "2026-11-28", summary: "clear", tempMax: 30, rainChance: 5, outdoorOk: true }; });
    const t = makeTools(newCtx());
    await Promise.all([
      call(t, "get_weather", { city: "Bangalore" }),
      call(t, "get_activity_options", { city: "Bangalore", interests: ["art"] }),
      call(t, "get_food_options", { city: "Bangalore", budget_per_meal_inr: 600 }),
    ]);
    expect(prov.saturdayWeather).toHaveBeenCalledOnce();
  });

  it("rain is respected by the activity search even if it finishes before get_weather does", async () => {
    vi.mocked(prov.saturdayWeather).mockImplementation(async () => { await new Promise((r) => setTimeout(r, 30)); return { date: "2026-11-28", summary: "heavy rain, 85% chance", tempMax: 24, rainChance: 85, outdoorOk: false }; });
    const ctx = newCtx();
    const t = makeTools(ctx);
    const [, acts] = await Promise.all([
      call(t, "get_weather", { city: "Bangalore" }),
      call(t, "get_activity_options", { city: "Bangalore", interests: ["walks", "art", "music"] }),
    ]);
    expect(acts.options.every((o: any) => o.outdoor === false)).toBe(true);
    expect(acts.dropped_by_filters.join(" ")).toMatch(/weather/);
  });

  it("a failed forecast does not break the searches, and get_weather still degrades honestly", async () => {
    vi.mocked(prov.saturdayWeather).mockRejectedValue(new Error("open-meteo timeout"));
    const t = makeTools(newCtx());
    const [w, a] = await Promise.all([
      call(t, "get_weather", { city: "Bangalore" }),
      call(t, "get_activity_options", { city: "Bangalore", interests: ["art"] }),
    ]);
    expect(w.degraded).toBe(true);
    expect(a.count).toBeGreaterThan(0);
  });

  it("the outing window comes from the submitted form, so ranking works before parse_preferences has finished", async () => {
    const ctx = newCtx();
    ctx.formPrefs = { city: "Bangalore", budget: 3000, available_time: "4 hours", start_time: "17:30", interests: ["walks"] }; // set by the route
    const t = makeTools(ctx);
    await call(t, "get_weather", { city: "Bangalore" });
    const acts = await call(t, "get_activity_options", { city: "Bangalore", interests: ["walks", "art", "music"] });
    const names = acts.options.map((o: any) => o.name);
    expect(names).not.toContain("Cubbon Park"); // closes at 18:00: useless for a 17:30 start
    expect(acts.dropped_by_filters.join(" ")).toMatch(/closed during your window/);
  });
});

describe("the schemas the model reads are slim", () => {
  const tools: any = makeTools(newCtx());

  it("build_itinerary asks only for what the model decides: a title and the stops (plus optional cheaper or shorter)", () => {
    const json = tools.build_itinerary.inputSchema.jsonSchema;
    expect(Object.keys(json.properties).sort()).toEqual(["available_hours", "budget_inr", "stops", "title"]);
    expect(json.required.sort()).toEqual(["stops", "title"]);
    expect(Object.keys(json.properties.stops.items.properties).sort()).toEqual(["duration_min", "place_id", "trade_off", "why"]);
  });

  it("the whole tool set stays small", () => {
    const size = Object.values(tools).map((t: any) => JSON.stringify({ d: t.description, s: asSchema(t.inputSchema).jsonSchema })).join("").length;
    console.log("  tool definitions the model re-reads every step:", size, "characters, about", Math.round(size / 4), "tokens");
    expect(size).toBeLessThan(4200); // paid on every model step
  });

  it("ask_user_preferences accepts any prefill object without re-declaring every field", () => {
    const json: any = asSchema(tools.ask_user_preferences.inputSchema).jsonSchema;
    expect([json.properties.prefill.type].flat()).toContain("object");
    expect(Object.keys(json.properties).sort()).toEqual(["prefill", "reason", "suggestion"]);
  });
});
