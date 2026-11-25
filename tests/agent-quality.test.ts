import { beforeEach, describe, expect, it, vi } from "vitest";
import { convertToModelMessages, isStepCount, streamText } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { makeTools } from "../lib/agent/tools";
import { rankPlaces, feasibleIn } from "../lib/agent/rank";
import { checkReasons } from "../lib/agent/claims";
import { viewBuild, viewOptions, viewPrefs, viewWeather } from "../lib/agent/model-view";
import { call, defaultProviders, newCtx } from "./mocks";
import { northKm, place } from "./fixtures";
import type { Stop } from "../lib/types";

vi.mock("../lib/agent/providers", async (orig) => {
  const actual = await orig<typeof import("../lib/agent/providers")>();
  return { ...actual, geocode: vi.fn(), saturdayWeather: vi.fn(), overpassPlaces: vi.fn(), nominatimPlaces: vi.fn(), geocodePlace: vi.fn(), nominatimCity: vi.fn() };
});

const stop = (o: Partial<Stop> = {}): Stop => ({
  placeId: "p", name: "Place", category: "park", lat: 0, lon: 0, startMin: 600, endMin: 660, cost: 0, why: "A nice park", crowd: "low", veg: "unknown", blurb: "", source: "curated", ...o,
});

describe("rankPlaces: best candidates first, within the outing window", () => {
  const center = { lat: 12.97, lon: 77.59 };
  const window = { startHour: 10, availMin: 240 };

  it("orders by quality: quiet, close, well-described places before crowded, far ones", () => {
    const list = [
      place({ id: "far-crowded", crowd: "high", ...northKm(9), source: "osm" }),
      place({ id: "near-quiet", crowd: "low", ...northKm(0.5), source: "curated" }),
      place({ id: "mid", crowd: "medium", ...northKm(3), source: "osm" }),
    ];
    expect(rankPlaces(list, { center, limit: 10 }).places.map((p) => p.id)).toEqual(["near-quiet", "mid", "far-crowded"]);
  });

  it("caps the list but keeps every category represented, so each interest has options", () => {
    const list = [
      ...Array.from({ length: 8 }, (_, i) => place({ id: `park${i}`, category: "park", crowd: "low", ...northKm(0.1 * i) })),
      place({ id: "museum", category: "museum", crowd: "high", ...northKm(5) }),
      place({ id: "music", category: "music", crowd: "high", ...northKm(6) }),
    ];
    const ids = rankPlaces(list, { center, limit: 5 }).places.map((p) => p.id);
    expect(ids).toHaveLength(5);
    expect(ids).toContain("museum");
    expect(ids).toContain("music");
  });

  it("drops places that cannot be visited in the window and says which", () => {
    const list = [
      place({ id: "ok", name: "Open All Day", opens: 8, closes: 20 }),
      place({ id: "closed", name: "Closes Early", opens: 6, closes: 10.5 }),
      place({ id: "late", name: "Opens Late", opens: 14, closes: 22 }),
    ];
    const r = rankPlaces(list, { center, limit: 10, window });
    expect(r.places.map((p) => p.id)).toEqual(["ok"]);
    expect(r.droppedInfeasible.join(" ")).toMatch(/Closes Early/);
    expect(r.droppedInfeasible.join(" ")).toMatch(/Opens Late/);
    expect(r.relaxed).toBe(false);
  });

  it("an evening start removes places that close at dusk", () => {
    const park = place({ id: "park", opens: 6, closes: 18 });
    expect(feasibleIn(park, { startHour: 17.5, availMin: 240 })).toBe(false);
    expect(feasibleIn(park, { startHour: 10, availMin: 240 })).toBe(true);
  });

  it("if nothing fits the window it relaxes instead of returning nothing", () => {
    const list = [place({ id: "a", opens: 6, closes: 9 }), place({ id: "b", opens: 6, closes: 9.5 })];
    const r = rankPlaces(list, { center, limit: 10, window });
    expect(r.places).toHaveLength(2);
    expect(r.relaxed).toBe(true);
  });

  it("works without a window (preferences not yet known)", () => {
    expect(rankPlaces([place({ id: "a" })], { center, limit: 3 }).places).toHaveLength(1);
    expect(rankPlaces([], { center, limit: 3, window }).places).toEqual([]);
  });
});

