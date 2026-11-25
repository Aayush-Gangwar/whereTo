import { tool } from "ai";
import { z } from "zod";
import type { Category, Itinerary, Place, Span } from "../types";
import { Ctx, traced } from "./trace";
import { resolveCityCached } from "./city";
import { MAX_HOURS, MAX_PEOPLE, MIN_MEAL_BUDGET, formToRaw, normalizePrefs, parseClock, prefsToRaw, statedIn } from "./prefs";
import { rankPlaces, type Window } from "./rank";
import { dropNulls, nullTolerant, withLiveEnum } from "./schema";
import { viewBuild, viewOptions, viewPrefs, viewWeather } from "./model-view";
import { estimateCost, fmt, mins, schedulePlan, validatePlan } from "./plan";

export { fmt };
import { curatedFor, curatedCityNames, haversineKm, interestsToCategories, overpassPlaces, nominatimPlaces, geocodePlace, saturdayWeather, cityKey } from "./providers";

/** Compact, LLM-cheap preview of a value for the trace (arrays -> count + sample). */
const preview = (v: unknown, depth = 0): unknown => {
  if (Array.isArray(v)) {
    return { count: v.length, sample: v.slice(0, 4).map((x) => preview(x, depth + 1)) };
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.name === "string" && typeof o.category === "string") return { name: o.name, category: o.category, source: o.source, cost_inr: o.cost ?? o.cost_inr };
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) {
      if (k === "_spans") continue;
      out[k] = typeof x === "string" && x.length > 140 ? x.slice(0, 140) + "…" : depth < 2 ? preview(x, depth + 1) : x;
    }
    return out;
  }
  return v;
};

// Root span io already lives in the tool part's args/result; children keep a preview so the trace can show them.
const slim = (ctx: Ctx, id: string): Span[] =>
  ctx.spans
    .filter((s) => s.id === id || s.parentId === id)
    .map((s) => (s.id === id ? { ...s, input: undefined, output: undefined } : { ...s, input: preview(s.input), output: preview(s.output) }));

/** Overpass first, Nominatim second. Each attempt is its own visible sub-step so failures are not hidden. */
async function liveLookup(ctx: Ctx, parentId: string, lat: number, lon: number, cats: Category[]): Promise<Place[]> {
  const input = { lat: +lat.toFixed(4), lon: +lon.toFixed(4), categories: cats };
  const first = await traced(
    ctx,
    "overpass (primary OSM source)",
    { ...input, radius_m: 7000, timeout_ms: 5000 },
    async (sp) => {
      try {
        return { places: await overpassPlaces(lat, lon, cats) } as { places?: Place[]; error?: string };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "error";
        sp.fallback();
        sp.note(`unavailable (${msg}); falling back to Nominatim`);
        return { error: msg };
      }
    },
    { parentId },
  );
  if (first.places) return first.places;
  const second = await traced(ctx, "nominatim (fallback OSM source)", { ...input, bbox_deg: 0.08 }, async () => ({ places: await nominatimPlaces(lat, lon, cats) }), { parentId });
  return second.places;
}

const compact = (p: Place, center?: { lat: number; lon: number }) => ({
  id: p.id,
  name: p.name,
  category: p.category,
  cost_inr: p.cost,
  duration_min: p.durationMin,
  crowd: p.crowd,
  outdoor: p.outdoor,
  veg: p.veg,
  hours: `${fmt(p.opens * 60)}-${fmt(p.closes * 60)}`,
  area: p.area,
  lat: +p.lat.toFixed(5),
  lon: +p.lon.toFixed(5),
  km_from_center: center ? +haversineKm(center, p).toFixed(1) : undefined,
  note: p.blurb,
  source: p.source,
});

/** The user's outing window, once their preferences are known. */
const outingWindow = (ctx: Ctx): Window | undefined => {
  const p = ctx.prefs ?? (ctx.formPrefs ? normalizePrefs(formToRaw(ctx.formPrefs)).prefs : null);
  return p ? { startHour: p.startHour, availMin: p.availableHours * 60 } : undefined;
};

