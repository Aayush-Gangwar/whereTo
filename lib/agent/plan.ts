import type { Leg, Place, Stop } from "../types";
import { haversineKm } from "./providers";
import { checkReasons } from "./claims";

/**
 * Pure planning logic: scheduling, costing and validation. No I/O, so it is unit-testable and shared by
 * the LLM agent (via the build_itinerary tool) and the built-in planner (which calls the same tool).
 */

export const mins = (h: number) => Math.round(h * 60);
export const fmt = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`;

export const MIN_VISIT = 15;
export const MAX_VISIT = 300;

export type StopRequest = { place_id: string; duration_min?: number; why: string; trade_off?: string };
export type Point = { lat: number; lon: number };

export type ScheduleInput = {
  requests: StopRequest[];
  places: Map<string, Place>;
  startMin: number;
  start?: Point | null;
  lowWalking?: boolean;
  vehicles?: number;
};
export type ScheduleResult = { stops: Stop[]; issues: string[]; warnings: string[]; travelMinutes: number; travelCost: number };

/** Orders the requested stops in time: travel legs, waits for opening, visit windows. Reports scheduling problems. */
export function schedulePlan(i: ScheduleInput): ScheduleResult {
  const issues: string[] = [];
  const warnings: string[] = [];
  const stops: Stop[] = [];
  const vehicles = i.vehicles ?? 1;
  const seen = new Set<string>();
  let cursor = i.startMin;
  let prev: Point | null = i.start ?? null;
  let fromStart = !!i.start;
  let travelMinutes = 0;
  let travelCost = 0;

  for (const s of i.requests) {
    const p = i.places.get(s.place_id);
    if (!p) {
      issues.push(`Unknown place id "${s.place_id}" - it was not returned by the search tools. Use only returned ids.`);
      continue;
    }
    if (seen.has(p.id)) {
      issues.push(`${p.name} appears more than once. Each place can be visited only once.`);
      continue;
    }
    seen.add(p.id);

    let leg: Leg | undefined;
    if (prev) {
      const km = +(haversineKm(prev, p) * 1.35).toFixed(1); // road distance is longer than the straight line
      const walk = km <= 1.0 && !i.lowWalking ? true : km <= 0.5;
      const m = walk ? Math.round((km / 4.5) * 60) : Math.round(8 + (km / 18) * 60);
      const cost = walk ? 0 : Math.round((40 + 16 * km) / 10) * 10 * vehicles;
      leg = {
        mode: walk ? "walk" : "auto/cab",
        km,
        minutes: Math.max(m, 3),
        cost,
        mapsUrl: `https://www.google.com/maps/dir/?api=1&origin=${prev.lat},${prev.lon}&destination=${p.lat},${p.lon}&travelmode=${walk ? "walking" : "driving"}`,
      };
      cursor += leg.minutes;
      travelMinutes += leg.minutes;
      travelCost += leg.cost;
      if (leg.minutes > 35) warnings.push(`${fromStart ? `Getting from your start point to ${p.name}` : `Leg to ${p.name}`} is ${leg.minutes} min - a long hop.`);
    }

    let st = cursor;
    if (st < p.opens * 60) {
      const wait = Math.round(p.opens * 60 - st);
      if (wait > 30) issues.push(`${p.name} opens at ${fmt(p.opens * 60)}, but you would arrive at ${fmt(st)} (${wait} min early). Reorder or pick another place.`);
      else warnings.push(`${p.name}: ${wait} min wait for opening.`);
      st = Math.round(p.opens * 60);
    }
    const asked = s.duration_min ?? p.durationMin;
    const dur = Math.min(MAX_VISIT, Math.max(MIN_VISIT, Number.isFinite(asked) ? asked : p.durationMin));
    if (dur !== asked) warnings.push(`${p.name}: visit length adjusted to ${dur} min (allowed ${MIN_VISIT} to ${MAX_VISIT}).`);
    const end = st + dur;
    if (end > p.closes * 60) issues.push(`${p.name} closes at ${fmt(p.closes * 60)} but the visit would end at ${fmt(end)}.`);

    stops.push({
      placeId: p.id, name: p.name, category: p.category, lat: p.lat, lon: p.lon,
      startMin: st, endMin: end, cost: p.cost, why: s.why, tradeOff: s.trade_off,
      crowd: p.crowd, veg: p.veg, blurb: p.blurb, source: p.source, wiki: p.wiki, legFromPrev: leg,
    });
    cursor = end;
    prev = p;
    fromStart = false;
  }
  return { stops, issues, warnings, travelMinutes, travelCost };
}

