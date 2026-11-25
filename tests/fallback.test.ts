import { beforeEach, describe, expect, it, vi } from "vitest";
import { runFallback } from "../lib/agent/fallback";
import { WARNING_MARK } from "../lib/marks";
import type { Itinerary } from "../lib/types";
import { defaultProviders, newCtx, RAINY } from "./mocks";
import { place } from "./fixtures";

vi.mock("../lib/agent/providers", async (orig) => {
  const actual = await orig<typeof import("../lib/agent/providers")>();
  return { ...actual, geocode: vi.fn(), saturdayWeather: vi.fn(), overpassPlaces: vi.fn(), nominatimPlaces: vi.fn(), geocodePlace: vi.fn(), nominatimCity: vi.fn() };
});
import * as prov from "../lib/agent/providers";

type Form = Record<string, unknown>;
const form = (o: Form): any => ({
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "Plan my perfect Saturday. Here are my details:\n" + JSON.stringify(o) }],
});
const feedback = (text: string): any => ({ id: `f${Math.random()}`, role: "user", parts: [{ type: "text", text: "[feedback] " + text }] });
const assistant = (): any => ({ id: "a1", role: "assistant", parts: [{ type: "text", text: "ok" }] });

/** Runs the built-in planner and collects what it streamed. */
async function plan(messages: any[], reason = "You exceeded your current quota") {
  const chunks: any[] = [];
  await runFallback(newCtx(), messages, (c) => chunks.push(c), reason);
  const calls = chunks.filter((c) => c.type === "tool-input-available").map((c) => ({ id: c.toolCallId, name: c.toolName, input: c.input }));
  const outputs = new Map(chunks.filter((c) => c.type === "tool-output-available").map((c) => [c.toolCallId, c.output]));
  const texts = chunks.filter((c) => c.type === "text-delta").map((c) => c.delta as string);
  const builds = calls.filter((c) => c.name === "build_itinerary").map((c) => outputs.get(c.id).itinerary as Itinerary);
  return { chunks, calls, outputs, texts, builds, final: builds.at(-1), body: texts.filter((t) => !t.startsWith(WARNING_MARK)).join("\n") };
}

const typical = { city: "Bangalore", budget: 2500, available_time: "4 hours", start_time: "10:00", mood: "relaxed", interests: ["food", "art", "walks"], constraints: ["vegetarian", "avoid crowded places"] };