/** One forecast request per run, however many tools ask (the first step now runs several in parallel). */
function forecastOnce(ctx: Ctx, lat: number, lon: number) {
  ctx.forecast ??= saturdayWeather(lat, lon);
  return ctx.forecast;
}

/** Weather for filtering, without failing the caller: get_weather reports a failed forecast itself. */
async function weatherFor(ctx: Ctx, c: { lat: number; lon: number }) {
  if (ctx.weather) return ctx.weather;
  try {
    ctx.weather ??= await forecastOnce(ctx, c.lat, c.lon);
  } catch {
    /* get_weather degrades to "assume fair weather" */
  }
  return ctx.weather;
}

async function ensureCenter(ctx: Ctx, city: string) {
  if (ctx.center && cityKey(ctx.center.city) === cityKey(city)) return ctx.center;
  const r = await resolveCityCached(ctx, city);
  if (r.status !== "ok") return null; // unknown or unclear cities never get place searches
  const g = r.geo;
  ctx.center = { lat: g.lat, lon: g.lon, city };
  ctx.country = g.country;
  ctx.place ??= { name: g.name, country: g.country, typed: r.interpretedFrom };
  return ctx.center;
}

const buildInput = z.object({
  city: z.string().optional(),
  title: z.string().describe("catchy plan title"),
  budget_inr: z.number().optional().describe("total budget for the whole group; omit to use the user's stated budget"),
  available_hours: z.number().optional().describe("omit to use the user's stated time"),
  start_time: z.string().optional().describe('omit to use the user\'s start time'),
  start_location: z.string().optional(),
  people: z.number().optional(),
  vegetarian: z.boolean().optional(),
  avoid_crowds: z.boolean().optional(),
  low_walking: z.boolean().optional(),
  stops: z
    .array(
      z.object({
        place_id: z.string(),
        duration_min: z.number().optional(),
        why: z.string().describe("1-2 sentences tying this stop to the user, using ONLY facts from the options table"),
        trade_off: z.string().optional().describe("honest downside, using only facts from the table"),
      }),
    )
    .min(1),
});

/** What the model is shown: the stops it chooses and, for feedback, an optional lower budget or shorter time. */
const buildInputForModel = z.object({
  title: z.string(),
  budget_inr: z.number().optional().describe("the user's NEW total budget if they just wrote one in chat; otherwise omit (or lower it to make the plan cheaper)"),
  available_hours: z.number().optional().describe("the user's NEW available hours if they just wrote them in chat; otherwise omit (or lower it to make the plan shorter)"),
  stops: buildInput.shape.stops,
});

type BuildArgs = z.infer<typeof buildInput> & { city: string; budget_inr: number; available_hours: number; start_time: string };

/** Most build_itinerary drafts in one turn (a first draft plus a few repairs). */
const MAX_BUILDS = 5;

const clock24 = (h: number) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;

/**
 * The user's own constraints are authoritative. The model repeats them when it calls build_itinerary, and could
 * misread or loosen them, so: it can make a plan cheaper or shorter (feedback), but never more expensive or longer;
 * a constraint the user set cannot be switched off; group size, start time and city come from the parsed preferences.
 */