export type Cost = { people: number; per_person_places: number; places: number; travel: number; vehicles: number; total: number };

/** Place costs are per person; cab fares are per vehicle (already multiplied while scheduling). */
export function estimateCost(stops: Stop[], people: number, travelCost: number, vehicles: number): Cost {
  const perPerson = stops.reduce((t, s) => t + s.cost, 0);
  const places = perPerson * people;
  return { people, per_person_places: perPerson, places, travel: travelCost, vehicles, total: places + travelCost };
}

export type ValidateInput = {
  stops: Stop[];
  places: Map<string, Place>;
  budget: number;
  availableHours: number;
  people: number;
  totalCost: number;
  travelMinutes: number;
  startMin: number;
  vegetarian?: boolean;
  avoidCrowds?: boolean;
  lowWalking?: boolean;
  weather?: { rainChance: number; tempMax: number } | null;
};
export type Validation = { ok: boolean; issues: string[]; warnings: string[] };

/**
 * Hard rules the plan must satisfy (issues) and softer problems worth telling the user (warnings).
 * Issues send the agent back to repair the plan; warnings are surfaced in the UI and the summary.
 */
export function validatePlan(v: ValidateInput): Validation {
  const issues: string[] = [];
  const warnings: string[] = [];
  const availMin = mins(v.availableHours);
  const total = v.stops.length ? v.stops[v.stops.length - 1].endMin - v.startMin : 0;

  if (v.people >= 6) warnings.push(`Group of ${v.people}: call ahead to reserve tables and check group entry limits.`);
  if (v.stops.length < 2) issues.push("Plan needs at least 2 stops.");
  if (total > availMin + 10) issues.push(`Plan runs ${Math.round(total)} min but only ${availMin} min are available. Remove a stop or shorten durations.`);

  if (v.totalCost > v.budget) {
    issues.push(`Estimated cost INR ${v.totalCost}${v.people > 1 ? ` for ${v.people} people` : ""} exceeds budget INR ${v.budget} by INR ${v.totalCost - v.budget}. Swap for cheaper/free options.`);
  } else if (v.totalCost > v.budget * 0.9) {
    warnings.push(`Uses ${Math.round((v.totalCost / v.budget) * 100)}% of budget - little buffer.`);
  }

  if (v.stops.length > Math.ceil(v.availableHours * 1.25) + 1) issues.push(`Too packed: ${v.stops.length} stops in ${v.availableHours}h is unrealistic.`);
  if (v.availableHours >= 3 && !v.stops.some((s) => s.category === "food" || s.category === "cafe")) warnings.push("No meal or cafe stop planned for a 3h+ outing.");
  if (total > 0 && v.travelMinutes > total * 0.3) warnings.push(`Travel is ${Math.round((v.travelMinutes / Math.max(total, 1)) * 100)}% of the plan; consider a tighter area.`);

  for (const s of v.stops) {
    const p = v.places.get(s.placeId);
    if (v.vegetarian && (s.category === "food" || s.category === "cafe")) {
      if (s.veg === "no") issues.push(`${s.name} is not vegetarian-friendly.`);
      else if (s.veg === "unknown") warnings.push(`${s.name}: vegetarian options unconfirmed - verify the menu.`);
    }
    if (p?.outdoor && s.endMin > 19 * 60) warnings.push(`${s.name} is outdoors and the visit runs past 7pm (after dark).`);
    if (v.avoidCrowds && s.crowd === "high") issues.push(`${s.name} is typically crowded; user wants to avoid crowds.`);
    if (v.weather && p?.outdoor) {
      if (v.weather.rainChance >= 55) issues.push(`${s.name} is outdoors and rain chance is ${v.weather.rainChance}%.`);
      else if (v.weather.tempMax >= 34 && s.startMin >= 690 && s.startMin <= 960) warnings.push(`${s.name} is outdoors in peak heat (${v.weather.tempMax}°C); go earlier or later.`);
    }
    if (v.lowWalking && s.legFromPrev?.mode === "walk" && s.legFromPrev.minutes > 10) warnings.push(`Walk to ${s.name} is ${s.legFromPrev.minutes} min while user wants low effort.`);
  }
  const claims = checkReasons(v.stops, v.people);
  issues.push(...claims.issues);
  warnings.push(...claims.warnings);
  return { ok: issues.length === 0, issues, warnings };
}
