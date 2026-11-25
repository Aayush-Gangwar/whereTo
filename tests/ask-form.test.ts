import { beforeEach, describe, expect, it, vi } from "vitest";
import { call, defaultProviders, newCtx } from "./mocks";
import { place } from "./fixtures";
import { statedIn } from "../lib/agent/prefs";
import { knownDetails, mergePrefill } from "../lib/agent/prefill";
import { makeTools } from "../lib/agent/tools";

vi.mock("../lib/agent/providers", async (orig) => {
  const actual = await orig<typeof import("../lib/agent/providers")>();
  return { ...actual, geocode: vi.fn(), saturdayWeather: vi.fn(), overpassPlaces: vi.fn(), nominatimPlaces: vi.fn(), geocodePlace: vi.fn(), nominatimCity: vi.fn() };
});
import * as prov from "../lib/agent/providers";

const text = (t: string, role: "user" | "assistant" = "user") => ({ id: Math.random().toString(36), role, parts: [{ type: "text", text: t }] }) as any;
const formMsg = (o: object = {}) =>
  text("Plan my perfect Saturday. Here are my details:\n" + JSON.stringify({ city: "Bangalore", budget: 300, available_time: "5 hours", start_time: "10:00", people: 1, mood: "bored", interests: ["food", "art", "walks"], constraints: ["vegetarian"], ...o }));

describe("statedIn: did the user write this number?", () => {
  it.each([
    ["yes 500 per budget.", 500, true],
    ["make it ₹2,500 please", 2500, true],
    ["500 rupees", 500, true],
    ["5000", 500, false], // inside a bigger number
    ["12.5 hours", 5, false],
    ["I have 6 hours", 6, true],
    ["no numbers here", 500, false],
    ["", 500, false],
  ])("%j contains %s: %s", (msg, n, expected) => expect(statedIn(msg, n)).toBe(expected));
  it("is false without a text or a number", () => {
    expect(statedIn(undefined, 5)).toBe(false);
    expect(statedIn("5", undefined)).toBe(false);
  });
});

describe("the form is pre-filled by the server", () => {
  it("knows the details from the submitted form even if the model passes no prefill at all", () => {
    const ctx = newCtx();
    const out = mergePrefill(undefined, ctx, [formMsg()]);
    expect(out).toMatchObject({ city: "Bangalore", budget: 300, available_time: "5 hours", people: 1, mood: "bored", interests: ["food", "art", "walks"], constraints: ["vegetarian"] });
  });

  it("the model can only add what the server does not know", () => {
    const out = mergePrefill({ budget: 99999, mood: "silly", start_location: "Indiranagar" }, newCtx(), [formMsg()]);
    expect(out.budget).toBe(300); // the user's value, not the model's
    expect(out.mood).toBe("bored");
    expect(out.start_location).toBe("Indiranagar"); // a gap, filled
  });

  it("a number the user just wrote in chat replaces the old one", () => {
    const ctx = newCtx();
    ctx.latestUserText = "yes 500 per budget.";
    expect(mergePrefill({ budget: 500 }, ctx, [formMsg(), text("yes 500 per budget.")]).budget).toBe(500);
    ctx.latestUserText = "something else";
    expect(mergePrefill({ budget: 500 }, ctx, [formMsg()]).budget).toBe(300); // not stated by the user: ignored
  });

  it("works when the model sent the prefill as a string", () => {
    const out = mergePrefill('{"start_location":"MG Road"}', newCtx(), [formMsg()]);
    expect(out.start_location).toBe("MG Road");
    expect(out.city).toBe("Bangalore");
  });

  it("uses what the parser understood when the request was free text", () => {
    const ctx = newCtx();
    ctx.prefs = { city: "Pune", budget: 1800, availableHours: 3, startHour: 17.5, people: 2, mood: "calm", interests: ["food"], constraints: ["vegetarian"], flags: { vegetarian: true, vegan: false, avoidCrowds: false, lowWalking: false, noAlcohol: false } };
    expect(knownDetails(ctx, [text("something calm in Pune tonight")])).toMatchObject({ city: "Pune", budget: 1800, available_time: "3 hours", start_time: "17:30", people: 2 });
  });

  it("answers the user gave in an earlier form carry over", () => {
    const answered = { id: "a", role: "assistant", parts: [{ type: "tool-ask_user_preferences", state: "output-available", input: {}, output: { city: "Pune", budget: 700 } }] } as any;
    expect(knownDetails(newCtx(), [formMsg(), answered])).toMatchObject({ city: "Pune", budget: 700 });
  });

  it("a rejected city is never offered back, so the user retypes it", () => {
    const ctx = newCtx();
    ctx.cityRejected = true;
    const out = mergePrefill({ reason: "x" }, ctx, [formMsg({ city: "abc" })]);
    expect(out.city).toBeUndefined();
    expect(out.budget).toBe(300); // everything else is kept
  });
});