function resolveBuildArgs(raw: z.infer<typeof buildInput>, ctx: Ctx): { a: BuildArgs; argWarnings: string[]; missing?: string } {
  const P = ctx.prefs;
  const argWarnings: string[] = [];
  const city = P?.city ?? raw.city ?? ctx.center?.city;
  let budget = raw.budget_inr ?? P?.budget;
  let hours = raw.available_hours ?? P?.availableHours;
  // A larger number is accepted only when the user wrote it in their latest message ("make it 500"): then it replaces the old one.
  if (P && raw.budget_inr !== undefined && raw.budget_inr > P.budget) {
    if (statedIn(ctx.latestUserText, raw.budget_inr)) {
      ctx.prefs = { ...P, budget: raw.budget_inr };
    } else {
      argWarnings.push(`Budget kept at your stated INR ${P.budget} (the draft asked for INR ${raw.budget_inr}).`);
      budget = P.budget;
    }
  }
  if (P && raw.available_hours !== undefined && raw.available_hours > P.availableHours) {
    if (statedIn(ctx.latestUserText, raw.available_hours)) {
      ctx.prefs = { ...(ctx.prefs ?? P), availableHours: raw.available_hours };
    } else {
      argWarnings.push(`Time kept at your stated ${P.availableHours}h (the draft asked for ${raw.available_hours}h).`);
      hours = P.availableHours;
    }
  }
  if (!city || budget === undefined || hours === undefined) {
    return { a: raw as BuildArgs, argWarnings, missing: "Missing city, budget or available time. Call parse_preferences first, or pass budget_inr and available_hours." };
  }
  const a: BuildArgs = {
    ...raw,
    city,
    budget_inr: budget,
    available_hours: hours,
    start_time: P ? clock24(P.startHour) : raw.start_time ?? "10:00",
    start_location: P?.startLocation ?? raw.start_location,
    people: P?.people ?? raw.people,
    vegetarian: P?.flags.vegetarian || raw.vegetarian,
    avoid_crowds: P?.flags.avoidCrowds || raw.avoid_crowds,
    low_walking: P?.flags.lowWalking || raw.low_walking,
  };
  return { a, argWarnings };
}

export function makeTools(ctx: Ctx) {
  const tools = buildTools(ctx);
  for (const t of Object.values(tools) as any[]) {
    t.inputSchema = nullTolerant(t.inputSchema);
    const run = t.execute;
    if (run) t.execute = (input: unknown, opts: unknown) => run(dropNulls(input), opts);
  }
  return tools;
}

