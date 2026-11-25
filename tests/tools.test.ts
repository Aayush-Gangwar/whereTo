import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTools, seedFromHistory } from "../lib/agent/tools";
import { call, defaultProviders, FAIR, newCtx, RAINY } from "./mocks";
import { place } from "./fixtures";

vi.mock("../lib/agent/providers", async (orig) => {
  const actual = await orig<typeof import("../lib/agent/providers")>();
  return { ...actual, geocode: vi.fn(), saturdayWeather: vi.fn(), overpassPlaces: vi.fn(), nominatimPlaces: vi.fn(), geocodePlace: vi.fn(), nominatimCity: vi.fn() };
});
import * as prov from "../lib/agent/providers";

const spanStatuses = (out: any) => Object.fromEntries((out._spans as any[]).map((s) => [s.name, s.status]));

describe("agent tools (LLM mode contract)", () => {
  beforeEach(() => defaultProviders());

  describe("city not found", () => {
    it("get_weather reports city_not_found with guidance instead of guessing", async () => {
      const ctx = newCtx();
      const out = await call(makeTools(ctx), "get_weather", { city: "Zzzxqwland" });
      expect(out.error).toBe("city_not_found");
      expect(out.message).toMatch(/Do not plan/);
      expect(out.message).toMatch(/ask_user_preferences/);
      expect(ctx.center).toBeUndefined();
    });

    it("place searches refuse to run for an unknown city and return no options", async () => {
      const t = makeTools(newCtx());
      const acts = await call(t, "get_activity_options", { city: "Zzzxqwland", interests: ["walks"] });
      const food = await call(t, "get_food_options", { city: "Zzzxqwland", budget_per_meal_inr: 500 });
      expect(acts.error).toBe("city_not_found");
      expect(acts.options).toEqual([]);
      expect(food.error).toBe("city_not_found");
      expect(food.options).toEqual([]);
    });

    it("build_itinerary cannot schedule anything for an unknown city (no places registered)", async () => {
      const out = await call(makeTools(newCtx()), "build_itinerary", {
        city: "Zzzxqwland", title: "x", budget_inr: 1000, available_hours: 3, start_time: "10:00",
        stops: [{ place_id: "osm-n123", why: "x" }, { place_id: "osm-n456", why: "y" }],
      });
      expect(out.itinerary.validation.ok).toBe(false);
      expect(out.itinerary.stops).toHaveLength(0);
      expect(out.instruction).toMatch(/VALIDATION FAILED/);
    });
  });

  describe("data source failures degrade gracefully", () => {
    it("Overpass down: Nominatim takes over and the failure stays visible in the trace", async () => {
      vi.mocked(prov.nominatimPlaces).mockResolvedValue([place({ id: "osm-n1", name: "Live Park", category: "park", source: "osm", ...{ lat: 12.98, lon: 77.6 } })]);
      const ctx = newCtx();
      const t = makeTools(ctx);
      await call(t, "get_weather", { city: "Bangalore" });
      const out = await call(t, "get_activity_options", { city: "Bangalore", interests: ["walks"] });
      const names = out.options.map((o: any) => o.name);
      expect(names).toContain("Live Park");
      const st = spanStatuses(out);
      expect(st["overpass (primary OSM source)"]).toBe("fallback");
      expect(st["nominatim (fallback OSM source)"]).toBe("ok");
    });

    it("both live sources down: falls back to seed data and flags the tool as degraded", async () => {
      vi.mocked(prov.nominatimPlaces).mockRejectedValue(new Error("429 Too Many Requests"));
      const t = makeTools(newCtx());
      await call(t, "get_weather", { city: "Bangalore" });
      const out = await call(t, "get_activity_options", { city: "Bangalore", interests: ["art"] });
      expect(out.count).toBeGreaterThan(0);
      expect(out.options.every((o: any) => o.source === "curated")).toBe(true);
      expect(out.source).toBe("curated-fallback");
      expect(spanStatuses(out)["get_activity_options"]).toBe("fallback");
    });

    it("a city with no seed data and no live data returns an honest empty result, never invented places", async () => {
      vi.mocked(prov.nominatimPlaces).mockRejectedValue(new Error("down"));
      const t = makeTools(newCtx());
      await call(t, "get_weather", { city: "Jaipur" });
      const acts = await call(t, "get_activity_options", { city: "Jaipur", interests: ["walks"] });
      const food = await call(t, "get_food_options", { city: "Jaipur", budget_per_meal_inr: 500 });
      expect(acts.count).toBe(0);
      expect(acts.empty).toMatch(/do not invent places/i);
      expect(food.count).toBe(0);
      expect(food.empty).toBeDefined();
    });

    it("weather API down: assumes fair weather, says so, and keeps going", async () => {
      defaultProviders({ weather: new Error("open-meteo timeout") });
      const out = await call(makeTools(newCtx()), "get_weather", { city: "Bangalore" });
      expect(out.degraded).toBe(true);
      expect(out.outdoor_ok).toBe(true);
      expect(spanStatuses(out)["get_weather"]).toBe("fallback");
    });
  });

  describe("cities outside India", () => {
    const two = (ctx: ReturnType<typeof newCtx>) => {
      ctx.places.set("p1", place({ id: "p1", lat: 48.85, lon: 2.35 }));
      ctx.places.set("p2", place({ id: "p2", lat: 48.851, lon: 2.351 }));
    };
    const args = (city: string) => ({ city, title: "t", budget_inr: 2000, available_hours: 3, start_time: "10:00", stops: [{ place_id: "p1", why: "w" }, { place_id: "p2", why: "w" }] });

    it("warns that costs are rough INR-default estimates", async () => {
      const ctx = newCtx();
      const t = makeTools(ctx);
      await call(t, "get_weather", { city: "Paris" });
      two(ctx);
      const out = await call(t, "build_itinerary", args("Paris"));
      expect(out.itinerary.validation.warnings.join(" ")).toMatch(/rough estimates.*France/);
    });

    it("does not warn for Indian cities", async () => {
      const ctx = newCtx();
      const t = makeTools(ctx);
      await call(t, "get_weather", { city: "Bangalore" });
      two(ctx);
      const out = await call(t, "build_itinerary", args("Bangalore"));
      expect(out.itinerary.validation.warnings.join(" ")).not.toMatch(/rough estimates/);
    });

    it("keeps the warning on follow-up turns (country restored from history)", async () => {
      const ctx = newCtx();
      seedFromHistory(ctx, [{ role: "assistant", parts: [{ type: "tool-get_weather", state: "output-available", output: { city: "Paris", country: "France", center: { lat: 48.85, lon: 2.35 }, weather: "clear", rain_chance: 5, temp_max: 22, outdoor_ok: true } }] }]);
      two(ctx);
      const out = await call(makeTools(ctx), "build_itinerary", args("Paris"));
      expect(out.itinerary.validation.warnings.join(" ")).toMatch(/France/);
    });
  });

  describe("filters honour the user's constraints", () => {
    it("drops outdoor places when the forecast is rainy", async () => {
      defaultProviders({ weather: RAINY });
      const t = makeTools(newCtx());
      await call(t, "get_weather", { city: "Bangalore" });
      const out = await call(t, "get_activity_options", { city: "Bangalore", interests: ["walks", "art", "music"] });
      expect(out.options.every((o: any) => o.outdoor === false)).toBe(true);
      expect(out.dropped_by_filters.join(" ")).toMatch(/weather/);
    });

    it("drops crowded places when the user avoids crowds", async () => {
      const t = makeTools(newCtx());
      await call(t, "get_weather", { city: "Bangalore" });
      const out = await call(t, "get_activity_options", { city: "Bangalore", interests: ["shopping", "walks"], avoid_crowds: true });
      expect(out.options.some((o: any) => o.crowd === "high")).toBe(false);
    });

    it("returns only confirmed vegetarian food for vegetarians when enough exist", async () => {
      const t = makeTools(newCtx());
      await call(t, "get_weather", { city: "Bangalore" });
      const out = await call(t, "get_food_options", { city: "Bangalore", budget_per_meal_inr: 800, vegetarian: true });
      expect(out.options.length).toBeGreaterThan(1);
      expect(out.options.every((o: any) => o.veg === "only" || o.veg === "yes")).toBe(true);
    });

    it("flags unconfirmed vegetarian data instead of pretending, when OSM is all we have", async () => {
      vi.mocked(prov.nominatimPlaces).mockResolvedValue([
        place({ id: "osm-n9", name: "Unknown Diner", category: "food", cost: 300, veg: "unknown", source: "osm" }),
        place({ id: "osm-n8", name: "Mystery Cafe", category: "cafe", cost: 200, veg: "unknown", source: "osm" }),
      ]);
      const t = makeTools(newCtx());
      await call(t, "get_weather", { city: "Jaipur" });
      const out = await call(t, "get_food_options", { city: "Jaipur", budget_per_meal_inr: 600, vegetarian: true });
      expect(out.count).toBe(2);
      expect(out.notes.join(" ")).toMatch(/veg=unknown|confirm the menu/i);
    });

    it("respects the per-meal budget", async () => {
      const t = makeTools(newCtx());
      await call(t, "get_weather", { city: "Bangalore" });
      const out = await call(t, "get_food_options", { city: "Bangalore", budget_per_meal_inr: 250 });
      expect(out.options.every((o: any) => o.cost_inr <= 250 * 1.2)).toBe(true);
    });
  });

  describe("parse_preferences and the human-in-the-loop form", () => {
    it("tells the agent to ask the user when required fields are missing", async () => {
      const out = await call(makeTools(newCtx()), "parse_preferences", { city: "Pune", interests: ["food"] });
      expect(out.prefs).toBeNull();
      expect(out.missing).toEqual(["budget", "available_time"]);
      expect(out.next).toMatch(/ask_user_preferences/);
    });

    it("rejects a negative budget as missing rather than planning with it", async () => {
      const out = await call(makeTools(newCtx()), "parse_preferences", { city: "Pune", budget_inr: -100, available_time: "3 hours" });
      expect(out.missing).toEqual(["budget"]);
    });

    it("does not read 'non-vegetarian' as vegetarian", async () => {
      const out = await call(makeTools(newCtx()), "parse_preferences", { city: "Pune", budget_inr: 1000, available_time: "3h", constraints: ["non-vegetarian"] });
      expect(out.prefs.flags.vegetarian).toBe(false);
    });

    it("ask_user_preferences has no execute: the loop pauses for the human", () => {
      expect((makeTools(newCtx()).ask_user_preferences as any).execute).toBeUndefined();
    });
  });

  describe("build_itinerary: grounding, validation and the repair loop", () => {
    async function candidates(ctx = newCtx()) {
      const t = makeTools(ctx);
      await call(t, "get_weather", { city: "Bangalore" });
      const acts = await call(t, "get_activity_options", { city: "Bangalore", interests: ["art", "music", "walks"] });
      const food = await call(t, "get_food_options", { city: "Bangalore", budget_per_meal_inr: 800, vegetarian: true });
      return { t, ctx, acts: acts.options as any[], food: food.options as any[] };
    }
    const args = (stops: any[], extra: object = {}) => ({
      city: "Bangalore", title: "Test day", budget_inr: 2000, available_hours: 4, start_time: "10:00", stops, ...extra,
    });

    it("refuses place ids the model invented", async () => {
      const { t, acts } = await candidates();
      const out = await call(t, "build_itinerary", args([{ place_id: acts[0].id, why: "a" }, { place_id: "totally-made-up", why: "b" }]));
      expect(out.itinerary.validation.ok).toBe(false);
      expect(out.itinerary.validation.issues.join(" ")).toMatch(/Unknown place id "totally-made-up"/);
      expect(out.instruction).toMatch(/VALIDATION FAILED/);
    });

    it("scripted agent: over-budget draft fails, repaired draft passes", async () => {
      const { t, acts, food } = await candidates();
      const all = [...acts, ...food];
      const pricey = all.filter((p) => p.cost_inr >= 300).slice(0, 3);
      const first = await call(t, "build_itinerary", args(pricey.map((p) => ({ place_id: p.id, why: "w" })), { budget_inr: 400 }));
      expect(first.itinerary.validation.ok).toBe(false);
      expect(first.itinerary.validation.issues.join(" ")).toMatch(/exceeds budget/);
      expect(first.instruction).toMatch(/Fix every issue/);

      const cheap = all.filter((p) => p.cost_inr <= 100).slice(0, 2);
      const second = await call(t, "build_itinerary", args(cheap.map((p) => ({ place_id: p.id, why: "w" })), { budget_inr: 400 }));
      expect(second.itinerary.validation.ok).toBe(true);
      expect(second.instruction).toMatch(/Valid plan/);
    });

    it("scripted agent: a draft with a closed place is rejected until the stop is swapped", async () => {
      const { t, ctx, acts } = await candidates();
      const late = place({ id: "late-opener", name: "Late Opener", opens: 15, closes: 22, lat: 12.97, lon: 77.59 });
      ctx.places.set(late.id, late);
      const bad = await call(t, "build_itinerary", args([{ place_id: late.id, why: "w" }, { place_id: acts[0].id, why: "w" }]));
      expect(bad.itinerary.validation.issues.join(" ")).toMatch(/Late Opener opens at 15:00/);
    });

    it("reports unlocatable start points as a warning and still plans", async () => {
      const { t, acts, food } = await candidates();
      const out = await call(t, "build_itinerary", args([{ place_id: acts[0].id, why: "w" }, { place_id: food[0].id, why: "w" }], { start_location: "Zzzz nowhere lane" }));
      expect(out.itinerary.validation.warnings.join(" ")).toMatch(/Could not locate/);
      expect(out.itinerary.start).toBeUndefined();
      expect(spanStatuses(out)["geocode_start_location"]).toBe("fallback");
    });

    it("survives the geocoder being down", async () => {
      vi.mocked(prov.geocodePlace).mockRejectedValue(new Error("nominatim 429"));
      const { t, acts, food } = await candidates();
      const out = await call(t, "build_itinerary", args([{ place_id: acts[0].id, why: "w" }, { place_id: food[0].id, why: "w" }], { start_location: "Indiranagar" }));
      expect(out.itinerary.stops).toHaveLength(2);
      expect(out.itinerary.validation.warnings.join(" ")).toMatch(/Could not locate/);
    });

    it("adds the travel leg from a located start point", async () => {
      const { t, acts, food } = await candidates();
      const out = await call(t, "build_itinerary", args([{ place_id: acts[0].id, why: "w" }, { place_id: food[0].id, why: "w" }], { start_location: "Indiranagar" }));
      expect(out.itinerary.start?.name).toBe("Indiranagar");
      expect(out.itinerary.stops[0].legFromPrev).toBeDefined();
    });

    it("clamps absurd group sizes and durations instead of failing", async () => {
      const { t, acts, food } = await candidates();
      const out = await call(t, "build_itinerary", args([{ place_id: acts[0].id, why: "w" }, { place_id: food[0].id, why: "w" }], { people: 9999, available_hours: 400, budget_inr: 10_000_000 }));
      expect(out.itinerary.people).toBe(50);
      expect(out.itinerary.totals.availableMinutes).toBe(16 * 60);
      expect(out.itinerary.validation.warnings.join(" ")).toMatch(/adjusted to 16h/);
    });
  });

  describe("follow-up turns stay grounded (history seeding)", () => {
    const history = (hours: string) => [
      {
        role: "assistant",
        parts: [
          { type: "tool-get_weather", state: "output-available", output: { city: "Bangalore", center: { lat: 12.97, lon: 77.59 }, weather: FAIR.summary, rain_chance: 5, temp_max: 29, outdoor_ok: true } },
          {
            type: "tool-get_activity_options",
            state: "output-available",
            output: {
              options: [
                { id: "night-1", name: "Night Market", category: "market", cost_inr: 100, duration_min: 60, crowd: "low", outdoor: false, veg: "unknown", hours, lat: 12.971, lon: 77.591, source: "curated" },
                { id: "night-2", name: "Late Cafe", category: "cafe", cost_inr: 100, duration_min: 60, crowd: "low", outdoor: false, veg: "yes", hours, lat: 12.972, lon: 77.592, source: "curated" },
              ],
            },
          },
        ],
      },
    ];

    it("rebuilds the allowed places from earlier tool results", async () => {
      const ctx = newCtx();
      seedFromHistory(ctx, history("10:00-22:00"));
      expect(ctx.places.has("night-1")).toBe(true);
      expect(ctx.center?.city).toBe("Bangalore");
      expect(ctx.weather?.rainChance).toBe(5);
    });

    it("keeps places that close at midnight usable after the round trip (00:00 means 24:00)", async () => {
      const ctx = newCtx();
      seedFromHistory(ctx, history("18:00-00:00"));
      expect(ctx.places.get("night-1")?.closes).toBe(24);
      const out = await call(makeTools(ctx), "build_itinerary", {
        city: "Bangalore", title: "Late", budget_inr: 1000, available_hours: 3, start_time: "19:00",
        stops: [{ place_id: "night-1", why: "w" }, { place_id: "night-2", why: "w" }],
      });
      expect(out.itinerary.validation.issues).toEqual([]);
    });
  });
});