describe("checkReasons: reasons must not contradict the data", () => {
  it("passes honest reasons", () => {
    const r = checkReasons([stop({ why: "A shaded park for a gentle walk; matches your love of walks.", crowd: "low" })], 1);
    expect(r.issues).toEqual([]);
  });

  it("a crowded place cannot be called quiet", () => {
    for (const why of ["A quiet corner of the city", "Peaceful and uncrowded", "calm, low crowds"]) {
      expect(checkReasons([stop({ why, crowd: "high" })], 1).issues.join(" "), why).toMatch(/calls it quiet/);
    }
    expect(checkReasons([stop({ why: "A quiet corner", crowd: "low" })], 1).issues).toEqual([]);
  });

  it("a trade-off may legitimately warn about crowds", () => {
    const r = checkReasons([stop({ crowd: "high", why: "Iconic and worth seeing", tradeOff: "Busy at midday, so go early to avoid the crowds" })], 1);
    expect(r.issues).toEqual([]);
  });

  it("a priced place cannot be called free", () => {
    expect(checkReasons([stop({ cost: 300, why: "Entry is free and the garden is lovely" })], 1).issues.join(" ")).toMatch(/says it is free/);
    expect(checkReasons([stop({ cost: 0, why: "Entry is free" })], 1).issues).toEqual([]);
    // "free" in other senses is not a claim about the price
    expect(checkReasons([stop({ cost: 300, why: "A crowd-free, hassle-free evening" })], 1).issues).toEqual([]);
  });

  it("vegetarian claims are checked against the diet data", () => {
    const food = (o: Partial<Stop>) => stop({ category: "food", ...o });
    expect(checkReasons([food({ veg: "no", why: "Great vegetarian thali" })], 1).issues.join(" ")).toMatch(/claims vegetarian food/);
    const unknown = checkReasons([food({ veg: "unknown", why: "A pure vegetarian restaurant" })], 1);
    expect(unknown.issues).toEqual([]);
    expect(unknown.warnings.join(" ")).toMatch(/cannot confirm/);
    expect(checkReasons([food({ veg: "only", why: "A pure vegetarian restaurant" })], 1)).toEqual({ issues: [], warnings: [] });
  });

  it("rupee amounts must match the data (per person, or for the group, or the cab leg)", () => {
    const s = stop({ cost: 300, why: "Lunch for about ₹300 per person" });
    expect(checkReasons([s], 1).issues).toEqual([]);
    expect(checkReasons([stop({ cost: 300, why: "₹900 for the three of you" })], 3).issues).toEqual([]);
    expect(checkReasons([stop({ cost: 300, why: "Cheap at ₹120" })], 1).issues.join(" ")).toMatch(/mentions INR 120/);
    expect(checkReasons([stop({ cost: 300, why: "Costs Rs. 1,500" })], 1).issues.join(" ")).toMatch(/INR 1500/);
  });
});