function buildTools(ctx: Ctx) {
  const register = (ps: Place[]) => ps.forEach((p) => ctx.places.set(p.id, p));

  return {
    parse_preferences: tool({
      description: "Normalize the request into preferences and find what is missing. Call first. Pass what you can extract; omit unknown fields.",
      toModelOutput: ({ output }: any) => ({ type: "text" as const, value: viewPrefs(output) }),
      inputSchema: z.object({
        raw_text: z.string().optional(),
        city: z.string().optional(),
        budget_inr: z.number().optional().describe("total INR"),
        available_time: z.union([z.string(), z.number()]).optional(),
        start_time: z.string().optional(),
        start_location: z.string().optional(),
        people: z.number().optional(),
        mood: z.string().optional(),
        interests: z.array(z.string()).optional(),
        constraints: z.array(z.string()).optional(),
      }),
      execute: async (a) => {
        let spanId = "";
        const o = await traced(ctx, "parse_preferences", a, async (sp) => {
          spanId = sp.id;
          // A structured form submission is authoritative: the model may only fill gaps, never override the user's own values.
          const fromForm: Record<string, unknown> = formToRaw(ctx.formPrefs ?? {});
          // ...except a number the user has since written in chat (a new budget or time): that is the newer instruction.
          if (typeof a.budget_inr === "number" && a.budget_inr !== fromForm.budget_inr && statedIn(ctx.latestUserText, a.budget_inr)) delete fromForm.budget_inr;
          if (a.available_time !== undefined && a.available_time !== fromForm.available_time && statedIn(ctx.latestUserText, Number.parseFloat(String(a.available_time)))) delete fromForm.available_time;
          // A later, partial parse ("600 rupees") only needs to say what changed: the rest is what was already understood.
          const before = ctx.prefs ? prefsToRaw(ctx.prefs) : {};
          const next: Record<string, unknown> = { ...a };
          if (typeof next.budget_inr === "number" && typeof before.budget_inr === "number" && next.budget_inr > before.budget_inr && !statedIn(ctx.latestUserText, next.budget_inr)) delete next.budget_inr;
          const merged = { ...before, ...next, ...fromForm };
          const { prefs, missing, notes } = normalizePrefs(merged);
          if (prefs) ctx.prefs = prefs;
          if (missing.length) sp.note(`missing: ${missing.join(", ")}`);
          else if (notes.length) sp.note(notes.join(" "));
          return {
            prefs,
            missing,
            notes,
            next: missing.length
              ? "Required fields are missing. Call ask_user_preferences with a prefill of what you know."
              : "Preferences complete. Continue: get_weather, then get_activity_options and get_food_options.",
          };
        });
        return { ...o, _spans: slim(ctx, spanId) };
      },
    }),

    ask_user_preferences: tool({
      description: "Show the user an in-chat form to fill or confirm details when something required is missing, unclear or doubtful. At most once per turn.",
      inputSchema: z.object({
        reason: z.string().describe("one friendly sentence"),
        prefill: z.record(z.string(), z.any()).optional().describe("known details: city, budget, available_time, start_time, start_location, people, mood, interests, constraints"),
        suggestion: z.object({ city: z.string(), country: z.string().optional() }).optional().describe("a city the user may have meant (one-tap button)"),
      }),
      // no execute: the client renders the form and supplies the result (human-in-the-loop)
    }),

    get_weather: tool({
      description: "Resolve the city and get the coming Saturday's forecast. Call before searching places.",
      toModelOutput: ({ output }: any) => ({ type: "text" as const, value: viewWeather(output) }),
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => {
        let spanId = "";
        const out = await traced(ctx, "get_weather", { city }, async (sp) => {
          spanId = sp.id;
          const r = await resolveCityCached(ctx, city);
          if (r.status === "unknown") {
            sp.note("city not found");
            ctx.cityRejected = true;
            return {
              error: "city_not_found",
              message: `I could not locate "${city}". Do not plan. Call ask_user_preferences once, asking the user to check the city spelling (leave city out of the prefill; known demo cities: ${curatedCityNames.join(", ")}).`,
            };
          }
          if (r.status === "suggest") {
            const s = r.suggestion;
            const label = `${s.name}${s.country ? ", " + s.country : ""}`;
            sp.note(`"${city}" does not look like a city; closest match is ${label}`);
            ctx.cityRejected = true;
            return {
              error: "city_unclear",
              suggestion: { city: s.name, country: s.country },
              message: `"${city}" does not look like a known city. The closest match is "${label}" but it may be wrong. Do not plan yet. Call ask_user_preferences once with reason asking "Did you mean ${label}?", keep the user's other details in prefill, leave city out, and pass suggestion {city: "${s.name}", country: "${s.country}"}. Wait for the user.`,
            };
          }
          const g = r.geo;
          ctx.center = { lat: g.lat, lon: g.lon, city };
          ctx.country = g.country;
          ctx.place = { name: g.name, country: g.country, typed: r.interpretedFrom };
          const notes: string[] = [];
          if (r.match === "close") notes.push(`interpreted "${city}" as ${g.name}${g.country ? ", " + g.country : ""}`);
          if (g.via !== "open-meteo") {
            sp.fallback();
            notes.push(`city lookup used ${g.via} (Open-Meteo geocoding unavailable or had no match)`);
          }
          if (notes.length) sp.note(notes.join("; "));
          try {
            const w = await traced(ctx, "open-meteo forecast", { lat: g.lat, lon: g.lon }, () => forecastOnce(ctx, g.lat, g.lon), { parentId: sp.id });
            ctx.weather = w;
            return { city: g.name, country: g.country, center: { lat: g.lat, lon: g.lon }, saturday: w.date, weather: w.summary, outdoor_ok: w.outdoorOk, rain_chance: w.rainChance, temp_max: w.tempMax, geocoder: g.via, interpreted_from: r.interpretedFrom };
          } catch (e) {
            sp.fallback();
            sp.note("weather API failed; assuming fair weather");
            ctx.weather = { summary: "forecast unavailable (assumed fair)", tempMax: 30, rainChance: 10, outdoorOk: true };
            return { city: g.name, country: g.country, center: { lat: g.lat, lon: g.lon }, weather: "forecast unavailable, assuming fair weather", outdoor_ok: true, rain_chance: null, degraded: true, interpreted_from: r.interpretedFrom };
          }
        });
        return { ...out, _spans: slim(ctx, spanId) };
      },
    }),

    get_activity_options: tool({
      description: "Find real places for the user's non-food interests, ranked for their outing window. Returns ids for build_itinerary.",
      toModelOutput: ({ output }: any) => ({ type: "text" as const, value: viewOptions(output, "activities") }),
      inputSchema: z.object({
        city: z.string(),
        interests: z.array(z.string()).describe("e.g. walks, music, art, shopping"),
        avoid_crowds: z.boolean().optional(),
      }),
      execute: async (a) => {
        let spanId = "";
        const out = await traced(ctx, "get_activity_options", a, async (sp) => {
          spanId = sp.id;
          const center = await ensureCenter(ctx, a.city);
          if (!center) return { error: "city_not_found", options: [] };
          const cats = interestsToCategories(a.interests).filter((c) => c !== "food" && c !== "cafe");
          const wanted = cats.length ? cats : (["park", "museum", "art"] as const).slice();
          let places: Place[] = [];
          let source = "osm+curated";
          try {
            places = await liveLookup(ctx, sp.id, center.lat, center.lon, [...wanted]);
          } catch (e) {
            sp.fallback();
            sp.note(`live data unavailable (${e instanceof Error ? e.message : "error"}); using curated list`);
            source = "curated-fallback";
          }
          const cur = curatedFor(a.city, [...wanted]);
          const byName = new Map<string, Place>();
          [...cur, ...places.slice(0, 14)].forEach((p) => byName.set(p.name.toLowerCase(), p));
          let list = [...byName.values()];
          const dropped: string[] = [];
          if (a.avoid_crowds) {
            const keep = list.filter((p) => p.crowd !== "high");
            list.filter((p) => p.crowd === "high").forEach((p) => dropped.push(`${p.name} (crowded)`));
            list = keep;
          }
          await weatherFor(ctx, center); // the first step may run this before get_weather has finished
          if (ctx.weather && !ctx.weather.outdoorOk) {
            const keep = list.filter((p) => !p.outdoor);
            list.filter((p) => p.outdoor).forEach((p) => dropped.push(`${p.name} (outdoor, weather)`));
            list = keep;
          }
          let relaxed: string | undefined;
          if (!list.length) {
            relaxed = "No place matched all filters; broadened to museums/parks/cafes nearby.";
            sp.fallback();
            list = [...curatedFor(a.city, ["park", "museum", "art", "cafe"]), ...places].slice(0, 8);
          }
          const ranked = rankPlaces(list, { center, limit: 10, avoidCrowds: a.avoid_crowds, window: outingWindow(ctx) });
          list = ranked.places;
          if (ranked.relaxed) relaxed ??= "No place is open for your whole window; showing the closest options.";
          dropped.push(...ranked.droppedInfeasible);
          register(list);
          return { count: list.length, empty: list.length ? undefined : "No places found. Tell the user honestly and suggest a nearby larger city or different interests; do not invent places.", source, relaxed, dropped_by_filters: dropped.slice(0, 6), options: list.map((p) => compact(p, center)) };
        });
        return { ...out, _spans: slim(ctx, spanId) };
      },
    }),

    get_food_options: tool({
      description: "Find restaurants and cafes matching diet and per-person meal budget. Returns ids for build_itinerary.",
      toModelOutput: ({ output }: any) => ({ type: "text" as const, value: viewOptions(output, "food") }),
      inputSchema: z.object({
        city: z.string(),
        budget_per_meal_inr: z.number(),
        vegetarian: z.boolean().optional(),
        avoid_crowds: z.boolean().optional(),
      }),
      execute: async (a) => {
        let spanId = "";
        const out = await traced(ctx, "get_food_options", a, async (sp) => {
          spanId = sp.id;
          const center = await ensureCenter(ctx, a.city);
          if (!center) return { error: "city_not_found", options: [] };
          let places: Place[] = [];
          try {
            places = await liveLookup(ctx, sp.id, center.lat, center.lon, ["food", "cafe"]);
          } catch (e) {
            sp.fallback();
            sp.note(`live data unavailable (${e instanceof Error ? e.message : "error"}); using curated list`);
          }
          const byName = new Map<string, Place>();
          [...curatedFor(a.city, ["food", "cafe"]), ...places.slice(0, 18)].forEach((p) => byName.set(p.name.toLowerCase(), p));
          // A meal under about 150 rupees is not a realistic search (the built-in planner uses the same floor).
          const perMeal = Math.max(MIN_MEAL_BUDGET, a.budget_per_meal_inr);
          let list = [...byName.values()].filter((p) => p.cost <= perMeal * 1.2);
          const notes: string[] = [];
          if (perMeal > a.budget_per_meal_inr) notes.push(`Searched with INR ${perMeal} per meal (the minimum realistic budget), not INR ${a.budget_per_meal_inr}.`);
          if (a.vegetarian) {
            const sure = list.filter((p) => p.veg === "only" || p.veg === "yes");
            if (sure.length >= 2) list = sure;
            else {
              list = [...sure, ...list.filter((p) => p.veg === "unknown")];
              notes.push("Few confirmed vegetarian places in OSM data; unconfirmed ones are marked veg=unknown. Tell the user to confirm the menu.");
            }
            list = list.filter((p) => p.veg !== "no");
          }
          if (a.avoid_crowds) {
            const calm = list.filter((p) => p.crowd !== "high");
            if (calm.length >= 2) list = calm;
            else notes.push("Most good options here are busy; suggest off-peak timing.");
          }
          if (!list.length) {
            // Nothing fits: show the cheapest few instead of nothing, clearly marked, so the validator can say honestly
            // whether the total budget works and the user can decide.
            const cheapest = [...byName.values()].filter((p) => !(a.vegetarian && p.veg === "no")).sort((x, y) => x.cost - y.cost).slice(0, 3);
            if (cheapest.length) {
              list = cheapest;
              notes.push(`NOTHING fit INR ${perMeal} per meal. These are the cheapest available and are OVER that budget (cheapest INR ${cheapest[0].cost}). Tell the user plainly; a plan using them may exceed their budget.`);
            }
            sp.fallback();
            notes.push("No food place matched budget+diet. Raise the per-meal budget or relax constraints.");
          }
          const ranked = rankPlaces(list, { center, limit: 8, avoidCrowds: a.avoid_crowds, window: outingWindow(ctx) });
          list = ranked.places;
          register(list);
          return { count: list.length, empty: list.length ? undefined : "No food places found. Be honest; suggest relaxing diet/budget or another city.", notes, options: list.map((p) => compact(p, center)) };
        });
        return { ...out, _spans: slim(ctx, spanId) };
      },
    }),

    build_itinerary: tool({
      description: "Schedule the chosen stops (ONLY the allowed place ids), compute travel and cost, and validate. If it reports issues, fix them and call again (max 3 attempts).",
      toModelOutput: ({ output }: any) => ({ type: "text" as const, value: viewBuild(output) }),
      // The allowed place ids are injected into the schema as an enum once the search tools have run, so the model cannot emit any other id.
      inputSchema: withLiveEnum(buildInputForModel, (j) => j?.properties?.stops?.items?.properties?.place_id, () => [...ctx.places.keys()]) as any,
      execute: async (raw: z.infer<typeof buildInput>) => {
        const { a, argWarnings, missing } = resolveBuildArgs(raw, ctx);
        if (missing) return { error: "missing_parameters", message: missing };
        // An endless repair loop helps nobody: after a few drafts, stop and tell the user plainly what cannot be met.
        ctx.buildCalls = (ctx.buildCalls ?? 0) + 1;
        if (ctx.buildCalls > MAX_BUILDS) return { error: "repair_limit", message: "Too many drafts this turn. Do NOT call build_itinerary again: present the best valid draft you already have and say plainly what could not be met, or explain what the user could change." };
        let spanId = "";
        const out = await traced(ctx, "build_itinerary", { stops: a.stops.map((s) => s.place_id), budget: a.budget_inr, hours: a.available_hours }, async (sp) => {
          spanId = sp.id;
          const startMin = mins(parseClock(a.start_time));
          const people = Math.min(MAX_PEOPLE, Math.max(1, Math.round(a.people ?? 1)));
          const vehicles = Math.ceil(people / 4); // one auto/cab per ~4 people
          const hours = Math.min(MAX_HOURS, Math.max(0.5, a.available_hours));
          const extraWarnings: string[] = [];

          let startPt: { name: string; lat: number; lon: number } | null = null;
          if (a.start_location?.trim()) {
            const q = a.start_location.trim();
            ctx.startCache ??= new Map();
            startPt = await traced(ctx, "geocode_start_location", { query: q, city: a.city }, async (sp) => {
              if (ctx.startCache!.has(q.toLowerCase())) return ctx.startCache!.get(q.toLowerCase())!;
              try {
                const g = await geocodePlace(q, a.city, ctx.center);
                ctx.startCache!.set(q.toLowerCase(), g);
                if (!g) { sp.fallback(); sp.note("could not locate the start point; plan starts at the first stop"); }
                return g;
              } catch (e) {
                sp.fallback();
                sp.note(`geocoder unavailable (${e instanceof Error ? e.message : "error"}); plan starts at the first stop`);
                return null;
              }
            }, { parentId: sp.id });
            if (!startPt) extraWarnings.push(`Could not locate "${q}", so travel to the first stop is not included.`);
          }

          const sched = await traced(ctx, "schedule_stops", { count: a.stops.length }, () => {
            const r = schedulePlan({ requests: a.stops, places: ctx.places, startMin, start: startPt, lowWalking: a.low_walking, vehicles });
            return { ...r, schedule: r.stops.map((x) => `${fmt(x.startMin)}-${fmt(x.endMin)} ${x.name}`), issues_so_far: r.issues.length };
          }, { parentId: sp.id });
          const stops = sched.stops;

          const cost = await traced(ctx, "estimate_cost", { stops: stops.length }, () => estimateCost(stops, people, sched.travelCost, vehicles), { parentId: sp.id });

          const total = stops.length ? stops[stops.length - 1].endMin - startMin : 0;
          const validation = await traced(ctx, "validate_plan", { budget: a.budget_inr, hours }, () =>
            validatePlan({
              stops, places: ctx.places, budget: a.budget_inr, availableHours: hours, people, totalCost: cost.total,
              travelMinutes: sched.travelMinutes, startMin, vegetarian: a.vegetarian, avoidCrowds: a.avoid_crowds, lowWalking: a.low_walking,
              weather: ctx.weather,
            }), { parentId: sp.id });

          const issues = [...sched.issues, ...validation.issues];
          const warnings = [...argWarnings, ...extraWarnings, ...sched.warnings, ...validation.warnings];
          if (hours !== a.available_hours) warnings.push(`Available time adjusted to ${hours}h.`);
          if (ctx.country && !/^india$/i.test(ctx.country)) warnings.push(`Costs are rough estimates using Indian-rupee defaults and may not reflect local prices in ${ctx.country}.`);

          const center = ctx.center ?? { lat: stops[0]?.lat ?? 0, lon: stops[0]?.lon ?? 0 };
          const itinerary: Itinerary = {
            city: a.city,
            center: { lat: center.lat, lon: center.lon },
            title: a.title,
            stops,
            people,
            place: ctx.place,
            flags: { vegetarian: !!a.vegetarian, avoidCrowds: !!a.avoid_crowds, lowWalking: !!a.low_walking },
            start: startPt ?? undefined,
            totals: { cost: cost.total, budget: a.budget_inr, minutes: total, availableMinutes: mins(hours), travelMinutes: sched.travelMinutes },
            validation: { ok: issues.length === 0, issues, warnings },
            weather: ctx.weather ? { summary: ctx.weather.summary, tempMax: ctx.weather.tempMax, rainChance: ctx.weather.rainChance } : undefined,
          };
          if (issues.length) sp.note(`${issues.length} validation issue(s)`);
          return {
            itinerary,
            instruction: issues.length
              ? "VALIDATION FAILED. Fix every issue by swapping/removing stops (only returned place ids) and call build_itinerary again. Do not present this plan as final."
              : "Valid plan. Do not repeat the stop list; write a short friendly summary with trade-offs and offer to tweak.",
          };
        });
        return { ...out, _spans: slim(ctx, spanId) };
      },
    }),
  };
}