describe("get_weather when the primary geocoder is unavailable", () => {
  beforeEach(() => defaultProviders());

  it("works via the second geocoder and makes the fallback visible in the trace", async () => {
    vi.mocked(prov.geocode).mockResolvedValue({ lat: 26.9124, lon: 75.7873, name: "Jaipur", tz: "auto", country: "India", live: true, via: "nominatim" });
    const ctx = newCtx();
    const out = await call(makeTools(ctx), "get_weather", { city: "Jaipur" });
    expect(out.error).toBeUndefined();
    expect(out.geocoder).toBe("nominatim");
    expect(out.weather).toBeDefined(); // the forecast still ran
    expect(ctx.center?.lat).toBeCloseTo(26.9124);
    const span = (out._spans as any[]).find((s) => s.name === "get_weather");
    expect(span.status).toBe("fallback");
    expect(span.note).toMatch(/city lookup used nominatim/);
  });

  it("a fully resolved city is not marked as a fallback", async () => {
    const out = await call(makeTools(newCtx()), "get_weather", { city: "Bangalore" });
    expect(out.geocoder).toBe("open-meteo");
    expect((out._spans as any[]).find((s) => s.name === "get_weather").status).toBe("ok");
  });
});

describe("null for an optional field (some models do this)", () => {
  it("schemas accept null and the tools treat it as absent", async () => {
    const { dropNulls } = await import("../lib/agent/schema");
    expect(dropNulls({ a: null, b: 1, c: { d: null, e: [null, 2] } })).toEqual({ b: 1, c: { e: [null, 2] } });
    const tools: any = makeTools(newCtx());
    const out = await tools.parse_preferences.execute({ raw_text: null, city: "Pune", budget_inr: 2000, available_time: "4 hours", start_time: null, people: null, interests: null }, { toolCallId: "x", messages: [] });
    expect(out.missing ?? []).toEqual([]);
    expect(out.prefs?.city).toBe("Pune");
  });
});