describe("what the model sees: compact, fact-dense, same ids", () => {
  const options = {
    count: 2,
    source: "osm+curated",
    options: [
      { id: "cur-lodhi", name: "Lodhi Garden", category: "park", cost_inr: 0, duration_min: 75, crowd: "low", outdoor: true, veg: "unknown", hours: "05:00-20:00", area: "Lodhi Road", lat: 28.59312, lon: 77.21971, km_from_center: 3.1, note: "Tomb-dotted garden, Delhi's favourite stroll; calmer on weekday mornings and at dusk.", source: "curated" },
      { id: "osm-n9", name: "Cafe Nine", category: "cafe", cost_inr: 350, duration_min: 50, crowd: "medium", outdoor: false, veg: "yes", hours: "09:00-21:30", lat: 28.6, lon: 77.2, km_from_center: 1.2, note: "Cafe from OpenStreetMap.", source: "osm" },
    ],
  };

  it("lists one line per candidate with every decision-relevant fact and the id", () => {
    const text = viewOptions(options, "activities");
    expect(text).toMatch(/cur-lodhi \| Lodhi Garden \| park \| free \| 75m \| crowd:low \| outdoor \| 05:00-20:00 \| 3.1km/);
    expect(text).toMatch(/osm-n9 \| Cafe Nine \| cafe \| ₹350 \| 50m \| crowd:medium \| indoor \| veg:yes \| 09:00-21:30 \| 1.2km/);
  });

  it("drops what the model cannot use: coordinates, areas, generic OpenStreetMap blurbs, links", () => {
    const text = viewOptions(options, "activities");
    expect(text).not.toMatch(/28\.59|77\.2|lat|lon|Lodhi Road|from OpenStreetMap/);
    expect(text).toMatch(/Tomb-dotted garden/); // a seeded place's note is informative, so it is kept (shortened)
  });

  it("surfaces empty results, notes and filters instead of hiding them", () => {
    const text = viewOptions({ count: 0, empty: "No places found. Do not invent places.", notes: ["Few vegetarian places"], dropped_by_filters: ["X (crowded)"] }, "food");
    expect(text).toMatch(/EMPTY: No places found/);
    expect(text).toMatch(/Few vegetarian places/);
    expect(text).toMatch(/excluded: X \(crowded\)/);
  });

  it("errors, weather and preferences are one-liners that keep the instruction", () => {
    expect(viewOptions({ error: "city_not_found" }, "activities")).toMatch(/ERROR city_not_found/);
    expect(viewWeather({ error: "city_unclear", message: "Do not plan yet. Ask: Did you mean Albacete?" })).toMatch(/Do not plan yet/);
    expect(viewWeather({ city: "Delhi", country: "India", weather: "clear sky, 23C", outdoor_ok: true, saturday: "2026-11-28" })).toMatch(/WEATHER Delhi, India: clear sky.*outdoor_ok=true/);
    expect(viewPrefs({ prefs: null, missing: ["budget"], next: "Call ask_user_preferences" })).toMatch(/missing=budget[\s\S]*ask_user_preferences/);
  });

  it("the plan view carries issues, warnings, schedule and totals, which is all a repair needs", () => {
    const text = viewBuild({
      instruction: "VALIDATION FAILED. Fix every issue",
      itinerary: {
        people: 2,
        validation: { ok: false, issues: ["Plan runs 251 min but only 240 min are available."], warnings: ["No meal planned"] },
        stops: [{ startMin: 600, endMin: 660, name: "Lodhi Garden", placeId: "cur-lodhi", cost: 0 }, { startMin: 690, endMin: 750, name: "Cafe Nine", placeId: "osm-n9", cost: 350, legFromPrev: { mode: "auto/cab", minutes: 14, cost: 70 } }],
        totals: { cost: 770, budget: 2000, minutes: 251, availableMinutes: 240, travelMinutes: 14 },
      },
    });
    expect(text).toMatch(/ok=false/);
    expect(text).toMatch(/Plan runs 251 min/);
    expect(text).toMatch(/10:00-11:00 Lodhi Garden \(cur-lodhi\) free/);
    expect(text).toMatch(/\[auto\/cab 14m ₹70\]/);
    expect(text).toMatch(/cost ₹770 of ₹2,000; time 251m of 240m/);
    expect(text).toMatch(/VALIDATION FAILED/);
  });
});

