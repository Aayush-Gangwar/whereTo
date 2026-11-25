import type { Category, Place } from "../types";
import { CURATED as BASE } from "../data/curated";
import { MORE_CITIES } from "../data/cities";
import { editDistance, norm, sameName, typoAllowance } from "./text";

export const CURATED = { ...BASE, ...MORE_CITIES };
export const curatedCityNames = Object.keys(CURATED);

const UA = { "User-Agent": "perfect-saturday-planner/1.0 (take-home demo)" };

async function getJson(url: string, ms = 8000, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    headers: { ...UA, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(ms),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
  return res.json();
}

const ALIASES: Record<string, string> = {
  bengaluru: "bangalore", "new delhi": "delhi", "delhi ncr": "delhi", ncr: "delhi", bombay: "mumbai",
  madras: "chennai", calcutta: "kolkata", poona: "pune",
};
export const cityKey = (c: string) => {
  const k = c.trim().toLowerCase().replace(/,.*$/, "");
  return ALIASES[k] ?? k;
};

/** Display name for a seeded city, matching what the geocoder calls it. */
export const seedName = (key: string) => (key === "bangalore" ? "Bengaluru" : key[0].toUpperCase() + key.slice(1));

/**
 * Typo correction against the seeded cities and their aliases ("Delih" -> delhi, "Hyderbad" -> hyderabad).
 * Pure and offline. Returns the seeded city key only when exactly one name is within the typo allowance.
 */
export function seedCityNear(typed: string): string | null {
  const t = norm(typed);
  const allowed = typoAllowance(t.length);
  if (!allowed) return null;
  const scored = [...Object.keys(CURATED), ...Object.keys(ALIASES)]
    .map((name) => ({ key: cityKey(name), d: editDistance(t, norm(name)) }))
    .filter((x) => x.d <= allowed)
    .sort((a, b) => a.d - b.d);
  if (!scored.length) return null;
  const best = scored.filter((x) => x.d === scored[0].d);
  return new Set(best.map((x) => x.key)).size === 1 ? best[0].key : null; // ambiguous typos are not guessed
}

export type GeoResult = { lat: number; lon: number; name: string; tz: string; country: string; live: boolean; population?: number; via: "open-meteo" | "nominatim" | "curated" };

// Nominatim also returns streets, shops and buildings; only settlement-level hits count as a city.
const CITY_TYPES = new Set(["city", "town", "village", "municipality", "administrative", "borough", "county", "state_district"]);

/**
 * Resolves a city. Order: Open-Meteo, then (for cities without seed data) Nominatim, then the seed list.
 * Returns null only when no source recognises the place.
 */
// Open-Meteo returns airports, islands and the like alongside cities; only populated places and admin areas count.
const SETTLEMENT = /^(PPL|ADM[1-4]|PCL)/;

/** Picks the best settlement: one whose name is what was typed (largest first), else the first settlement. */
function pickResult(results: any[], typed: string) {
  const places = results.filter((r) => SETTLEMENT.test(r.feature_code ?? ""));
  const named = places.filter((r) => sameName(typed, r.name ?? ""));
  const pool = named.length ? [...named].sort((a, b) => (b.population ?? 0) - (a.population ?? 0)) : places;
  return pool[0];
}

export async function geocode(city: string): Promise<GeoResult | null> {
  const key = cityKey(city);
  const cur = CURATED[key];
  try {
    // For seeded cities ask for the canonical name, so an alias like "Bombay" does not return a village of that name elsewhere.
    const q = cur ? seedName(key) : city;
    const j = await getJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=en`,
      6000,
    );
    const r = pickResult(j.results ?? [], q);
    if (r)
      return {
        lat: (cur?.center.lat ?? r.latitude) as number,
        lon: (cur?.center.lon ?? r.longitude) as number,
        name: (cur ? seedName(key) : r.name) as string,
        tz: r.timezone as string,
        country: (cur ? "India" : r.country) as string,
        live: true,
        population: r.population as number | undefined,
        via: "open-meteo",
      };
  } catch {
    /* Open-Meteo unavailable: try the next source */
  }
  // Seeded cities already have coordinates, so no second network call is needed for them.
  if (cur) return { ...cur.center, name: seedName(key), tz: "Asia/Kolkata", country: "India", live: false, via: "curated" };
  try {
    const j: any[] = await getJson(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=jsonv2&addressdetails=1&limit=5&accept-language=en`,
      6000,
    );
    // jsonv2 names the field "category" (older formats call it "class")
    const r = j.find((x) => ["place", "boundary"].includes(x.category ?? x.class) && CITY_TYPES.has(x.type));
    if (r)
      return { lat: +r.lat, lon: +r.lon, name: r.name || String(r.display_name).split(",")[0], tz: "auto", country: r.address?.country ?? "", live: true, via: "nominatim" };
  } catch {
    /* no source could answer */
  }
  return null;
}

