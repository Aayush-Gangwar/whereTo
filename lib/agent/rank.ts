import type { Place } from "../types";
import { haversineKm } from "./providers";

/** The outing window: when the user sets off and for how long. */
export type Window = { startHour: number; availMin: number };

/**
 * Can this place be visited at all during the outing? It must still be open for a meaningful part of the window
 * and not open only after the window is nearly over. Deliberately generous: exact times are checked when scheduling.
 */
export function feasibleIn(p: Place, w: Window): boolean {
  const start = w.startHour * 60;
  return p.closes * 60 >= start + Math.min(w.availMin, 120) && p.opens * 60 <= start + w.availMin - 45;
}

/** Higher is better. Prefers quiet, close, well-described (seeded) and free-or-cheap places. */
export function scorePlace(p: Place, center: { lat: number; lon: number }, avoidCrowds: boolean): number {
  let s = 0;
  s += p.crowd === "low" ? 1.5 : p.crowd === "medium" ? 0.5 : avoidCrowds ? -4 : -1;
  s += p.cost === 0 ? 0.4 : 0;
  s += p.source === "curated" ? 0.6 : 0; // seeded places have reliable hours, diet and crowd data
  s -= haversineKm(center, p) * 0.5;
  return s;
}

export type RankOptions = { center: { lat: number; lon: number }; limit: number; avoidCrowds?: boolean; window?: Window };
export type Ranked = { places: Place[]; droppedInfeasible: string[]; relaxed: boolean };

/**
 * Orders candidates best-first and caps the list, keeping every category represented (round-robin) so each of the
 * user's interests has options. Places that cannot be visited in the window are dropped, unless that would leave
 * nothing, in which case the unfiltered list is used and `relaxed` is set.
 */
export function rankPlaces(list: Place[], o: RankOptions): Ranked {
  const droppedInfeasible: string[] = [];
  let pool = list;
  let relaxed = false;
  if (o.window) {
    const ok = list.filter((p) => feasibleIn(p, o.window!));
    if (ok.length) {
      list.filter((p) => !ok.includes(p)).forEach((p) => droppedInfeasible.push(`${p.name} (closed during your window)`));
      pool = ok;
    } else if (list.length) relaxed = true;
  }
  const byCategory = new Map<string, Place[]>();
  [...pool]
    .sort((a, b) => scorePlace(b, o.center, !!o.avoidCrowds) - scorePlace(a, o.center, !!o.avoidCrowds))
    .forEach((p) => byCategory.set(p.category, [...(byCategory.get(p.category) ?? []), p]));
  const out: Place[] = [];
  const queues = [...byCategory.values()];
  while (out.length < o.limit && queues.some((q) => q.length)) {
    for (const q of queues) {
      const next = q.shift();
      if (next && out.length < o.limit) out.push(next);
    }
  }
  // round-robin interleaves categories; present the strongest overall first
  out.sort((a, b) => scorePlace(b, o.center, !!o.avoidCrowds) - scorePlace(a, o.center, !!o.avoidCrowds));
  return { places: out, droppedInfeasible, relaxed };
}
