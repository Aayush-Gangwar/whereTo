import { vi } from "vitest";
import * as prov from "../lib/agent/providers";
import type { Ctx } from "../lib/agent/trace";
import { makeTools } from "../lib/agent/tools";

/**
 * Test files must declare, at module top level (vi.mock is hoisted per file):
 *
 *   vi.mock("../lib/agent/providers", async (orig) => {
 *     const actual = await orig<typeof import("../lib/agent/providers")>();
 *     return { ...actual, geocode: vi.fn(), saturdayWeather: vi.fn(), overpassPlaces: vi.fn(), nominatimPlaces: vi.fn(), geocodePlace: vi.fn(), nominatimCity: vi.fn() };
 *   });
 *
 * then call `defaultProviders()` in beforeEach.
 */
export type WeatherMock = { date: string; summary: string; tempMax: number; rainChance: number; outdoorOk: boolean };
export const FAIR: WeatherMock = { date: "2026-11-28", summary: "clear sky, up to 29°C, 5% chance of rain", tempMax: 29, rainChance: 5, outdoorOk: true };
export const RAINY: WeatherMock = { date: "2026-11-28", summary: "heavy rain, up to 24°C, 85% chance of rain", tempMax: 24, rainChance: 85, outdoorOk: false };

export function defaultProviders(opts: { weather?: WeatherMock | Error } = {}) {
  vi.mocked(prov.geocode).mockReset().mockImplementation(async (city: string) => {
    const known = (prov as any).CURATED[prov.cityKey(city)];
    const proper = (k: string) => (k === "bangalore" ? "Bengaluru" : k[0].toUpperCase() + k.slice(1)); // like Open-Meteo
    if (known) return { ...known.center, name: proper(prov.cityKey(city)), tz: "Asia/Kolkata", country: "India", live: true, via: "open-meteo" };
    if (/paris/i.test(city)) return { lat: 48.8566, lon: 2.3522, name: "Paris", tz: "Europe/Paris", country: "France", live: true, via: "open-meteo" };
    if (/jaipur/i.test(city)) return { lat: 26.9124, lon: 75.7873, name: "Jaipur", tz: "Asia/Kolkata", country: "India", live: true, via: "open-meteo" };
    return null; // anything else: city not found
  });
  vi.mocked(prov.saturdayWeather).mockReset().mockImplementation(async () => {
    const w = opts.weather ?? FAIR;
    if (w instanceof Error) throw w;
    return w;
  });
  vi.mocked(prov.overpassPlaces).mockReset().mockRejectedValue(new Error("overpass-api.de responded 502"));
  vi.mocked(prov.nominatimPlaces).mockReset().mockResolvedValue([]);
  vi.mocked(prov.nominatimCity).mockReset().mockResolvedValue(null); // by default Nominatim cannot confirm a doubtful city
  vi.mocked(prov.geocodePlace).mockReset().mockImplementation(async (q: string, _city: string, near?: { lat: number; lon: number }) => {
    if (/zzz|nowhere/i.test(q)) return null;
    return { lat: (near?.lat ?? 12.97) + 0.01, lon: (near?.lon ?? 77.59) + 0.01, name: q };
  });
  return prov;
}

export const newCtx = (): Ctx => ({ t0: Date.now(), spans: [], places: new Map() });

/** Calls a tool the way the AI SDK does. */
export async function call(tools: ReturnType<typeof makeTools>, name: keyof ReturnType<typeof makeTools>, input: unknown) {
  const t: any = tools[name];
  return t.execute(input, { toolCallId: `test_${String(name)}`, messages: [] });
}

/** A geocoder hit, shaped like the real one. */
export const geo = (name: string, country = "India", via: "open-meteo" | "nominatim" | "curated" = "open-meteo", lat = 26.9124, lon = 75.7873, population?: number) =>
  ({ lat, lon, name, tz: "auto", country, live: via !== "curated", via, population }) as const;