describe("tools hand the model compact results and keep the full ones for the UI", () => {
  beforeEach(() => defaultProviders());

  it("every data tool defines a model view, and the full result is untouched", async () => {
    const ctx = newCtx();
    const t: any = makeTools(ctx);
    for (const name of ["parse_preferences", "get_weather", "get_activity_options", "get_food_options", "build_itinerary"]) expect(t[name].toModelOutput, name).toBeTypeOf("function");
    const weather = await call(makeTools(ctx), "get_weather", { city: "Bangalore" });
    expect(weather.center).toBeDefined(); // full structured result, for the UI and the saved conversation
    expect(weather._spans).toBeDefined();
  });

  it("a realistic search result shrinks by well over half for the model", async () => {
    const ctx = newCtx();
    const t = makeTools(ctx);
    await call(t, "get_weather", { city: "Bangalore" });
    const acts = await call(t, "get_activity_options", { city: "Bangalore", interests: ["walks", "art", "music"] });
    const food = await call(t, "get_food_options", { city: "Bangalore", budget_per_meal_inr: 700, vegetarian: true });
    const toModel = (name: string, out: any) => ((t as any)[name].toModelOutput({ toolCallId: "x", input: {}, output: out }) as any).value as string;
    const before = JSON.stringify(acts).length + JSON.stringify(food).length;
    const after = toModel("get_activity_options", acts).length + toModel("get_food_options", food).length;
    expect(after / before).toBeLessThan(0.4); // more than 60% smaller (characters track tokens closely)
    // and still names every candidate id the model may choose from
    for (const o of [...acts.options, ...food.options]) expect(toModel(o.category === "food" || o.category === "cafe" ? "get_food_options" : "get_activity_options", o.category === "food" || o.category === "cafe" ? food : acts)).toContain(o.id);
  });

  it("chat history is compacted the same way on later turns", async () => {
    const ctx = newCtx();
    const tools = makeTools(ctx);
    await call(tools, "get_weather", { city: "Bangalore" });
    const acts = await call(tools, "get_activity_options", { city: "Bangalore", interests: ["walks", "art"] });
    const ui: any[] = [{ id: "a", role: "assistant", parts: [{ type: "tool-get_activity_options", toolCallId: "c1", state: "output-available", input: {}, output: acts }] }];
    const full = JSON.stringify(await convertToModelMessages(ui)).length;
    const compact = JSON.stringify(await convertToModelMessages(ui, { tools: tools as any })).length;
    expect(compact).toBeLessThan(full * 0.45);
  });

  it("an unanswered tool call in the history (a form the user ignored) is dropped, not fatal", async () => {
    const ui: any[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "plan something" }] },
      { id: "a1", role: "assistant", parts: [{ type: "tool-ask_user_preferences", toolCallId: "c1", state: "input-available", input: { reason: "x" } }] },
      { id: "u2", role: "user", parts: [{ type: "text", text: "actually, Pune, 2000 rupees, 4 hours" }] },
    ];
    // by default the dangling call stays in the conversation, and a provider would reject a call that has no result
    const dangling = await convertToModelMessages(ui, { tools: makeTools(newCtx()) as any });
    expect(JSON.stringify(dangling)).toContain("ask_user_preferences");
    const ok = await convertToModelMessages(ui, { tools: makeTools(newCtx()) as any, ignoreIncompleteToolCalls: true });
    expect(JSON.stringify(ok)).not.toContain("ask_user_preferences");
    expect(ok.at(-1)?.role).toBe("user");
  });
});

