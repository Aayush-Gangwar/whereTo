import { fmt } from "./plan";

/**
 * What the MODEL sees of each tool result. The full structured result still goes to the UI, the trace and the saved
 * conversation; the model gets a short, fact-dense text instead. Drops everything it cannot use for a decision
 * (coordinates, blurbs, links, internal trace data), which is where most of the input tokens used to go.
 */

const rupee = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const lines = (title: string, items: string[]) => (items.length ? `${title}:\n${items.map((x) => `- ${x}`).join("\n")}` : "");

export function viewPrefs(o: any): string {
  if (!o) return "parse_preferences: no result";
  const p = o.prefs;
  const head = p
    ? `PREFERENCES city=${p.city}; budget=${rupee(p.budget)} total; time=${p.availableHours}h from ${fmt(p.startHour * 60)}; people=${p.people}` +
      `${p.startLocation ? `; from=${p.startLocation}` : ""}; mood=${p.mood || "-"}; interests=${(p.interests ?? []).join(",") || "-"}; ` +
      `constraints=${(p.constraints ?? []).join(",") || "-"}; flags=${Object.entries(p.flags ?? {}).filter(([, v]) => v).map(([k]) => k).join(",") || "none"}`
    : `PREFERENCES incomplete; missing=${(o.missing ?? []).join(",")}`;
  return [head, o.notes?.length ? `notes: ${o.notes.join(" ")}` : "", `next: ${o.next ?? ""}`].filter(Boolean).join("\n");
}

export function viewWeather(o: any): string {
  if (!o) return "get_weather: no result";
  if (o.error) return `get_weather ERROR ${o.error}: ${o.message ?? ""}`;
  const where = `${o.city}${o.country ? ", " + o.country : ""}`;
  const interp = o.interpreted_from ? ` (understood from "${o.interpreted_from}")` : "";
  const wx = o.degraded ? "forecast unavailable, assume fair weather" : `${o.weather}; outdoor_ok=${o.outdoor_ok}`;
  return `WEATHER ${where}${interp}: ${wx}. Saturday=${o.saturday ?? "?"}`;
}

/** One line per candidate: everything needed to choose, nothing more. Ids are what build_itinerary accepts. */
export function viewOptions(o: any, kind: "activities" | "food"): string {
  if (!o) return `${kind}: no result`;
  if (o.error) return `${kind.toUpperCase()} ERROR ${o.error}`;
  const rows = (o.options ?? []).map((c: any) => {
    const food = c.category === "food" || c.category === "cafe";
    const cols = [
      c.id,
      c.name,
      c.category,
      c.cost_inr ? rupee(c.cost_inr) : "free",
      `${c.duration_min}m`,
      `crowd:${c.crowd}`,
      c.outdoor ? "outdoor" : "indoor",
      ...(food ? [`veg:${c.veg}`] : []),
      c.hours,
      c.km_from_center !== undefined ? `${c.km_from_center}km` : "",
    ];
    const note = c.source === "curated" && c.note ? ` | ${String(c.note).slice(0, 70)}` : "";
    return cols.filter((x) => x !== "").join(" | ") + note;
  });
  const head = `${kind.toUpperCase()} (${o.count ?? rows.length}) columns: id | name | category | price per person | visit | crowd | setting | ${kind === "food" ? "diet | " : ""}opening hours | distance`;
  return [
    head,
    ...rows,
    o.empty ? `EMPTY: ${o.empty}` : "",
    lines("notes", o.notes ?? []),
    o.relaxed ? `RELAXED: ${o.relaxed}` : "",
    o.dropped_by_filters?.length ? `excluded: ${o.dropped_by_filters.join("; ")}` : "",
  ].filter(Boolean).join("\n");
}

/** The validated plan in a few lines: enough to explain it and to repair it, without the whole itinerary object. */
export function viewBuild(o: any): string {
  if (!o?.itinerary) return o?.error ? `build_itinerary ERROR ${o.error}${o.message ? ": " + o.message : ""}` : "build_itinerary: no result";
  const it = o.itinerary;
  const v = it.validation;
  const sched = (it.stops ?? []).map((s: any) => {
    const leg = s.legFromPrev ? ` [${s.legFromPrev.mode} ${s.legFromPrev.minutes}m${s.legFromPrev.cost ? " " + rupee(s.legFromPrev.cost) : ""}]` : "";
    return `${fmt(s.startMin)}-${fmt(s.endMin)} ${s.name} (${s.placeId}) ${s.cost ? rupee(s.cost) + " pp" : "free"}${leg}`;
  });
  const t = it.totals;
  return [
    `PLAN ok=${v.ok} stops=${(it.stops ?? []).length}`,
    lines("issues (must fix)", v.issues ?? []),
    lines("warnings (mention honestly)", v.warnings ?? []),
    lines("schedule", sched),
    `totals: cost ${rupee(t.cost)} of ${rupee(t.budget)}; time ${Math.round(t.minutes)}m of ${Math.round(t.availableMinutes)}m; travel ${t.travelMinutes}m; people ${it.people}`,
    o.instruction ? `instruction: ${o.instruction}` : "",
  ].filter(Boolean).join("\n");
}
