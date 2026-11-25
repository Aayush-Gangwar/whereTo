import { describe, expect, it } from "vitest";
import { detectFlags, normalizePrefs, parseClock, parseHours } from "../lib/agent/prefs";

const ok = { city: "Bangalore", budget_inr: 2000, available_time: "4 hours" };

describe("normalizePrefs", () => {
  it("accepts a complete request", () => {
    const { prefs, missing } = normalizePrefs({ ...ok, mood: "tired", interests: ["food"], constraints: ["vegetarian"] });
    expect(missing).toEqual([]);
    expect(prefs).toMatchObject({ city: "Bangalore", budget: 2000, availableHours: 4, people: 1, startHour: 10 });
  });

  it("reports exactly what is missing", () => {
    expect(normalizePrefs({}).missing).toEqual(["city", "budget", "available_time"]);
    expect(normalizePrefs({ city: "Pune" }).missing).toEqual(["budget", "available_time"]);
    expect(normalizePrefs({ ...ok, city: "   " }).missing).toEqual(["city"]);
  });

  it.each([0, -500, NaN, Infinity])("treats a budget of %s as missing", (b) => {
    expect(normalizePrefs({ ...ok, budget_inr: b }).missing).toEqual(["budget"]);
  });

  it.each(["0 hours", "zero", "", 0, -2])("treats available time %j as unusable", (t) => {
    expect(normalizePrefs({ ...ok, available_time: t as string | number }).missing).toEqual(["available_time"]);
  });

  it("understands minutes and decimals", () => {
    expect(normalizePrefs({ ...ok, available_time: "90 minutes" }).prefs?.availableHours).toBe(1.5);
    expect(normalizePrefs({ ...ok, available_time: "2.5 hrs" }).prefs?.availableHours).toBe(2.5);
    expect(normalizePrefs({ ...ok, available_time: 3 }).prefs?.availableHours).toBe(3);
  });

  it("caps unrealistic durations and says so", () => {
    const r = normalizePrefs({ ...ok, available_time: "48 hours" });
    expect(r.prefs?.availableHours).toBe(16);
    expect(r.notes.join(" ")).toMatch(/capped/);
  });

  it("keeps group size within sensible bounds", () => {
    expect(normalizePrefs({ ...ok, people: 0 }).prefs?.people).toBe(1);
    expect(normalizePrefs({ ...ok, people: -3 }).prefs?.people).toBe(1);
    expect(normalizePrefs({ ...ok, people: 2.6 }).prefs?.people).toBe(3);
    expect(normalizePrefs({ ...ok, people: 5000 }).prefs?.people).toBe(50);
  });
});

describe("detectFlags", () => {
  it.each([
    [["vegetarian"], true],
    [["pure veg"], true],
    [["Jain"], true],
    [["vegan"], true],
    [["no non-veg"], true],
    [["no meat"], true],
    [["non-vegetarian"], false],
    [["non veg"], false],
    [["non-veg friendly"], false],
    [[], false],
  ])("vegetarian for %j is %s", (c, expected) => {
    expect(detectFlags(c as string[]).vegetarian).toBe(expected);
  });

  it("detects crowd avoidance and the opposite", () => {
    expect(detectFlags(["avoid crowded places"]).avoidCrowds).toBe(true);
    expect(detectFlags(["quiet, no crowds"]).avoidCrowds).toBe(true);
    expect(detectFlags(["I don't mind crowds"]).avoidCrowds).toBe(false);
    expect(detectFlags([]).avoidCrowds).toBe(false);
  });

  it("treats a tired mood as a request for low effort", () => {
    expect(detectFlags([], "", "tired but wants fun").lowWalking).toBe(true);
    expect(detectFlags(["less walking"]).lowWalking).toBe(true);
    expect(detectFlags([], "", "energetic").lowWalking).toBe(false);
  });
});

describe("parseClock / parseHours", () => {
  it.each([
    ["10:00", 10], ["17:30", 17.5], ["4pm", 16], ["4 PM", 16], ["12am", 0], ["12pm", 12], ["9", 9],
  ])("parseClock(%j) = %s", (s, h) => expect(parseClock(s)).toBe(h));

  it.each(["banana", "", "25:00"])("parseClock(%j) falls back to 10", (s) => expect(parseClock(s)).toBe(10));
  it("parseHours rejects non-numeric input", () => {
    expect(parseHours("soon")).toBeNull();
    expect(parseHours(undefined)).toBeNull();
    expect(parseHours(NaN)).toBeNull();
  });
});
