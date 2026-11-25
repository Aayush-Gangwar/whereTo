import { CURATED, cityKey, geocode, nominatimCity, seedCityNear, type GeoResult } from "./providers";
import { closeName, norm, sameName } from "./text";
import type { Ctx } from "./trace";

export { norm, editDistance, sameName, closeName } from "./text";

export type CityResolution =
  | { status: "ok"; geo: GeoResult; match: "exact" | "close"; interpretedFrom?: string }
  | { status: "suggest"; suggestion: GeoResult } // a result exists but does not look like what was typed: ask the user
  | { status: "unknown" };

const fromNominatim = (c: { name: string; lat: number; lon: number; country: string }): GeoResult => ({
  lat: c.lat, lon: c.lon, name: c.name, tz: "auto", country: c.country, live: true, via: "nominatim",
});

/** Big enough that a same-named place abroad is probably what the user means (otherwise: ask OpenStreetMap too). */
const CONFIDENT_POPULATION = 100_000;

/**
 * Decides how far to trust a geocoder hit for the typed text.
 *   exact   seeded city / alias, or the text is the place's name: proceed silently
 *   close   a typo, or an independent second source names a settlement for it: proceed, and tell the user what was understood
 *   suggest the hit does not resemble the input (an airport code, say): do not plan, ask "did you mean X?"
 *   unknown nothing matched: ask again
 */
export async function resolveCity(input: string): Promise<CityResolution> {
  const typed = input.trim();
  if (!typed) return { status: "unknown" };

  // A small typo of a seeded city ("Delih", "Hyderbad") is corrected offline, before any geocoder can match some
  // other place that merely starts with the same letters.
  const near = CURATED[cityKey(typed)] ? null : seedCityNear(typed);
  const geo = await geocode(near ?? typed);
  if (!geo) return { status: "unknown" };
  if (near) return { status: "ok", geo, match: "close", interpretedFrom: typed };
  if (CURATED[cityKey(typed)]) return { status: "ok", geo, match: "exact" };

  if (sameName(typed, geo.name)) {
    // The name matches. A prominent place, an Indian one (this product's home market) or a hit from OpenStreetMap
    // itself is accepted; a small or unlisted place abroad that shares the name gets a second opinion.
    const confident = geo.country === "India" || geo.via === "nominatim" || (geo.population ?? 0) >= CONFIDENT_POPULATION;
    if (confident) return { status: "ok", geo, match: "exact" };
    try {
      const alt = await nominatimCity(typed);
      if (alt) {
        const g = fromNominatim(alt);
        return sameName(typed, g.name) ? { status: "ok", geo: g, match: "exact" } : { status: "ok", geo: g, match: "close", interpretedFrom: typed };
      }
    } catch {
      // OpenStreetMap unreachable, so a small place abroad cannot be told apart from the Indian place the user may mean: ask.
      return { status: "suggest", suggestion: geo };
    }
    return { status: "ok", geo, match: "exact" }; // OpenStreetMap knows no settlement by that name: the geocoder's hit stands
  }
  if (closeName(typed, geo.name)) return { status: "ok", geo, match: "close", interpretedFrom: typed };

  // The hit does not look like the input (an airport code, a toll gate...). Ask OpenStreetMap independently:
  // if it knows a settlement by that name, use it; if not, ask the user. A hit from Nominatim itself has no second opinion.
  if (geo.via !== "nominatim") {
    try {
      const alt = await nominatimCity(typed);
      if (alt) return { status: "ok", geo: fromNominatim(alt), match: "close", interpretedFrom: typed };
    } catch {
      // Nominatim unreachable: alternate names are usually long, codes and abbreviations short
      if (norm(typed).length >= 5) return { status: "ok", geo, match: "close", interpretedFrom: typed };
    }
  }
  return { status: "suggest", suggestion: geo };
}

/** One lookup per city per request: the pre-check, get_weather and the place searches all share it. */
export async function resolveCityCached(ctx: Ctx, input: string): Promise<CityResolution> {
  const key = norm(input);
  ctx.cityCache ??= new Map();
  // the promise is cached, so tools running in parallel share a single lookup instead of racing
  let pending = ctx.cityCache.get(key);
  if (!pending) {
    pending = resolveCity(input);
    ctx.cityCache.set(key, pending);
  }
  return pending;
}
