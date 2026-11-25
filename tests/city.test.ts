import { beforeEach, describe, expect, it, vi } from "vitest";
import { closeName, editDistance, norm, resolveCity, resolveCityCached, sameName } from "../lib/agent/city";
import { defaultProviders, geo, newCtx } from "./mocks";

vi.mock("../lib/agent/providers", async (orig) => {
  const actual = await orig<typeof import("../lib/agent/providers")>();
  return { ...actual, geocode: vi.fn(), saturdayWeather: vi.fn(), overpassPlaces: vi.fn(), nominatimPlaces: vi.fn(), geocodePlace: vi.fn(), nominatimCity: vi.fn() };
});
import * as prov from "../lib/agent/providers";

describe("text matching helpers", () => {
  it("norm strips case, accents, spaces and punctuation", () => {
    expect(norm("Delhi, India")).toBe("delhiindia");
    expect(norm("São Paulo")).toBe("saopaulo");
    expect(norm("  New-York  ")).toBe("newyork");
  });

  it("editDistance counts single edits and adjacent swaps as one", () => {
    expect(editDistance("delhi", "delhi")).toBe(0);
    expect(editDistance("delih", "delhi")).toBe(1);
    expect(editDistance("hyderbad", "hyderabad")).toBe(1);
    expect(editDistance("abc", "albacete")).toBe(5);
    expect(editDistance("", "abc")).toBe(3);
  });

  it.each([
    ["Delhi", "Delhi", true],
    ["New Delhi", "Delhi", true],
    ["pune city", "Pune", true],
    ["Paris, France", "Paris", true],
    ["DELHI", "delhi", true],
    ["abc", "Albacete", false],
    ["ab", "Abbottabad", false], // too short to count as containing
    ["Goa", "Panaji", false],
  ])("sameName(%j, %j) = %s", (typed, name, expected) => expect(sameName(typed, name)).toBe(expected));

  it.each([
    ["Delih", "Delhi", true],
    ["Hyderbad", "Hyderabad", true],
    ["Mumbay", "Mumbai", true],
    ["Chennnai", "Chennai", true],
    ["abc", "abd", false], // very short inputs tolerate no typos
    ["Pune", "Puna", false],
    ["abc", "Albacete", false],
  ])("closeName(%j, %j) = %s", (typed, name, expected) => expect(closeName(typed, name)).toBe(expected));
});