describe("a clear instruction in chat can change the budget or time; an invented number cannot", () => {
  beforeEach(() => defaultProviders());
  const prefs = (o: object = {}) => ({ city: "Bangalore", budget: 300, availableHours: 5, startHour: 10, people: 1, mood: "", interests: [], constraints: [], flags: { vegetarian: false, vegan: false, avoidCrowds: false, lowWalking: false, noAlcohol: false }, ...o });

  async function build(budgetArg: number, latest: string) {
    const ctx = newCtx();
    ctx.prefs = prefs() as any;
    ctx.latestUserText = latest;
    const t = makeTools(ctx);
    const acts = await call(t, "get_activity_options", { city: "Bangalore", interests: ["art"] });
    const ids = acts.options.slice(0, 2).map((o: any) => o.id);
    const built = await call(t, "build_itinerary", { title: "t", budget_inr: budgetArg, stops: ids.map((id: string) => ({ place_id: id, why: "w" })) });
    return built.itinerary.totals.budget as number;
  }

  it("the number the user wrote is accepted", async () => expect(await build(500, "yes 500 per budget.")).toBe(500));
  it("a number the model made up is not", async () => expect(await build(900, "yes 500 per budget.")).toBe(300));
  it("without a new message the original stays", async () => expect(await build(500, "")).toBe(300));
});

describe("the food search", () => {
  beforeEach(() => defaultProviders());

  it("never searches below a realistic per-meal budget, and says so", async () => {
    const t = makeTools(newCtx());
    await call(t, "get_weather", { city: "Bangalore" });
    const out = await call(t, "get_food_options", { city: "Bangalore", budget_per_meal_inr: 20, vegetarian: true });
    expect(out.count).toBeGreaterThan(0);
    expect(out.notes.join(" ")).toMatch(/minimum realistic budget/);
  });

  it("when nothing fits at all it returns the cheapest few, clearly marked as over budget, not an empty list", async () => {
    vi.mocked(prov.overpassPlaces).mockResolvedValue([
      place({ id: "osm-a", name: "Grand Dining", category: "food", cost: 900, veg: "yes" }),
      place({ id: "osm-b", name: "Fine Table", category: "food", cost: 700, veg: "yes" }),
      place({ id: "osm-c", name: "Royal Court", category: "food", cost: 1200, veg: "yes" }),
      place({ id: "osm-d", name: "Steakhouse", category: "food", cost: 600, veg: "no" }),
    ]);
    const t = makeTools(newCtx());
    await call(t, "get_weather", { city: "Jaipur" });
    const out = await call(t, "get_food_options", { city: "Jaipur", budget_per_meal_inr: 150, vegetarian: true });
    expect(out.count).toBe(3);
    expect(out.options.map((o: any) => o.name)).not.toContain("Steakhouse"); // the diet still holds
    expect(out.notes.join(" ")).toMatch(/OVER that budget/);
    expect(out.options[0].cost_inr).toBeLessThanOrEqual(out.options[1].cost_inr);
  });
});
