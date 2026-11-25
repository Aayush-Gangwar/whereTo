import { describe, expect, it } from "vitest";
import { estimateCost, schedulePlan, validatePlan, type ValidateInput } from "../lib/agent/plan";
import { northKm, place, req, world } from "./fixtures";

const H = (h: number) => h * 60;

/** Schedules the requests, then validates with sensible defaults that tests can override. */
function run(
  places: ReturnType<typeof world>,
  ids: string[],
  opts: { startMin?: number; people?: number; budget?: number; hours?: number; durations?: Record<string, number> } & Partial<ValidateInput> = {},
) {
  const startMin = opts.startMin ?? H(10);
  const people = opts.people ?? 1;
  const vehicles = Math.ceil(people / 4);
  const sched = schedulePlan({ requests: ids.map((id) => req(id, { duration_min: opts.durations?.[id] })), places, startMin, vehicles, lowWalking: opts.lowWalking });
  const cost = estimateCost(sched.stops, people, sched.travelCost, vehicles);
  const v = validatePlan({
    stops: sched.stops, places, budget: opts.budget ?? 2000, availableHours: opts.hours ?? 4, people, totalCost: cost.total,
    travelMinutes: sched.travelMinutes, startMin, vegetarian: opts.vegetarian, avoidCrowds: opts.avoidCrowds, lowWalking: opts.lowWalking, weather: opts.weather,
  });
  return { sched, cost, v };
}

const base = () =>
  world(
    place({ id: "park", category: "park", outdoor: true, cost: 0, durationMin: 60 }),
    place({ id: "museum", category: "museum", cost: 200, durationMin: 60, ...northKm(0.3) }),
    place({ id: "cafe", category: "cafe", cost: 300, durationMin: 45, veg: "yes", ...northKm(0.6) }),
  );

describe("schedulePlan", () => {
  it("lays stops out in order with travel between them", () => {
    const { sched } = run(base(), ["park", "museum", "cafe"]);
    expect(sched.stops.map((s) => s.placeId)).toEqual(["park", "museum", "cafe"]);
    expect(sched.stops[0].startMin).toBe(H(10));
    expect(sched.stops[1].startMin).toBeGreaterThan(sched.stops[0].endMin); // a travel gap exists
    expect(sched.stops[1].legFromPrev?.mode).toBe("walk");
    expect(sched.issues).toEqual([]);
  });

  it("adds the first leg when a start point is given and shifts the first stop later", () => {
    const places = base();
    const s = schedulePlan({ requests: [req("park")], places, startMin: H(10), start: { ...northKm(5) } });
    expect(s.stops[0].legFromPrev).toBeDefined();
    expect(s.stops[0].startMin).toBeGreaterThan(H(10));
    expect(s.travelMinutes).toBeGreaterThan(0);
  });

  it("uses a cab for long legs and multiplies the fare per vehicle for groups", () => {
    const places = world(place({ id: "a" }), place({ id: "b", ...northKm(6) }));
    const solo = schedulePlan({ requests: [req("a"), req("b")], places, startMin: H(10), vehicles: 1 });
    const group = schedulePlan({ requests: [req("a"), req("b")], places, startMin: H(10), vehicles: 2 });
    expect(solo.stops[1].legFromPrev?.mode).toBe("auto/cab");
    expect(group.travelCost).toBe(solo.travelCost * 2);
  });

  it("rejects ids the search tools never returned (no hallucinated places)", () => {
    const { sched, v } = run(base(), ["park", "does-not-exist"]);
    expect(sched.issues.join(" ")).toMatch(/Unknown place id "does-not-exist"/);
    expect(v.ok).toBe(false); // and only one real stop remains
  });

  it("rejects the same place twice", () => {
    const { sched } = run(base(), ["park", "park", "museum"]);
    expect(sched.issues.join(" ")).toMatch(/more than once/);
    expect(sched.stops).toHaveLength(2);
  });

  it("tolerates a short wait for opening but flags a long one", () => {
    const shortWait = run(world(place({ id: "a", opens: 10.25 }), place({ id: "b", ...northKm(0.2) })), ["a", "b"]);
    expect(shortWait.sched.issues).toEqual([]);
    expect(shortWait.sched.warnings.join(" ")).toMatch(/wait for opening/);
    const longWait = run(world(place({ id: "a", opens: 11 }), place({ id: "b", ...northKm(0.2) })), ["a", "b"]);
    expect(longWait.sched.issues.join(" ")).toMatch(/opens at 11:00/);
  });

  it("flags a visit that would run past closing time", () => {
    const { sched } = run(world(place({ id: "a", closes: 10.5, durationMin: 60 }), place({ id: "b" })), ["a", "b"]);
    expect(sched.issues.join(" ")).toMatch(/closes at 10:30/);
  });

  it("handles places that close after midnight", () => {
    const places = world(place({ id: "bar", opens: 18, closes: 24, durationMin: 90 }), place({ id: "walk", closes: 24, ...northKm(0.2) }));
    const { sched } = run(places, ["bar", "walk"], { startMin: H(21) });
    expect(sched.issues).toEqual([]);
  });

  it("clamps absurd visit lengths and says so", () => {
    const { sched } = run(base(), ["park", "museum"], { durations: { park: 1, museum: 5000 } });
    expect(sched.stops[0].endMin - sched.stops[0].startMin).toBe(15);
    expect(sched.stops[1].endMin - sched.stops[1].startMin).toBe(300);
    expect(sched.warnings.join(" ")).toMatch(/adjusted/);
  });
});