describe("the user's own values are authoritative", () => {
  beforeEach(() => defaultProviders());
  const prefs = { city: "Bangalore", budget: 2000, availableHours: 4, startHour: 10, people: 2, mood: "", interests: ["food"], constraints: ["vegetarian"], flags: { vegetarian: true, vegan: false, avoidCrowds: true, lowWalking: false, noAlcohol: false } };

  it("form data overrides whatever the model re-typed in parse_preferences", async () => {
    const ctx = newCtx();
    ctx.formPrefs = { city: "Bangalore", budget: 2000, available_time: "4 hours", start_time: "10:00", people: 2, interests: ["food"], constraints: ["vegetarian"] };
    const out = await call(makeTools(ctx), "parse_preferences", { city: "Bangalore", budget_inr: 99999, available_time: "20 hours", people: 9, interests: ["nightclubs"], constraints: [] });
    expect(out.prefs).toMatchObject({ budget: 2000, availableHours: 4, people: 2, interests: ["food"], constraints: ["vegetarian"] });
    expect(ctx.prefs?.budget).toBe(2000);
  });

  it("without a form, the model's extraction is used (free text)", async () => {
    const ctx = newCtx();
    const out = await call(makeTools(ctx), "parse_preferences", { city: "Pune", budget_inr: 1500, available_time: "3 hours" });
    expect(out.prefs).toMatchObject({ city: "Pune", budget: 1500, availableHours: 3 });
  });

  async function build(extra: object, ctx = newCtx()) {
    ctx.prefs = prefs as any;
    ctx.places.set("p1", place({ id: "p1" }));
    ctx.places.set("p2", place({ id: "p2", ...northKm(0.2) }));
    const out = await call(makeTools(ctx), "build_itinerary", { title: "t", stops: [{ place_id: "p1", why: "A park" }, { place_id: "p2", why: "A walk" }], ...extra });
    return out.itinerary;
  }

  it("the model cannot raise the budget or the time, and is told why", async () => {
    const it = await build({ budget_inr: 50_000, available_hours: 12 });
    expect(it.totals.budget).toBe(2000);
    expect(it.totals.availableMinutes).toBe(240);
    expect(it.validation.warnings.join(" ")).toMatch(/Budget kept at your stated INR 2000/);
    expect(it.validation.warnings.join(" ")).toMatch(/Time kept at your stated 4h/);
  });

  it("the model can make a plan cheaper or shorter (that is feedback)", async () => {
    const it = await build({ budget_inr: 1200, available_hours: 3 });
    expect(it.totals.budget).toBe(1200);
    expect(it.totals.availableMinutes).toBe(180);
  });

  it("constraints the user set cannot be switched off; group size and start time come from the preferences", async () => {
    const it = await build({ vegetarian: false, avoid_crowds: false, people: 7, start_time: "03:00" });
    expect(it.flags).toMatchObject({ vegetarian: true, avoidCrowds: true });
    expect(it.people).toBe(2);
    expect(it.stops[0].startMin).toBe(10 * 60);
  });

  it("the model may omit the repeated parameters entirely (fewer output tokens)", async () => {
    const it = await build({});
    expect(it.totals.budget).toBe(2000);
    expect(it.people).toBe(2);
  });

  it("with no preferences and no parameters it asks for them instead of guessing", async () => {
    const ctx = newCtx();
    const out = await call(makeTools(ctx), "build_itinerary", { title: "t", stops: [{ place_id: "p1", why: "x" }] });
    expect(out.error).toBe("missing_parameters");
    expect(out.message).toMatch(/parse_preferences/);
  });

  it("a reason that contradicts the data fails validation, so the agent must rewrite it", async () => {
    const ctx = newCtx();
    ctx.prefs = prefs as any;
    ctx.places.set("p1", place({ id: "p1", name: "Busy Market", crowd: "high", cost: 200 }));
    ctx.places.set("p2", place({ id: "p2", name: "Cafe", ...northKm(0.2), category: "cafe", veg: "no" }));
    const lying = await call(makeTools(ctx), "build_itinerary", { title: "t", stops: [{ place_id: "p1", why: "A quiet place with free entry" }, { place_id: "p2", why: "Great vegetarian food" }] });
    expect(lying.itinerary.validation.ok).toBe(false);
    const text = lying.itinerary.validation.issues.join(" ");
    expect(text).toMatch(/Busy Market calls it quiet/);
    expect(text).toMatch(/Busy Market says it is free/);
    expect(text).toMatch(/Cafe claims vegetarian food/);
    expect(lying.instruction).toMatch(/VALIDATION FAILED/);
  });
});