describe("resolveCity: how far to trust a geocoder hit", () => {
  beforeEach(() => defaultProviders());
  const hit = (g: ReturnType<typeof geo>) => vi.mocked(prov.geocode).mockResolvedValue(g as any);

  describe("proceeds silently (exact)", () => {
    it("a seeded city or alias, even when the geocoder's name differs", async () => {
      hit(geo("Bengaluru", "India", "open-meteo", 12.97, 77.59));
      const r = await resolveCity("bangalore");
      expect(r).toMatchObject({ status: "ok", match: "exact" });
      expect(prov.nominatimCity).not.toHaveBeenCalled();
    });

    it("the exact name, extra words around it, or different case", async () => {
      for (const typed of ["Jaipur", "jaipur", "JAIPUR", "Jaipur, Rajasthan", "jaipur city"]) {
        hit(geo("Jaipur"));
        expect(await resolveCity(typed), typed).toMatchObject({ status: "ok", match: "exact" });
      }
      expect(prov.nominatimCity).not.toHaveBeenCalled();
    });

    it("accented names", async () => {
      hit(geo("São Paulo", "Brazil"));
      expect(await resolveCity("sao paulo")).toMatchObject({ status: "ok", match: "exact" });
    });
  });

  describe("typos of seeded cities are corrected offline, before any geocoder can match another place", () => {
    it.each([["Delih", "delhi"], ["Hyderbad", "hyderabad"], ["Bangalor", "bangalore"], ["Mumbay", "mumbai"]])(
      "%j is understood as %s",
      async (typed, key) => {
        vi.mocked(prov.geocode).mockResolvedValue(geo("Seeded City", "India", "open-meteo", 12, 77) as any);
        const r = await resolveCity(typed);
        expect(r).toMatchObject({ status: "ok", match: "close", interpretedFrom: typed });
        expect(prov.geocode).toHaveBeenCalledWith(key); // the corrected name, not the typo
        expect(prov.nominatimCity).not.toHaveBeenCalled();
      },
    );

    it("exact seeded names are not treated as typos", async () => {
      vi.mocked(prov.geocode).mockResolvedValue(geo("Delhi") as any);
      expect(await resolveCity("Delhi")).toMatchObject({ status: "ok", match: "exact" });
      expect(prov.geocode).toHaveBeenCalledWith("Delhi");
    });

    it("text that is not a near-miss of any seeded city is left to the geocoders", async () => {
      vi.mocked(prov.geocode).mockResolvedValue(null);
      expect(await resolveCity("Zzzxqwland")).toEqual({ status: "unknown" });
      expect(prov.geocode).toHaveBeenCalledWith("Zzzxqwland");
    });
  });

  describe("proceeds but says what it understood (close)", () => {
    it("a small typo, without needing a second source", async () => {
      hit(geo("Jaipur"));
      const r = await resolveCity("Jaipor");
      expect(r).toMatchObject({ status: "ok", match: "close", interpretedFrom: "Jaipor" });
      expect(prov.nominatimCity).not.toHaveBeenCalled();
    });

    it("a different name that OpenStreetMap independently knows as a settlement (Gurgaon / Gurugram)", async () => {
      hit(geo("Gurugram", "India", "open-meteo", 28.46, 77.03));
      vi.mocked(prov.nominatimCity).mockResolvedValue({ name: "Gurugram", lat: 28.4595, lon: 77.0266, country: "India" });
      const r: any = await resolveCity("Gurgaon");
      expect(r).toMatchObject({ status: "ok", match: "close", interpretedFrom: "Gurgaon" });
      expect(r.geo).toMatchObject({ name: "Gurugram", via: "nominatim" });
      expect(prov.nominatimCity).toHaveBeenCalledWith("Gurgaon"); // an independent lookup, not tied to the first hit
    });

    it("prefers OpenStreetMap's settlement when the geocoder only has junk (Mysore -> a toll gate)", async () => {
      hit(geo("Mysore Road Tolgate", "India", "open-meteo", 12.9, 77.4));
      vi.mocked(prov.nominatimCity).mockResolvedValue({ name: "Mysuru", lat: 12.3, lon: 76.65, country: "India" });
      const r: any = await resolveCity("Mysore");
      expect(r).toMatchObject({ status: "ok", match: "close", interpretedFrom: "Mysore" });
      expect(r.geo).toMatchObject({ name: "Mysuru", via: "nominatim" });
    });

    it("when the second source is down, a long alternate name is trusted (Peking / Beijing)", async () => {
      hit(geo("Beijing", "China"));
      vi.mocked(prov.nominatimCity).mockRejectedValue(new Error("nominatim 429"));
      expect(await resolveCity("Peking")).toMatchObject({ status: "ok", match: "close", interpretedFrom: "Peking" });
    });
  });

  describe("a same-named place abroad: confident hits are trusted, doubtful ones get a second opinion", () => {
    it("a large city is trusted without an extra lookup (Paris)", async () => {
      hit(geo("Paris", "France", "open-meteo", 48.85, 2.35, 2_138_551));
      expect(await resolveCity("Paris")).toMatchObject({ status: "ok", match: "exact" });
      expect(prov.nominatimCity).not.toHaveBeenCalled();
    });

    it("an Indian place is trusted without an extra lookup, however small", async () => {
      hit(geo("Hampi", "India", "open-meteo", 15.33, 76.46, 2800));
      expect(await resolveCity("Hampi")).toMatchObject({ status: "ok", match: "exact" });
      expect(prov.nominatimCity).not.toHaveBeenCalled();
    });

    it("a small place abroad with the typed name loses to an Indian settlement OpenStreetMap knows (Goa, Philippines vs Goa, India)", async () => {
      hit(geo("Goa", "Philippines", "open-meteo", 13.7, 123.5, 20_936));
      vi.mocked(prov.nominatimCity).mockResolvedValue({ name: "Goa", lat: 15.3, lon: 74.08, country: "India" });
      const r: any = await resolveCity("Goa");
      expect(r).toMatchObject({ status: "ok", match: "exact" });
      expect(r.geo).toMatchObject({ country: "India", via: "nominatim" });
      expect(r.interpretedFrom).toBeUndefined(); // same name, so no "understood as" note is needed
    });

    it("an unlisted village that shares a famous city's old name becomes the famous city (Peking -> Beijing)", async () => {
      hit(geo("Peking", "Indonesia"));
      vi.mocked(prov.nominatimCity).mockResolvedValue({ name: "Beijing", lat: 39.9, lon: 116.4, country: "China" });
      const r: any = await resolveCity("Peking");
      expect(r).toMatchObject({ status: "ok", match: "close", interpretedFrom: "Peking" });
      expect(r.geo.name).toBe("Beijing");
    });

    it("if OpenStreetMap knows no such settlement, the geocoder's hit stands (the plan header names the country)", async () => {
      hit(geo("Whitby", "Canada", "open-meteo", 43.9, -78.9, 14_000));
      const r: any = await resolveCity("Whitby");
      expect(r).toMatchObject({ status: "ok", match: "exact" });
      expect(r.geo.country).toBe("Canada");
    });

    it("if OpenStreetMap cannot be asked, a small place abroad is confirmed with the user rather than guessed", async () => {
      hit(geo("Goa", "Philippines", "open-meteo", 13.7, 123.5, 20_936));
      vi.mocked(prov.nominatimCity).mockRejectedValue(new Error("nominatim 429"));
      const r: any = await resolveCity("Goa");
      expect(r.status).toBe("suggest");
      expect(r.suggestion).toMatchObject({ name: "Goa", country: "Philippines" });
    });

    it("a hit that already came from OpenStreetMap is not second-guessed by OpenStreetMap", async () => {
      hit(geo("Somewhere", "Elsewhere", "nominatim"));
      expect(await resolveCity("Somewhere")).toMatchObject({ status: "ok", match: "exact" });
      expect(prov.nominatimCity).not.toHaveBeenCalled();
    });
  });

  describe("does not plan; asks 'did you mean' (suggest)", () => {
    it("a code or abbreviation that happens to match a real city: abc -> Albacete", async () => {
      hit(geo("Albacete", "Spain"));
      const r = await resolveCity("abc");
      expect(r.status).toBe("suggest");
      expect((r as any).suggestion).toMatchObject({ name: "Albacete", country: "Spain" });
      expect(prov.nominatimCity).toHaveBeenCalledWith("abc"); // OpenStreetMap was asked independently and found no settlement
    });

    it("when the second source is down, short unrelated inputs are not trusted", async () => {
      hit(geo("Albacete", "Spain"));
      vi.mocked(prov.nominatimCity).mockRejectedValue(new Error("down"));
      expect((await resolveCity("abc")).status).toBe("suggest");
      expect((await resolveCity("blr")).status).toBe("suggest");
    });

    it("a hit that came from Nominatim itself cannot be confirmed by Nominatim", async () => {
      hit(geo("Aurangabad", "India", "nominatim"));
      expect((await resolveCity("Zzfoo")).status).toBe("suggest");
      expect(prov.nominatimCity).not.toHaveBeenCalled();
    });
  });

  describe("asks for the city again (unknown)", () => {
    it("nothing matches at all", async () => {
      vi.mocked(prov.geocode).mockResolvedValue(null);
      expect(await resolveCity("Zzzxqwland")).toEqual({ status: "unknown" });
    });

    it("empty or blank input, without any network call", async () => {
      expect(await resolveCity("")).toEqual({ status: "unknown" });
      expect(await resolveCity("   ")).toEqual({ status: "unknown" });
      expect(prov.geocode).not.toHaveBeenCalled();
    });
  });

  describe("resolveCityCached", () => {
    it("looks each city up once per request, however it is typed", async () => {
      hit(geo("Jaipur"));
      const ctx = newCtx();
      const a = await resolveCityCached(ctx, "Jaipur");
      const b = await resolveCityCached(ctx, "  jaipur ");
      const c = await resolveCityCached(ctx, "JAIPUR!");
      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(prov.geocode).toHaveBeenCalledOnce();
    });

    it("keeps different cities apart", async () => {
      vi.mocked(prov.geocode).mockImplementation(async (c: string) => geo(c) as any);
      const ctx = newCtx();
      await resolveCityCached(ctx, "Jaipur");
      await resolveCityCached(ctx, "Udaipur");
      expect(prov.geocode).toHaveBeenCalledTimes(2);
    });
  });
});