describe("estimateCost", () => {
  it("multiplies place costs by group size but not cab fares", () => {
    const { sched } = run(base(), ["park", "museum", "cafe"], { people: 3 });
    const c = estimateCost(sched.stops, 3, 100, 1);
    expect(c.per_person_places).toBe(500);
    expect(c.places).toBe(1500);
    expect(c.total).toBe(1600);
  });
});

describe("validatePlan: constraints exceeded", () => {
  it("passes a sensible plan", () => {
    const { v } = run(base(), ["park", "museum", "cafe"]);
    expect(v.ok).toBe(true);
    expect(v.issues).toEqual([]);
  });

  it("fails when the cost exceeds the budget, naming the overshoot and group size", () => {
    const { v } = run(base(), ["park", "museum", "cafe"], { budget: 400, people: 2 });
    expect(v.ok).toBe(false);
    expect(v.issues.join(" ")).toMatch(/exceeds budget INR 400/);
    expect(v.issues.join(" ")).toMatch(/for 2 people/);
  });

  it("allows spending exactly the budget, and warns about thin buffers instead of failing", () => {
    const exact = run(base(), ["museum", "cafe"], { budget: 500 }); // 200 + 300, walk legs are free
    expect(exact.cost.total).toBe(500);
    expect(exact.v.issues.filter((i) => /budget/.test(i))).toEqual([]);
    expect(exact.v.warnings.join(" ")).toMatch(/little buffer/);
  });

  it("fails when the plan is longer than the time available", () => {
    const { v } = run(base(), ["park", "museum", "cafe"], { hours: 2 });
    expect(v.issues.join(" ")).toMatch(/Plan runs/);
  });

  it("allows a small overrun inside the 10-minute tolerance", () => {
    const places = world(place({ id: "a", durationMin: 60 }), place({ id: "b", durationMin: 65, ...northKm(0.1) }));
    const { v } = run(places, ["a", "b"], { hours: 2 }); // ~128 min of 120
    expect(v.issues.filter((i) => /Plan runs/.test(i))).toEqual([]);
  });

  it("requires at least two stops", () => {
    const { v } = run(base(), ["park"]);
    expect(v.issues).toContain("Plan needs at least 2 stops.");
  });

  it("rejects an unrealistically packed plan", () => {
    const ps = Array.from({ length: 6 }, (_, i) => place({ id: `p${i}`, durationMin: 15, ...northKm(i * 0.1) }));
    const { v } = run(world(...ps), ps.map((p) => p.id), { hours: 2 });
    expect(v.issues.join(" ")).toMatch(/Too packed/);
  });

  it("with a zero budget only free plans pass", () => {
    const free = run(world(place({ id: "a" }), place({ id: "b", ...northKm(0.2) })), ["a", "b"], { budget: 0 });
    expect(free.v.ok).toBe(true);
    const paid = run(base(), ["park", "museum"], { budget: 0 });
    expect(paid.v.ok).toBe(false);
  });

  it("fails everything when no time is available", () => {
    const { v } = run(base(), ["park", "museum"], { hours: 0 });
    expect(v.ok).toBe(false);
  });
});

