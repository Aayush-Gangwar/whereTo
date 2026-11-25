import type { Prefs } from "../types";

/** "4 hours", "90 min", 4 -> hours as a number; null when it cannot be read. */
export function parseHours(s: unknown): number | null {
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  if (typeof s !== "string") return null;
  const m = s.match(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|min|mins|minutes)?/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return /^min/i.test(m[2] ?? "") ? v / 60 : v;
}

/** "10:00", "4pm", "17:30" -> hour as a decimal (10, 16, 17.5). Falls back when unreadable. */
export function parseClock(s: string | undefined, fallback = 10): number {
  const m = s?.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return fallback;
  let h = +m[1];
  if (/pm/i.test(m[3] ?? "") && h < 12) h += 12;
  if (/am/i.test(m[3] ?? "") && h === 12) h = 0;
  if (h > 23) return fallback;
  return h + (m[2] ? Math.min(+m[2], 59) / 60 : 0);
}

export const MAX_HOURS = 16;
export const MAX_PEOPLE = 50;
/** Lowest per-meal budget worth searching with. Below this nothing real fits, so the search would only return empty. */
export const MIN_MEAL_BUDGET = 150;

export type RawPrefs = {
  raw_text?: string;
  city?: string;
  budget_inr?: number;
  available_time?: string | number;
  start_time?: string;
  start_location?: string;
  people?: number;
  mood?: string;
  interests?: string[];
  constraints?: string[];
};

/** Detects dietary and comfort constraints from free text, including negations such as "non-vegetarian". */
export function detectFlags(constraints: string[], rawText = "", mood = "") {
  const text = [...constraints, rawText].join(" ").toLowerCase();
  const vegan = /\bvegan\b/.test(text);
  // "no non-veg" means vegetarian; plain "non-veg" / "non-vegetarian" must NOT.
  const stripped = text
    .replace(/\bno[\s-]+non[\s-]?veg(etarian)?/g, " vegetarian ")
    .replace(/non[\s-]?veg(etarian)?/g, " ");
  const vegetarian = vegan || /\b(veg|vegetarian|jain)\b|no meat|pure veg/.test(stripped);
  const crowdsOk = /(don'?t|do not|doesn'?t)\s+mind\s+(the\s+)?crowds?|crowds?\s+(are|is)\s+(fine|ok|okay)|love\s+crowds?/.test(text);
  return {
    vegetarian,
    vegan,
    avoidCrowds: /crowd/.test(text) && !crowdsOk,
    lowWalking: /less walk|avoid walk|no walk|mobility|wheelchair/.test(text) || /tired|exhaust|lazy/.test(mood.toLowerCase()),
    noAlcohol: /alcohol|no drinks|teetotal/.test(text),
  };
}

/** Normalises the user's request and reports exactly what is missing or unusable. */
export function normalizePrefs(a: RawPrefs): { prefs: Prefs | null; missing: string[]; notes: string[] } {
  const notes: string[] = [];
  const city = a.city?.trim();
  const budget = typeof a.budget_inr === "number" && Number.isFinite(a.budget_inr) && a.budget_inr > 0 ? a.budget_inr : undefined;
  let hours = parseHours(a.available_time);
  if (hours !== null && !(hours > 0)) hours = null;
  if (hours !== null && hours > MAX_HOURS) {
    notes.push(`Available time capped at ${MAX_HOURS} hours for a realistic single outing.`);
    hours = MAX_HOURS;
  }
  const missing = [!city && "city", !budget && "budget", !hours && "available_time"].filter(Boolean) as string[];
  if (!city || !budget || !hours) return { prefs: null, missing, notes };
  const people = Math.min(MAX_PEOPLE, Math.max(1, Math.round(Number.isFinite(a.people) ? (a.people as number) : 1)));
  const mood = a.mood ?? "";
  return {
    prefs: {
      city,
      budget,
      availableHours: hours,
      startHour: parseClock(a.start_time, 10),
      people,
      startLocation: a.start_location?.trim() || undefined,
      mood,
      interests: a.interests ?? [],
      constraints: a.constraints ?? [],
      flags: detectFlags(a.constraints ?? [], a.raw_text ?? "", mood),
    },
    missing,
    notes,
  };
}

/** The submitted form (as extracted from the conversation) in the shape normalizePrefs expects. Only defined values. */
export function formToRaw(f: Record<string, unknown>): RawPrefs {
  const out: RawPrefs = {};
  if (f.city) out.city = String(f.city);
  if (f.budget) out.budget_inr = Number(f.budget);
  if (f.available_time) out.available_time = f.available_time as string | number;
  if (f.start_time) out.start_time = String(f.start_time);
  if (f.start_location) out.start_location = String(f.start_location);
  if (f.people) out.people = Number(f.people);
  if (f.mood) out.mood = String(f.mood);
  if (Array.isArray(f.interests)) out.interests = f.interests as string[];
  if (Array.isArray(f.constraints)) out.constraints = f.constraints as string[];
  return out;
}

/** The parsed preferences back in the raw shape the parser takes, so a later partial parse only has to say what changed. */
export function prefsToRaw(P: import("../types").Prefs): Record<string, unknown> {
  const hh = Math.floor(P.startHour);
  return {
    city: P.city,
    budget_inr: P.budget,
    available_time: String(P.availableHours),
    start_time: `${String(hh).padStart(2, "0")}:${String(Math.round((P.startHour - hh) * 60)).padStart(2, "0")}`,
    start_location: P.startLocation,
    people: P.people,
    mood: P.mood,
    interests: P.interests,
    constraints: P.constraints,
  };
}

/**
 * Did the user actually write this number in their latest message? ("2,500", "₹500" and "500 rupees" all contain 500.)
 * Used to let a clear instruction in chat change the budget or time, while a number the model made up cannot.
 */
export function statedIn(text: string | undefined, n: number | undefined): boolean {
  if (!text || n === undefined || !Number.isFinite(n)) return false;
  const flat = text.replace(/(?<=\d),(?=\d)/g, "");
  const re = new RegExp(String.raw`(?<![\d.])` + String(n).replace(".", String.raw`\.`) + String.raw`(?!\d|\.\d)`);
  return re.test(flat);
}