/** Rebuild the place registry / centre / weather from earlier tool results in the chat history so follow-ups (swap stop etc.) stay grounded. */
export function seedFromHistory(ctx: Ctx, messages: any[]) {
  for (const m of messages ?? []) {
    for (const part of m.parts ?? []) {
      if (typeof part?.type !== "string" || !part.type.startsWith("tool-") || part.state !== "output-available") continue;
      const o = part.output;
      if (!o) continue;
      if (Array.isArray(o.options)) {
        for (const c of o.options) {
          const [oh, ch] = String(c.hours ?? "10:00-18:00").split("-");
          const toH = (x: string) => { const [h, mm] = x.split(":").map(Number); return h + (mm || 0) / 60; };
          const opens = toH(oh);
          let closes = toH(ch);
          if (closes <= opens) closes += 24; // "00:00" closing round-trips as 0
          ctx.places.set(c.id, {
            id: c.id, name: c.name, category: c.category, lat: c.lat, lon: c.lon, cost: c.cost_inr, durationMin: c.duration_min,
            crowd: c.crowd, outdoor: c.outdoor, opens, closes: Math.min(closes, 24), veg: c.veg, tags: [], blurb: c.note ?? "", source: c.source, area: c.area,
          });
        }
      }
      if (o.prefs && o.prefs.city) ctx.prefs = o.prefs;
      // A draft that was built with a larger budget or time had it accepted because the user asked for it: it stays in force.
      const tot = o.itinerary?.totals;
      if (tot && ctx.prefs) {
        if (typeof tot.budget === "number" && tot.budget > ctx.prefs.budget) ctx.prefs = { ...ctx.prefs, budget: tot.budget };
        const h = typeof tot.availableMinutes === "number" ? Math.round((tot.availableMinutes / 60) * 100) / 100 : 0;
        if (h > ctx.prefs.availableHours) ctx.prefs = { ...ctx.prefs, availableHours: h };
      }
      if (o.center && o.weather !== undefined) {
        ctx.center = { ...o.center, city: o.city };
        if (o.country) ctx.country = o.country;
        ctx.place = { name: o.city, country: o.country ?? "", typed: o.interpreted_from };
        if (o.rain_chance != null) ctx.weather = { summary: o.weather, tempMax: o.temp_max ?? 30, rainChance: o.rain_chance, outdoorOk: !!o.outdoor_ok };
      }
    }
  }
}