describe("arguments a smaller model stringified", () => {
  it("numbers, arrays and 'None' sent as strings are repaired instead of failing the step", async () => {
    const tools: any = makeTools(newCtx());
    const r = await tools.parse_preferences.inputSchema.validate({
      raw_text: "None", city: "Bangalore", budget_inr: "2000", available_time: "4 hours", start_time: "10:00", start_location: "None",
      people: "1", mood: "tired but wants to do something fun", interests: '["food", "music", "walks"]', constraints: '["vegetarian", "avoid crowded places"]',
    });
    expect(r.success).toBe(true);
    expect(r.value).toEqual({ city: "Bangalore", budget_inr: 2000, available_time: "4 hours", start_time: "10:00", people: 1, mood: "tired but wants to do something fun", interests: ["food", "music", "walks"], constraints: ["vegetarian", "avoid crowded places"] });
  });

  it("works inside nested stops, and booleans", async () => {
    const tools: any = makeTools(newCtx());
    const r = await tools.build_itinerary.inputSchema.validate({ title: "t", budget_inr: "1500", stops: [{ place_id: "cur-x", why: "w", duration_min: "45" }] });
    expect(r.success).toBe(true);
    expect(r.value.budget_inr).toBe(1500);
    expect(r.value.stops[0].duration_min).toBe(45);
    const f: any = await tools.get_food_options.inputSchema.validate({ city: "Pune", vegetarian: "true", budget_per_meal_inr: "₹600" });
    expect(f.value).toMatchObject({ vegetarian: true, budget_per_meal_inr: 600 });
  });

  it("values that cannot be repaired still fail, and a required string is never dropped", async () => {
    const tools: any = makeTools(newCtx());
    expect((await tools.get_weather.inputSchema.validate({ city: "abc" })).success).toBe(true);
    expect((await tools.get_food_options.inputSchema.validate({ city: "Pune", budget_per_meal_inr: "lots" })).success).toBe(false);
    const r: any = await tools.get_weather.inputSchema.validate({ city: "None" });
    expect(r.success).toBe(true);
    expect(r.value.city).toBe("None"); // city is required: kept, and the city check handles it
  });
});