describe("validatePlan: diet, crowds, weather, comfort", () => {
  const food = (veg: "yes" | "only" | "no" | "unknown") =>
    world(place({ id: "a" }), place({ id: "f", category: "food", cost: 200, veg, ...northKm(0.2) }));

  it("rejects a non-vegetarian restaurant for a vegetarian", () => {
    expect(run(food("no"), ["a", "f"], { vegetarian: true }).v.issues.join(" ")).toMatch(/not vegetarian-friendly/);
  });
  it("only warns when vegetarian options are unconfirmed", () => {
    const { v } = run(food("unknown"), ["a", "f"], { vegetarian: true });
    expect(v.ok).toBe(true);
    expect(v.warnings.join(" ")).toMatch(/unconfirmed/);
  });
  it("accepts confirmed vegetarian places silently", () => {
    for (const veg of ["yes", "only"] as const) {
      const { v } = run(food(veg), ["a", "f"], { vegetarian: true });
      expect(v.issues).toEqual([]);
      expect(v.warnings.join(" ")).not.toMatch(/vegetarian/);
    }
  });
  it("ignores the diet check for non-vegetarians", () => {
    expect(run(food("no"), ["a", "f"], { vegetarian: false }).v.ok).toBe(true);
  });

  it("rejects crowded places only when the user wants to avoid crowds", () => {
    const crowded = world(place({ id: "a", crowd: "high" }), place({ id: "b", ...northKm(0.2) }));
    expect(run(crowded, ["a", "b"], { avoidCrowds: true }).v.issues.join(" ")).toMatch(/crowded/);
    expect(run(crowded, ["a", "b"], { avoidCrowds: false }).v.ok).toBe(true);
    const medium = world(place({ id: "a", crowd: "medium" }), place({ id: "b", ...northKm(0.2) }));
    expect(run(medium, ["a", "b"], { avoidCrowds: true }).v.ok).toBe(true);
  });

  const outdoors = () => world(place({ id: "a", outdoor: true }), place({ id: "b", ...northKm(0.2) }));
  it("rejects outdoor stops when rain is likely", () => {
    expect(run(outdoors(), ["a", "b"], { weather: { rainChance: 55, tempMax: 28 } }).v.issues.join(" ")).toMatch(/rain chance is 55%/);
  });
  it("allows outdoor stops just below the rain threshold and indoor stops in the rain", () => {
    expect(run(outdoors(), ["a", "b"], { weather: { rainChance: 54, tempMax: 28 } }).v.ok).toBe(true);
    const indoor = world(place({ id: "a", outdoor: false }), place({ id: "b", ...northKm(0.2) }));
    expect(run(indoor, ["a", "b"], { weather: { rainChance: 90, tempMax: 28 } }).v.ok).toBe(true);
  });
  it("warns about peak-heat outdoor visits and outdoor visits after dark", () => {
    const heat = run(outdoors(), ["a", "b"], { startMin: H(12), weather: { rainChance: 0, tempMax: 38 } });
    expect(heat.v.warnings.join(" ")).toMatch(/peak heat/);
    const dark = run(outdoors(), ["a", "b"], { startMin: H(18.5), weather: { rainChance: 0, tempMax: 25 } });
    expect(dark.v.warnings.join(" ")).toMatch(/after dark/);
  });

  it("warns when a 3h+ outing has no meal, but not for short ones", () => {
    const noMeal = world(place({ id: "a" }), place({ id: "b", ...northKm(0.2) }));
    expect(run(noMeal, ["a", "b"], { hours: 4 }).v.warnings.join(" ")).toMatch(/No meal/);
    expect(run(noMeal, ["a", "b"], { hours: 2.5 }).v.warnings.join(" ")).not.toMatch(/No meal/);
  });
  it("warns when travel dominates the plan", () => {
    const far = world(place({ id: "a", durationMin: 30 }), place({ id: "b", durationMin: 30, ...northKm(8) }));
    expect(run(far, ["a", "b"]).v.warnings.join(" ")).toMatch(/Travel is/);
  });
  it("suggests reserving for large groups", () => {
    expect(run(base(), ["park", "museum"], { people: 8, budget: 20000 }).v.warnings.join(" ")).toMatch(/reserve tables/);
  });
  it("warns about long walks for low-effort requests", () => {
    const places = world(place({ id: "a" }), place({ id: "b", ...northKm(0.9) }));
    const { v } = run(places, ["a", "b"], { lowWalking: false });
    const walky = run(places, ["a", "b"], { lowWalking: true });
    expect(v.warnings.join(" ")).not.toMatch(/low effort/);
    expect(walky.sched.stops[1].legFromPrev?.mode).toBe("auto/cab"); // low-walking switches long hops to a cab
  });
});