/**
 * Finds the settlement `query` names according to OpenStreetMap, optionally only within 60 km of `near`. Used as an
 * independent second opinion on a doubtful geocoder match (an airport code, a small place abroad sharing a name). Returns null when Nominatim answers but finds
 * no such settlement; throws when Nominatim is unreachable.
 */
export async function nominatimCity(query: string, near?: { lat: number; lon: number }) {
  const j: any[] = await getJson(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=jsonv2&addressdetails=1&limit=5&accept-language=en`,
    6000,
  );
  const r = j.find(
    (x) => ["place", "boundary"].includes(x.category ?? x.class) && CITY_TYPES.has(x.type) && (!near || haversineKm(near, { lat: +x.lat, lon: +x.lon }) <= 60),
  );
  return r ? { name: (r.name || String(r.display_name).split(",")[0]) as string, lat: +r.lat, lon: +r.lon, country: (r.address?.country ?? "") as string } : null;
}

const WMO: Record<number, string> = {
  0: "clear sky", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "foggy", 48: "foggy",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
  71: "snow", 80: "rain showers", 81: "rain showers", 82: "violent showers", 95: "thunderstorm", 96: "thunderstorm", 99: "thunderstorm",
};

export async function saturdayWeather(lat: number, lon: number) {
  const j = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,precipitation_probability_max,weathercode&timezone=auto&forecast_days=14`,
    6000,
  );
  const today = j.daily.time[0] as string;
  const i = (j.daily.time as string[]).findIndex(
    (d) => new Date(d + "T00:00:00Z").getUTCDay() === 6 && d >= today,
  );
  if (i < 0) throw new Error("no Saturday in forecast window");
  const rain = (j.daily.precipitation_probability_max[i] ?? 0) as number;
  const tempMax = Math.round(j.daily.temperature_2m_max[i]);
  const desc = WMO[j.daily.weathercode[i] as number] ?? "mixed conditions";
  return {
    date: j.daily.time[i] as string,
    summary: `${desc}, up to ${tempMax}°C, ${rain}% chance of rain`,
    tempMax,
    rainChance: rain,
    outdoorOk: rain < 55 && tempMax < 37,
  };
}

const GROUPS: Record<Category, string[]> = {
  park: ['["leisure"~"^(park|garden|nature_reserve)$"]'],
  museum: ['["tourism"="museum"]'],
  art: ['["tourism"="gallery"]', '["amenity"="arts_centre"]'],
  music: ['["amenity"~"^(music_venue|theatre|concert_hall)$"]', '["amenity"="arts_centre"]'],
  temple: ['["amenity"="place_of_worship"]["wikidata"]'],
  market: ['["amenity"="marketplace"]'],
  mall: ['["shop"="mall"]'],
  cinema: ['["amenity"="cinema"]'],
  viewpoint: ['["tourism"="viewpoint"]'],
  food: ['["amenity"="restaurant"]["name"]'],
  cafe: ['["amenity"="cafe"]["name"]'],
  activity: ['["leisure"~"^(bowling_alley|escape_game|miniature_golf)$"]'],
};

type Defaults = Pick<Place, "cost" | "durationMin" | "crowd" | "outdoor" | "opens" | "closes">;
const DEFAULTS: Record<Category, Defaults> = {
  park: { cost: 0, durationMin: 60, crowd: "medium", outdoor: true, opens: 6, closes: 18.5 },
  museum: { cost: 200, durationMin: 90, crowd: "low", outdoor: false, opens: 10, closes: 17.5 },
  art: { cost: 100, durationMin: 60, crowd: "low", outdoor: false, opens: 10, closes: 18 },
  music: { cost: 400, durationMin: 120, crowd: "medium", outdoor: false, opens: 11, closes: 22 },
  temple: { cost: 0, durationMin: 40, crowd: "medium", outdoor: true, opens: 6, closes: 20 },
  market: { cost: 300, durationMin: 60, crowd: "high", outdoor: true, opens: 10, closes: 21 },
  mall: { cost: 300, durationMin: 90, crowd: "high", outdoor: false, opens: 10, closes: 22 },
  cinema: { cost: 350, durationMin: 150, crowd: "medium", outdoor: false, opens: 10, closes: 23 },
  viewpoint: { cost: 0, durationMin: 40, crowd: "medium", outdoor: true, opens: 6, closes: 19 },
  food: { cost: 450, durationMin: 60, crowd: "medium", outdoor: false, opens: 11, closes: 22.5 },
  cafe: { cost: 350, durationMin: 50, crowd: "low", outdoor: false, opens: 9, closes: 21.5 },
  activity: { cost: 500, durationMin: 75, crowd: "medium", outdoor: false, opens: 11, closes: 22 },
};