describe("built-in planner (no LLM)", () => {
  beforeEach(() => defaultProviders());

  it("announces itself once, first, as a warning callout with the right reason", async () => {
    const r = await plan([form(typical)], "You exceeded your current quota");
    expect(r.texts[0].startsWith(WARNING_MARK)).toBe(true);
    expect(r.texts[0]).toMatch(/quota is reached/i);
    expect(r.texts.filter((t) => t.startsWith(WARNING_MARK))).toHaveLength(1);
    const noKey = await plan([form(typical)], "API key not configured");
    expect(noKey.texts[0]).toMatch(/key is not configured/i);
  });

  describe("happy path", () => {
    it("produces a valid plan that satisfies every stated constraint, using only places the tools returned", async () => {
      const r = await plan([form(typical)]);
      const it = r.final!;
      expect(it.validation.ok).toBe(true);
      expect(r.builds.length).toBeLessThanOrEqual(3);
      expect(it.stops.length).toBeGreaterThanOrEqual(2);
      expect(it.totals.cost).toBeLessThanOrEqual(2500);
      expect(it.totals.minutes).toBeLessThanOrEqual(4 * 60 + 10);
      expect(it.stops.every((s) => s.crowd !== "high")).toBe(true); // avoid crowds
      expect(it.stops.filter((s) => s.category === "food" || s.category === "cafe").every((s) => s.veg !== "no")).toBe(true);
      // grounding: every stop came from a search tool result
      const returned = new Set<string>();
      for (const [id, out] of r.outputs) for (const o of (out as any).options ?? []) returned.add(o.id);
      expect(it.stops.every((s) => returned.has(s.placeId))).toBe(true);
    });

    it("includes a meal for a long outing and explains the stops", async () => {
      const it = (await plan([form(typical)])).final!;
      expect(it.stops.some((s) => s.category === "food" || s.category === "cafe")).toBe(true);
      expect(it.stops.every((s) => s.why.length > 10)).toBe(true);
    });

    it("works in every seeded city", async () => {
      for (const city of ["Bangalore", "Delhi", "Mumbai", "Pune", "Hyderabad", "Chennai", "Kolkata"]) {
        const r = await plan([form({ ...typical, city })]);
        expect(r.final, city).toBeDefined();
        expect(r.final!.validation.ok, `${city}: ${r.final?.validation.issues.join("; ")}`).toBe(true);
        expect(r.builds.length, `${city} needed repairs`).toBe(1); // good selection, not luck in the repair loop
      }
    });

    it("always begins with a place that is already open at the start time", async () => {
      for (const start of ["09:00", "10:00", "13:00"]) {
        const r = await plan([form({ ...typical, start_time: start })]);
        expect(r.builds.length, `${start} needed repairs`).toBe(1);
        const it = r.final!;
        expect(it.validation.ok, start).toBe(true);
        const [h, m] = start.split(":").map(Number);
        expect(it.stops[0].startMin).toBeGreaterThanOrEqual(h * 60 + m);
      }
    });
  });

  describe("time of day and group", () => {
    it("an evening start never schedules places that are already closed", async () => {
      const r = await plan([form({ ...typical, start_time: "17:30", people: 4, budget: 6000 })]);
      const it = r.final!;
      expect(it.validation.ok).toBe(true);
      expect(it.stops[0].startMin).toBeGreaterThanOrEqual(17 * 60 + 30);
      expect(it.people).toBe(4);
      expect(it.totals.cost).toBeLessThanOrEqual(6000);
    });

    it("includes the leg from the start point and warns when it cannot be found", async () => {
      const located = (await plan([form({ ...typical, start_location: "Indiranagar" })])).final!;
      expect(located.start?.name).toBe("Indiranagar");
      expect(located.stops[0].legFromPrev).toBeDefined();
      const lost = (await plan([form({ ...typical, start_location: "Zzz nowhere lane" })])).final!;
      expect(lost.start).toBeUndefined();
      expect(lost.validation.warnings.join(" ")).toMatch(/Could not locate/);
    });

    it("tells large groups to reserve", async () => {
      const it = (await plan([form({ ...typical, people: 8, budget: 20000 })])).final!;
      expect(it.validation.warnings.join(" ")).toMatch(/reserve tables/);
    });

    it("avoids outdoor stops when rain is forecast", async () => {
      defaultProviders({ weather: RAINY });
      const it = (await plan([form(typical)])).final!;
      expect(it.validation.ok).toBe(true);
      const outdoorIds = new Set<string>();
      // outdoor places were filtered out of the candidates, so none can appear in the plan
      for (const s of it.stops) expect(["park", "viewpoint"].includes(s.category)).toBe(false);
      expect(outdoorIds.size).toBe(0);
    });
  });

  describe("failure cases", () => {
    it("unknown city: says so, plans nothing, and never invents places", async () => {
      const r = await plan([form({ ...typical, city: "Zzzxqwland" })]);
      expect(r.builds).toHaveLength(0);
      expect(r.calls.map((c) => c.name)).toEqual(["parse_preferences", "get_weather", "ask_user_preferences"]); // stops after the failed lookup and reopens the form
      const ask = r.calls.find((c) => c.name === "ask_user_preferences")!;
      expect(r.outputs.has(ask.id)).toBe(false); // waits for the human
      expect(ask.input.prefill.city).toBe("");
      expect(ask.input.prefill.budget).toBe(2500); // the rest of their answers are kept
      expect(r.body).toContain(`couldn't find "Zzzxqwland"`);
      expect(r.body).toMatch(/Bangalore, Delhi/); // suggests where the data is richest
      expect(r.body).not.toMatch(/ask the user|known demo city/i); // the LLM-facing wording must not leak
    });

    it("missing details: shows the in-chat form instead of guessing", async () => {
      const r = await plan([form({ city: "Pune", mood: "bored" })]);
      expect(r.builds).toHaveLength(0);
      const ask = r.calls.find((c) => c.name === "ask_user_preferences");
      expect(ask).toBeDefined();
      expect(r.outputs.has(ask!.id)).toBe(false); // no output: waits for the human
      expect(ask!.input.prefill.city).toBe("Pune");
    });

    it("free-text request with no usable details also asks for the form", async () => {
      const r = await plan([{ id: "u", role: "user", parts: [{ type: "text", text: "I want to do something fun this Saturday" }] }]);
      expect(r.calls.map((c) => c.name)).toEqual(["ask_user_preferences"]);
    });

    it("no places in a city without seed data and with live sources down: honest message", async () => {
      vi.mocked(prov.nominatimPlaces).mockRejectedValue(new Error("down"));
      const r = await plan([form({ ...typical, city: "Jaipur" })]);
      expect(r.builds).toHaveLength(0);
      expect(r.body).toMatch(/couldn't find enough matching places/i);
    });

    it("live data available for an unseeded city: plans from it", async () => {
      vi.mocked(prov.nominatimPlaces).mockImplementation(async (_lat, _lon, cats) =>
        (cats as string[]).flatMap((c, i) => [
          place({ id: `osm-n${c}1`, name: `${c} one`, category: c as any, source: "osm", cost: 100, lat: 26.9 + i * 0.002, lon: 75.78, opens: 9, closes: 21, veg: c === "food" || c === "cafe" ? "yes" : "unknown" }),
          place({ id: `osm-n${c}2`, name: `${c} two`, category: c as any, source: "osm", cost: 150, lat: 26.9 + i * 0.002 + 0.003, lon: 75.781, opens: 9, closes: 21, veg: c === "food" || c === "cafe" ? "yes" : "unknown" }),
        ]),
      );
      const r = await plan([form({ ...typical, city: "Jaipur", constraints: [] })]);
      expect(r.final?.validation.ok).toBe(true);
      expect(r.final!.stops.every((s) => s.source === "osm")).toBe(true);
    });

    it("uses the geocoder's proper city name in the plan title", async () => {
      const r = await plan([form({ ...typical, city: "bangalore" })]);
      expect(r.final!.title).toContain("Bengaluru");
    });

    it("a real city outside India still plans, but warns that prices are rough INR estimates", async () => {
      vi.mocked(prov.nominatimPlaces).mockImplementation(async (_lat, _lon, cats) =>
        (cats as string[]).flatMap((c, i) => [
          place({ id: `osm-n${c}1`, name: `${c} one`, category: c as any, source: "osm", cost: 100, lat: 48.85 + i * 0.002, lon: 2.35, opens: 9, closes: 21 }),
          place({ id: `osm-n${c}2`, name: `${c} two`, category: c as any, source: "osm", cost: 150, lat: 48.853 + i * 0.002, lon: 2.351, opens: 9, closes: 21 }),
        ]),
      );
      const r = await plan([form({ ...typical, city: "Paris", constraints: [] })]);
      expect(r.final?.validation.ok).toBe(true);
      expect(r.final!.validation.warnings.join(" ")).toMatch(/rough estimates.*France/);
    });

    it("a budget that cannot be met: honest best effort, never a plan claimed valid when it is not", async () => {
      const r = await plan([form({ ...typical, budget: 40 })]);
      const it = r.final;
      if (!it) {
        expect(r.body).toMatch(/couldn't/i);
        return;
      }
      if (it.validation.ok) {
        expect(it.totals.cost).toBeLessThanOrEqual(40);
        expect(r.body).not.toMatch(/couldn't fully satisfy/);
      } else {
        expect(r.body).toMatch(/couldn't fully satisfy/);
        expect(r.body).toContain(it.validation.issues[0]);
      }
    });

    it("an impossible time window: honest best effort", async () => {
      const r = await plan([form({ ...typical, available_time: "1 hour" })]);
      const it = r.final;
      if (it && !it.validation.ok) expect(r.body).toMatch(/couldn't fully satisfy/);
      if (it && it.validation.ok) expect(it.totals.minutes).toBeLessThanOrEqual(70);
    });

    it("live sources down, seed data used: still a valid plan", async () => {
      vi.mocked(prov.nominatimPlaces).mockRejectedValue(new Error("down"));
      const it = (await plan([form(typical)])).final!;
      expect(it.validation.ok).toBe(true);
      expect(it.stops.every((s) => s.source === "curated")).toBe(true);
    });

    it("weather API down: still plans (assumes fair weather)", async () => {
      defaultProviders({ weather: new Error("timeout") });
      expect((await plan([form(typical)])).final?.validation.ok).toBe(true);
    });

    it("absurd inputs do not crash it", async () => {
      for (const o of [
        { ...typical, people: 0 },
        { ...typical, people: 1e6 },
        { ...typical, budget: -5 },
        { ...typical, available_time: "99 hours" },
        { ...typical, start_time: "banana" },
        { ...typical, interests: [] },
        { ...typical, interests: ["quantum knitting"] },
      ]) {
        await expect(plan([form(o)])).resolves.toBeDefined();
      }
    });
  });

  describe("human feedback", () => {
    const first = async (extra: Form = {}) => (await plan([form({ ...typical, ...extra })])).final!;

    it("swap: removes the disliked place and still returns a valid plan", async () => {
      const before = await first();
      const victim = before.stops[0].name;
      const r = await plan([form(typical), assistant(), feedback(`I don't want "${victim}". Swap it for something else that fits my preferences.`)]);
      expect(r.final!.validation.ok).toBe(true);
      expect(r.final!.stops.map((s) => s.name)).not.toContain(victim);
    });

    it("keep: a liked place stays in the re-plan", async () => {
      const before = await first();
      const liked = before.stops[1].name;
      const r = await plan([form(typical), assistant(), feedback(`I like "${liked}" - keep it in the plan.`)]);
      expect(r.final!.stops.map((s) => s.name)).toContain(liked);
    });

    it("cheaper: costs no more than before, and respects the lower budget", async () => {
      const before = await first();
      const r = await plan([form(typical), assistant(), feedback("Make the plan cheaper")]);
      expect(r.final!.totals.cost).toBeLessThanOrEqual(before.totals.cost);
      expect(r.final!.totals.cost).toBeLessThanOrEqual(2500 * 0.7);
    });

    it("shorter: fits within about three hours", async () => {
      const r = await plan([form(typical), assistant(), feedback("Make it shorter, about 3 hours")]);
      expect(r.final!.totals.minutes).toBeLessThanOrEqual(3 * 60 + 10);
    });

    it("answers submitted through the in-chat form are used", async () => {
      const messages = [
        { id: "u", role: "user", parts: [{ type: "text", text: "plan something" }] },
        { id: "a", role: "assistant", parts: [{ type: "tool-ask_user_preferences", state: "output-available", output: { ...typical } }] },
      ];
      expect((await plan(messages as any)).final?.validation.ok).toBe(true);
    });
  });
});

describe("built-in planner: input normalisation matches the agent", () => {
  beforeEach(() => defaultProviders());
  const asks = async (o: Form) => (await plan([form(o)])).calls.map((c) => c.name);

  it.each([-5, 0])("a budget of %s asks for the form instead of planning", async (b) => {
    expect(await asks({ ...typical, budget: b })).toEqual(["ask_user_preferences"]);
  });

  it("caps absurd durations and group sizes", async () => {
    const r = await plan([form({ ...typical, available_time: "99 hours", people: 1e6, budget: 1e9 })]);
    expect(r.final!.totals.availableMinutes).toBe(16 * 60);
    expect(r.final!.people).toBe(50);
  });

  it("an unreadable start time falls back to 10:00", async () => {
    const r = await plan([form({ ...typical, start_time: "banana" })]);
    expect(r.final!.stops[0].startMin).toBeGreaterThanOrEqual(10 * 60);
    expect(r.final!.stops[0].startMin).toBeLessThan(11 * 60);
  });
});

describe("built-in planner: constraint detection matches the agent", () => {
  beforeEach(() => defaultProviders());
  const flagsFor = async (constraints: string[], mood = "relaxed") => (await plan([form({ ...typical, constraints, mood })])).final!.flags!;

  it("'non-vegetarian' is not vegetarian; 'no non-veg' and 'vegan' are", async () => {
    expect((await flagsFor(["non-vegetarian"])).vegetarian).toBe(false);
    expect((await flagsFor(["no non-veg"])).vegetarian).toBe(true);
    expect((await flagsFor(["vegan"])).vegetarian).toBe(true);
  });
  it("crowd preference and low effort are detected the same way", async () => {
    expect((await flagsFor(["avoid crowded places"])).avoidCrowds).toBe(true);
    expect((await flagsFor(["I don't mind crowds"])).avoidCrowds).toBe(false);
    expect((await flagsFor([], "tired but wants fun")).lowWalking).toBe(true);
  });
});

