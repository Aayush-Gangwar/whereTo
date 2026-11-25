import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nominatimCity } from "../lib/agent/providers";

const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;
const hit = (name: string, lat: number, lon: number, o: object = {}) => ({ name, lat: String(lat), lon: String(lon), category: "place", type: "city", display_name: `${name}, India`, address: { country: "India" }, ...o });
const near = { lat: 28.46, lon: 77.03 }; // Gurugram

describe("nominatimCity: confirms a settlement near a point", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());
  const answers = (data: unknown) => vi.stubGlobal("fetch", vi.fn(async () => ok(data)));

  it("returns a city-level hit close to the point (real response shape: field named category)", async () => {
    answers([hit("Gurugram", 28.4595, 77.0266)]);
    expect(await nominatimCity("Gurgaon", near)).toMatchObject({ name: "Gurugram", country: "India" });
  });

  it("also reads the older field name 'class'", async () => {
    answers([{ ...hit("Gurugram", 28.46, 77.03), category: undefined, class: "place" }]);
    expect(await nominatimCity("Gurgaon", near)).not.toBeNull();
  });

  it("ignores a same-named place on the other side of the world", async () => {
    answers([hit("Gurgaon", 40, -75)]);
    expect(await nominatimCity("Gurgaon", near)).toBeNull();
  });

  it("ignores non-settlements (broadcasters, airports, buildings)", async () => {
    answers([hit("ABC Studios", 28.46, 77.03, { category: "amenity", type: "studio" }), hit("Gurgaon Airport", 28.46, 77.03, { category: "aeroway", type: "aerodrome" })]);
    expect(await nominatimCity("abc", near)).toBeNull();
  });

  it("returns null when Nominatim answers with nothing", async () => {
    answers([]);
    expect(await nominatimCity("Zzzxq", near)).toBeNull();
  });

  it("throws when Nominatim is unreachable, so callers can tell 'no' from 'could not ask'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ETIMEDOUT"); }));
    await expect(nominatimCity("Gurgaon", near)).rejects.toThrow();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }) as Response));
    await expect(nominatimCity("Gurgaon", near)).rejects.toThrow(/429/);
  });
});
