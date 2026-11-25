import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geocode, seedCityNear } from "../lib/agent/providers";
import { closeName, sameName } from "../lib/agent/text";

const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;
const r = (name: string, o: Record<string, unknown> = {}) => ({ name, latitude: 10, longitude: 20, timezone: "UTC", country: "Testland", feature_code: "PPL", population: 1000, ...o });

/** Open-Meteo answers with these candidates; Nominatim answers nothing. Records the Open-Meteo query. */
function meteo(results: unknown[], nominatim: unknown[] = []) {
  const queries: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("geocoding-api.open-meteo.com")) {
      queries.push(decodeURIComponent(new URL(url).searchParams.get("name") ?? ""));
      return ok({ results });
    }
    return ok(nominatim);
  }));
  return queries;
}

describe("geocode: choosing among Open-Meteo candidates", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("never picks an airport or island over a settlement (Mysore Airport, ABC islands)", async () => {
    meteo([r("Mysore Airport", { feature_code: "AIRP" }), r("ABC islands", { feature_code: "ISLS" }), r("Mysuru", { population: 900000 })]);
    expect((await geocode("Mysore"))?.name).toBe("Mysuru");
  });

  it("prefers the candidate whose name is what was typed, even if another ranks first (Goa vs Genoa)", async () => {
    meteo([r("Genoa", { country: "Italy", population: 580000 }), r("Goa", { feature_code: "ADM1", country: "India", population: 1500000 })]);
    const g = await geocode("Goa");
    expect(g).toMatchObject({ name: "Goa", country: "India" });
  });

  it("among same-named places takes the most populous (Springfield)", async () => {
    meteo([r("Springfield", { country: "Small", population: 5000 }), r("Springfield", { country: "Big", population: 120000 })]);
    expect((await geocode("Springfield"))?.country).toBe("Big");
  });

  it("with no name match, takes the first settlement in relevance order", async () => {
    meteo([r("Albacete", { country: "Spain", population: 173000 }), r("Albacete Airport", { feature_code: "AIRP" })]);
    expect((await geocode("abc"))?.name).toBe("Albacete");
  });

  it("only non-settlements (airports, islands): Open-Meteo is treated as a miss and Nominatim is asked", async () => {
    meteo(
      [r("Somewhere Airport", { feature_code: "AIRP" }), r("Some islands", { feature_code: "ISLS" })],
      [{ name: "Somewhere", lat: "5", lon: "6", category: "place", type: "town", display_name: "Somewhere", address: { country: "India" } }],
    );
    expect((await geocode("Somewhere"))).toMatchObject({ via: "nominatim", name: "Somewhere" });
  });

  it("a name that merely starts with the typed text is not mistaken for it (Bangalor vs Bangalore Town)", async () => {
    meteo([r("Bangalore Town", { country: "Pakistan" })]);
    const g = await geocode("Bangalor");
    expect(g?.name).toBe("Bangalore Town"); // still the best available hit...
    expect(sameName("Bangalor", "Bangalore Town")).toBe(false); // ...but the resolver will not call it a match
  });
});

describe("geocode: seeded cities and their aliases", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["Bombay", "mumbai", "Mumbai"],
    ["Calcutta", "kolkata", "Kolkata"],
    ["Madras", "chennai", "Chennai"],
    ["Poona", "pune", "Pune"],
    ["bangalore", "bengaluru", "Bengaluru"],
  ])("%s is looked up under its canonical name and reported as %s, India (not a village of the same name abroad)", async (typed, query, name) => {
    const queries = meteo([r("Wrong Village", { country: "Elsewhere" }), r(name, { country: "India", population: 9e6 })]);
    const g = await geocode(typed);
    expect(queries[0].toLowerCase()).toBe(query);
    expect(g).toMatchObject({ name, country: "India" });
  });

  it("even if Open-Meteo labels it differently, a seeded city is India", async () => {
    meteo([r("Delhi", { country: "Whatever" })]);
    expect((await geocode("Delhi"))?.country).toBe("India");
  });
});

describe("seedCityNear: typo correction against the seeded cities", () => {
  it.each([
    ["Delih", "delhi"],
    ["Hyderbad", "hyderabad"],
    ["Mumbay", "mumbai"],
    ["Bangalor", "bangalore"],
    ["Kolkatta", "kolkata"],
    ["Chenai", "chennai"],
    ["Bombai", "mumbai"], // a typo of an alias
    ["Banglore", "bangalore"],
  ])("%j -> %s", (typed, key) => expect(seedCityNear(typed)).toBe(key));

  it.each(["abc", "xyz", "Pune", "Puna", "Delhi", "Jaipur", "Paris", "Goa", "Zzzxqwland", ""])("%j is not corrected", (typed) => {
    // exact seeded names also return null here: exact matches are handled before typo correction
    const out = seedCityNear(typed);
    if (["Pune", "Delhi"].includes(typed)) expect(out === null || out === typed.toLowerCase()).toBe(true);
    else expect(out).toBeNull();
  });

  it("short inputs tolerate no typos", () => {
    expect(seedCityNear("Pun")).toBeNull();
    expect(seedCityNear("Goa")).toBeNull();
  });
});

describe("name matching rules", () => {
  it.each([
    ["Delhi", "Delhi", true],
    ["New Delhi", "Delhi", true],
    ["Delhi, India", "Delhi", true],
    ["pune city", "Pune", true],
    ["Mysore", "Mysore Airport", true], // part of the name; airports are filtered out elsewhere
    ["Goa", "Goa", true],
    ["São Paulo", "sao paulo", true],
    ["Bangalor", "Bangalore Town", false],
    ["Delih", "Deliház", false],
    ["abc", "Albacete", false],
    ["ab", "Abbottabad", false],
    ["Goa", "Panaji", false],
    ["Pune", "Puna", false],
  ])("sameName(%j, %j) = %s", (typed, name, expected) => expect(sameName(typed, name)).toBe(expected));

  it("closeName forgives small typos only", () => {
    expect(closeName("Delih", "Delhi")).toBe(true);
    expect(closeName("Hyderbad", "Hyderabad")).toBe(true);
    expect(closeName("abc", "abd")).toBe(false);
    expect(closeName("Pune", "Puna")).toBe(false);
  });
});