const INTEREST_TO_CATS: Record<string, Category[]> = {
  food: ["food", "cafe"], foodie: ["food", "cafe"], eating: ["food", "cafe"], coffee: ["cafe"], cafe: ["cafe"],
  music: ["music"], concerts: ["music"], theatre: ["music"],
  walks: ["park"], walking: ["park"], nature: ["park"], outdoors: ["park"], parks: ["park"], gardens: ["park"],
  art: ["museum", "art"], culture: ["museum", "art", "temple"], museums: ["museum"], history: ["museum", "temple"],
  shopping: ["market", "mall"], markets: ["market"], movies: ["cinema"], cinema: ["cinema"],
  spiritual: ["temple"], temples: ["temple"], views: ["viewpoint"], sunset: ["viewpoint", "park"],
  games: ["activity"], fun: ["activity"],
};

export function interestsToCategories(interests: string[]): Category[] {
  const out = new Set<Category>();
  for (const i of interests) {
    const k = i.trim().toLowerCase();
    const hit =
      INTEREST_TO_CATS[k] ?? Object.entries(INTEREST_TO_CATS).find(([w]) => k.includes(w))?.[1] ?? [];
    hit.forEach((c) => out.add(c));
  }
  if (!out.size) (["park", "museum", "cafe"] as Category[]).forEach((c) => out.add(c));
  return [...out];
}

function parseHours(oh?: string): { opens: number; closes: number } | null {
  const m = oh?.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const o = +m[1] + +m[2] / 60;
  let c = +m[3] + +m[4] / 60;
  if (c <= o) c += 24;
  return { opens: o, closes: Math.min(c, 24) };
}

const NON_VEG_HINT = /\b(biryani|biriyani|chicken|mutton|kebabs?|kababs?|tandoori|steak(house)?|seafood|fish|prawn|crab|bbq|barbecue|grill|burger|shawarma|non[- ]?veg|butcher|meat|pork|beef|lamb|thalapakkatti|donne)\b/i;

export function vegOf(t: Record<string, string>): Place["veg"] {
  if (t["diet:vegetarian"] === "only" || t["diet:vegan"] === "only") return "only";
  if (t["diet:vegetarian"] === "yes" || /vegetarian|vegan/.test(t.cuisine ?? "")) return "yes";
  if (t["diet:vegetarian"] === "no") return "no";
  // Most OSM restaurants carry no diet tag. A name or cuisine that is plainly about meat is still a clear answer.
  if (NON_VEG_HINT.test(`${t.name ?? ""} ${t.cuisine ?? ""}`)) return "no";
  return "unknown";
}

function matchFilter(filter: string, tags: Record<string, string>) {
  const re = /\["([^"]+)"(?:(~|=)"([^"]+)")?\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(filter))) {
    const [, k, op, v] = m;
    const val = tags[k];
    if (val === undefined) return false;
    if (op === "=" && val !== v) return false;
    if (op === "~" && !new RegExp(v).test(val)) return false;
  }
  return true;
}

let overpassDownUntil = 0;

