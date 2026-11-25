import type { Place } from "../lib/types";

/** Builds a place with sensible defaults; override only what a test cares about. */
export const place = (o: Partial<Place> & { id: string }): Place => ({
  name: o.id,
  category: "park",
  lat: 12.97,
  lon: 77.59,
  cost: 0,
  durationMin: 60,
  crowd: "low",
  outdoor: false,
  opens: 6,
  closes: 22,
  veg: "unknown",
  tags: [],
  blurb: "",
  source: "curated",
  ...o,
});

export const world = (...ps: Place[]) => new Map(ps.map((p) => [p.id, p]));
export const req = (id: string, extra: { duration_min?: number } = {}) => ({ place_id: id, why: "test", ...extra });

/** Moves a point roughly north by `km` so tests control travel legs without real geography. */
export const northKm = (km: number) => ({ lat: 12.97 + km / 111, lon: 77.59 });