describe("hallucinated ids are blocked at the schema, and still rejected by the tool", () => {
  beforeEach(() => defaultProviders());
  const idsInSchema = (ctx: ReturnType<typeof newCtx>) => {
    const json: any = (makeTools(ctx).build_itinerary as any).inputSchema.jsonSchema;
    return json.properties.stops.items.properties.place_id.enum as string[] | undefined;
  };

  it("before any search the schema has no enum; afterwards it lists exactly the returned ids", async () => {
    const ctx = newCtx();
    const t = makeTools(ctx);
    const schema = (t.build_itinerary as any).inputSchema;
    expect(schema.jsonSchema.properties.stops.items.properties.place_id.enum).toBeUndefined();
    await call(t, "get_weather", { city: "Bangalore" });
    const acts = await call(t, "get_activity_options", { city: "Bangalore", interests: ["walks"] });
    const food = await call(t, "get_food_options", { city: "Bangalore", budget_per_meal_inr: 700 });
    const expected = [...acts.options, ...food.options].map((o: any) => o.id).sort();
    expect([...(schema.jsonSchema.properties.stops.items.properties.place_id.enum as string[])].sort()).toEqual(expected);
    expect(idsInSchema(ctx)).toBeDefined();
  });

  it("the schema stays a valid object schema and validation still works", async () => {
    const ctx = newCtx();
    ctx.places.set("a", place({ id: "a" }));
    const schema = (makeTools(ctx).build_itinerary as any).inputSchema;
    expect(schema.jsonSchema.type).toBe("object");
    expect(schema.jsonSchema.required).toContain("stops");
    expect(typeof schema.validate).toBe("function");
  });

  it("an invented id that gets through anyway is still rejected as an issue", async () => {
    const ctx = newCtx();
    ctx.prefs = { city: "X", budget: 1000, availableHours: 3, startHour: 10, people: 1, mood: "", interests: [], constraints: [], flags: { vegetarian: false, vegan: false, avoidCrowds: false, lowWalking: false, noAlcohol: false } };
    ctx.places.set("a", place({ id: "a" }));
    const out = await call(makeTools(ctx), "build_itinerary", { title: "t", stops: [{ place_id: "a", why: "x" }, { place_id: "made-up", why: "y" }] });
    expect(out.itinerary.validation.issues.join(" ")).toMatch(/Unknown place id "made-up"/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A scripted "LLM" that reads only what the real model would read (the compact text) and drives the real SDK loop.
// ---------------------------------------------------------------------------------------------------------------

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } };
const toolStep = (calls: { name: string; input: object }[]) => ({
  stream: convertArrayToReadableStream<any>([
    { type: "stream-start", warnings: [] },
    ...calls.map((c, i) => ({ type: "tool-call", toolCallId: `${c.name}_${i}`, toolName: c.name, input: JSON.stringify(c.input) })),
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
  ]),
});
const textStep = (text: string) => ({
  stream: convertArrayToReadableStream<any>([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text }, { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  ]),
});

/** Every tool result the model has been shown so far, as the text it actually received. */
const toolTexts = (prompt: any[]) =>
  prompt.filter((m) => m.role === "tool").flatMap((m) => m.content).filter((p: any) => p.type === "tool-result").map((p: any) => (typeof p.output?.value === "string" ? p.output.value : JSON.stringify(p.output?.value ?? p.output)));

describe("end to end through the real SDK loop with a scripted model", () => {
  beforeEach(() => defaultProviders());

  async function runAgent(formPrefs: Record<string, unknown>) {
    const ctx = newCtx();
    ctx.formPrefs = formPrefs;
    const tools = makeTools(ctx);
    let n = 0;
    const model = new MockLanguageModelV4({
      doStream: async (opts: any) => {
        const step = n++;
        if (step === 0) {
          // sloppy extraction on purpose: the form data must win
          return toolStep([{ name: "parse_preferences", input: { city: "Bangalore", budget_inr: 99999, available_time: "9 hours" } }]);
        }
        if (step === 1) {
          return toolStep([
            { name: "get_weather", input: { city: "Bangalore" } },
            { name: "get_activity_options", input: { city: "Bangalore", interests: ["art", "walks"] } },
            { name: "get_food_options", input: { city: "Bangalore", budget_per_meal_inr: 600, vegetarian: true } },
          ]);
        }
        if (step === 2) {
          // choose ids the way a model would: by reading the table it was given
          const table = toolTexts(opts.prompt).join("\n").split("\n");
          const ids = table.map((l) => l.split(" | ")[0].trim()).filter((s) => /^(cur|osm)-/.test(s));
          const activity = ids.find((id) => !/mtr|dyu|koshys|vidyarthi|ctr|cafe/.test(id)) ?? ids[0];
          const food = ids.find((id) => /mtr|dyu|koshys|vidyarthi|ctr/.test(id)) ?? ids[1];
          return toolStep([{ name: "build_itinerary", input: { title: "Test day", budget_inr: 99999, stops: [{ place_id: activity, why: "Matches your interest in art" }, { place_id: food, why: "A relaxed meal break" }] } }]);
        }
        return textStep("Here is a calm plan.");
      },
    });
    const result = streamText({ model, tools, system: "s", prompt: "go", stopWhen: isStepCount(6) });
    const parts: any[] = [];
    for await (const p of result.stream as any) parts.push(p);
    return { ctx, model, parts };
  }

  const form = { city: "Bangalore", budget: 2500, available_time: "4 hours", start_time: "10:00", people: 1, interests: ["art", "walks"], constraints: ["vegetarian"] };

  it("completes with a valid plan, using the user's values rather than the model's sloppy ones", async () => {
    const { parts } = await runAgent(form);
    const built = parts.find((p) => p.type === "tool-result" && p.toolName === "build_itinerary");
    expect(built).toBeDefined();
    const it = built.output.itinerary;
    expect(it.totals.budget).toBe(2500); // not 99999
    expect(it.totals.availableMinutes).toBe(240); // not 9 hours
    expect(it.validation.ok).toBe(true);
    expect(parts.some((p) => p.type === "tool-error")).toBe(false);
  });

  it("the allowed place ids reach the model as an enum from the step after the search", async () => {
    const { model } = await runAgent(form);
    const enumAt = (i: number) => (model.doStreamCalls[i].tools as any[])?.find((t) => t.name === "build_itinerary")?.inputSchema?.properties?.stops?.items?.properties?.place_id?.enum;
    expect(enumAt(0)).toBeUndefined();
    expect(enumAt(1)).toBeUndefined(); // search is still running in this step
    expect(enumAt(2)?.length).toBeGreaterThan(3);
    expect(enumAt(3)).toEqual(enumAt(2));
  });

  it("the model is shown compact text, never coordinates, links or internal trace data", async () => {
    const { model } = await runAgent(form);
    const lastPrompt = toolTexts(model.doStreamCalls[3].prompt as any[]).join("\n");
    expect(lastPrompt).toMatch(/ACTIVITIES \(\d+\)/);
    expect(lastPrompt).toMatch(/PLAN ok=true/);
    expect(lastPrompt).not.toMatch(/"lat"|"lon"|mapsUrl|_spans|blurb|google\.com\/maps/);
  });

  it("the whole conversation the model reads stays small", async () => {
    const { model, parts } = await runAgent(form);
    const modelRead = JSON.stringify(model.doStreamCalls[3].prompt).length;
    const uiOutputs = parts.filter((p) => p.type === "tool-result").map((p) => JSON.stringify(p.output).length).reduce((a, b) => a + b, 0);
    expect(uiOutputs).toBeGreaterThan(modelRead * 0.4); // the UI keeps the full results (the trace needs them)
    const toolText = toolTexts(model.doStreamCalls[3].prompt as any[]).join("").length;
    expect(toolText).toBeLessThan(uiOutputs * 0.4); // the model's view of them is less than 40% of the full size
  });
});