export async function overpassPlaces(lat: number, lon: number, cats: Category[], radius = 7000): Promise<Place[]> {
  const parts = cats.flatMap((c) => GROUPS[c].map((f) => `nwr${f}(around:${radius},${lat},${lon});`));
  const q = `[out:json][timeout:7];(${parts.join("")});out center tags 120;`;
  if (Date.now() < overpassDownUntil) throw new Error("overpass recently unreachable (skipped)");
  const endpoints = ["https://overpass-api.de/api/interpreter"];
  let lastErr: unknown;
  for (const ep of endpoints) {
    try {
      const j = await getJson(ep, 5000, {
        method: "POST",
        body: "data=" + encodeURIComponent(q),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      const scored: { p: Place; r: number }[] = [];
      const seen = new Set<string>();
      for (const e of j.elements as any[]) {
        const t = (e.tags ?? {}) as Record<string, string>;
        const name = t["name:en"] ?? t.name;
        const la = e.lat ?? e.center?.lat;
        const lo = e.lon ?? e.center?.lon;
        if (!name || la == null || lo == null || seen.has(name.toLowerCase())) continue;
        const cat = cats.find((c) => GROUPS[c].some((f) => matchFilter(f, t)));
        if (!cat) continue;
        seen.add(name.toLowerCase());
        const h = parseHours(t.opening_hours);
        const r = ["wikipedia", "wikidata", "website", "opening_hours", "phone"].filter((k) => t[k]).length;
        scored.push({
          r,
          p: {
            id: `osm-${String(e.type)[0]}${e.id}`,
            name,
            category: cat,
            lat: la,
            lon: lo,
            ...DEFAULTS[cat],
            ...(h ?? {}),
            veg: cat === "food" || cat === "cafe" ? vegOf(t) : "unknown",
            tags: [cat, ...(t.cuisine ? t.cuisine.split(";") : [])],
            blurb:
              t.description ??
              `${cat[0].toUpperCase() + cat.slice(1)} from OpenStreetMap${t["addr:suburb"] ? " in " + t["addr:suburb"] : ""}.`,
            source: "osm",
            wiki: t.wikipedia?.replace(/^en:/, ""),
            area: t["addr:suburb"],
          },
        });
      }
      return scored.sort((a, b) => b.r - a.r).map((s) => s.p);
    } catch (e) {
      lastErr = e;
    }
  }
  overpassDownUntil = Date.now() + 5 * 60_000;
  throw lastErr ?? new Error("overpass unavailable");
}

export function curatedFor(city: string, cats: Category[]): Place[] {
  return (CURATED[cityKey(city)]?.places ?? []).filter((p) => cats.includes(p.category));
}

export const haversineKm = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

const NOM_TERM: Record<Category, string> = {
  park: "park", museum: "museum", art: "art gallery", music: "theatre", temple: "temple", market: "market",
  mall: "shopping mall", cinema: "cinema", viewpoint: "viewpoint", food: "restaurant", cafe: "cafe", activity: "bowling",
};

/** Second live source: Nominatim POI search inside a bounding box (works where Overpass is blocked/slow). */
export async function nominatimPlaces(lat: number, lon: number, cats: Category[]): Promise<Place[]> {
  const d = 0.08;
  const vb = `${lon - d},${lat + d},${lon + d},${lat - d}`;
  const out: Place[] = [];
  const seen = new Set<string>();
  for (const cat of cats.slice(0, 3)) {
    const j: any[] = await getJson(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(NOM_TERM[cat])}&viewbox=${vb}&bounded=1&format=jsonv2&extratags=1&limit=10`,
      6000,
    );
    for (const e of j) {
      const t = (e.extratags ?? {}) as Record<string, string>;
      const name = e.name || String(e.display_name).split(",")[0];
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      const h = parseHours(t.opening_hours);
      out.push({
        id: `osm-n${e.osm_type?.[0] ?? "x"}${e.osm_id}`,
        name,
        category: cat,
        lat: +e.lat,
        lon: +e.lon,
        ...DEFAULTS[cat],
        ...(h ?? {}),
        veg: cat === "food" || cat === "cafe" ? vegOf(t) : "unknown",
        tags: [cat, ...(t.cuisine ? t.cuisine.split(";") : [])],
        blurb: t.description ?? `${cat[0].toUpperCase() + cat.slice(1)} from OpenStreetMap${t["addr:suburb"] ? " in " + t["addr:suburb"] : ""}.`,
        source: "osm",
        wiki: t.wikipedia?.replace(/^en:/, ""),
        area: t["addr:suburb"],
      });
    }
  }
  return out;
}

/** Live data with fallback chain: Overpass -> Nominatim. Throws only if both fail. */
export async function livePlaces(lat: number, lon: number, cats: Category[]): Promise<Place[]> {
  try {
    return await overpassPlaces(lat, lon, cats);
  } catch {
    return await nominatimPlaces(lat, lon, cats);
  }
}

/** Resolve a free-text start point (area / landmark / address) near the city centre via Nominatim. */
export async function geocodePlace(query: string, city: string, near?: { lat: number; lon: number }) {
  const j: any[] = await getJson(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(`${query}, ${city}`)}&format=jsonv2&limit=3`,
    6000,
  );
  for (const r of j) {
    const p = { lat: +r.lat, lon: +r.lon };
    if (near && haversineKm(near, p) > 60) continue; // wrong city
    return { ...p, name: String(r.display_name).split(",").slice(0, 2).join(",").trim() };
  }
  return null;
}
