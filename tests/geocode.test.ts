import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geocode } from "../lib/agent/providers";

const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;
const bad = (status = 503) => ({ ok: false, status, json: async () => ({}) }) as Response;

const meteoHit = (name: string, lat: number, lon: number, country = "India") => ({ results: [{ name, latitude: lat, longitude: lon, timezone: "Asia/Kolkata", country, feature_code: "PPL" }] });
const nomHit = (name: string, lat: number, lon: number, o: object = {}) => ({ name, lat: String(lat), lon: String(lon), category: "place", type: "city", addresstype: "city", display_name: `${name}, India`, address: { country: "India" }, ...o });

type Handler = () => Response | Promise<Response>;
function stubNetwork(h: { meteo: Handler; nominatim?: Handler }) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("geocoding-api.open-meteo.com")) return h.meteo();
    if (url.includes("nominatim.openstreetmap.org")) return (h.nominatim ?? (() => ok([])))();
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const hits = (host: string) => fetchMock.mock.calls.filter((c) => String(c[0]).includes(host)).length;
  return { meteoCalls: () => hits("open-meteo"), nominatimCalls: () => hits("nominatim") };
}

describe("geocode: city lookup with fallbacks", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("uses Open-Meteo when it answers, and does not touch Nominatim", async () => {
    const net = stubNetwork({ meteo: () => ok(meteoHit("Jaipur", 26.91, 75.79)) });
    const g = await geocode("Jaipur");
    expect(g).toMatchObject({ name: "Jaipur", country: "India", via: "open-meteo", live: true });
    expect(net.nominatimCalls()).toBe(0);
  });

  it("Open-Meteo down, real city without seed data: Nominatim finds it (the Jaipur case)", async () => {
    const net = stubNetwork({ meteo: () => { throw new Error("ETIMEDOUT"); }, nominatim: () => ok([nomHit("Jaipur", 26.9124, 75.7873)]) });
    const g = await geocode("Jaipur");
    expect(g).toMatchObject({ name: "Jaipur", country: "India", via: "nominatim", live: true });
    expect(g!.lat).toBeCloseTo(26.9124);
    expect(net.nominatimCalls()).toBe(1);
  });

  it("Open-Meteo returns an error status: same fallback", async () => {
    stubNetwork({ meteo: () => bad(503), nominatim: () => ok([nomHit("Jaipur", 26.9, 75.8)]) });
    expect((await geocode("Jaipur"))?.via).toBe("nominatim");
  });

  it("Open-Meteo has no match but Nominatim does: uses Nominatim", async () => {
    stubNetwork({ meteo: () => ok({}), nominatim: () => ok([nomHit("Kota", 25.18, 75.84)]) });
    expect((await geocode("Kota"))?.via).toBe("nominatim");
  });

  it("neither source knows the place: null, so the caller reports an unknown city", async () => {
    const net = stubNetwork({ meteo: () => ok({}), nominatim: () => ok([]) });
    expect(await geocode("Zzzxqwland")).toBeNull();
    expect(net.meteoCalls()).toBe(1);
    expect(net.nominatimCalls()).toBe(1);
  });

  it("ignores Nominatim hits that are not settlements (streets, shops, buildings)", async () => {
    stubNetwork({
      meteo: () => ok({}),
      nominatim: () => ok([nomHit("Zzzxq Road", 12, 77, { category: "highway", type: "residential" }), nomHit("Zzzxq Cafe", 12, 77, { category: "amenity", type: "cafe" }), nomHit("Zzzxq House", 12, 77, { category: "building", type: "house" })]),
    });
    expect(await geocode("Zzzxq")).toBeNull();
  });

  it("skips non-settlement hits and takes the first real city in the list", async () => {
    stubNetwork({
      meteo: () => ok({}),
      nominatim: () => ok([nomHit("Pune Road", 1, 1, { category: "highway", type: "primary" }), nomHit("Pune", 18.52, 73.86)]),
    });
    expect((await geocode("Pune Road City"))?.name).toBe("Pune");
  });

  it("both sources down for a city without seed data: null (honest 'not found')", async () => {
    stubNetwork({ meteo: () => { throw new Error("down"); }, nominatim: () => { throw new Error("429"); } });
    expect(await geocode("Jaipur")).toBeNull();
  });

  it("seeded city with Open-Meteo down: uses seed coordinates without a second network call", async () => {
    const net = stubNetwork({ meteo: () => { throw new Error("down"); } });
    const g = await geocode("Delhi");
    expect(g).toMatchObject({ via: "curated", live: false, country: "India" });
    expect(net.nominatimCalls()).toBe(0);
  });

  it("seeded city with Open-Meteo up: keeps the seed centre, not the geocoder's", async () => {
    stubNetwork({ meteo: () => ok(meteoHit("Delhi", 28.65, 77.23)) }); // Open-Meteo's point is Old Delhi
    const g = await geocode("Delhi");
    expect(g!.lat).toBeCloseTo(28.6139);
    expect(g!.via).toBe("open-meteo");
  });

  it("handles aliases of seeded cities", async () => {
    const net = stubNetwork({ meteo: () => { throw new Error("down"); } });
    expect((await geocode("Bengaluru"))?.via).toBe("curated");
    expect((await geocode("Bombay"))?.via).toBe("curated");
    expect(net.nominatimCalls()).toBe(0);
  });

  it("also understands the older response format that calls the field 'class'", async () => {
    stubNetwork({ meteo: () => ok({}), nominatim: () => ok([{ ...nomHit("Jaipur", 26.9, 75.8), category: undefined, class: "place" }]) });
    expect((await geocode("Jaipur"))?.via).toBe("nominatim");
  });

  it("carries the country through for non-Indian cities", async () => {
    stubNetwork({ meteo: () => { throw new Error("down"); }, nominatim: () => ok([nomHit("Paris", 48.85, 2.35, { address: { country: "France" } })]) });
    expect((await geocode("Paris"))?.country).toBe("France");
  });
});
