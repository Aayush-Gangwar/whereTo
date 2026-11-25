import type { UIMessage } from "ai";
import { extractPrefs } from "./fallback";
import { statedIn } from "./prefs";
import type { Ctx } from "./trace";

/**
 * What the server already knows about the user's outing, in the shape of the in-chat form. The form is pre-filled from
 * this, so it never reopens blank just because the model forgot to pass `prefill`.
 *
 * Order, weakest first: details found in the conversation (the submitted form, earlier form answers), then what the
 * parser understood this request, then the form submitted this turn.
 */
export function knownDetails(ctx: Ctx, messages: UIMessage[]): Record<string, unknown> {
  const fromHistory = extractPrefs(messages as any[]).prefs as Record<string, unknown>;
  const P = ctx.prefs;
  const fromPrefs: Record<string, unknown> = P
    ? {
        city: P.city,
        budget: P.budget,
        available_time: `${P.availableHours} hours`,
        start_time: `${String(Math.floor(P.startHour)).padStart(2, "0")}:${String(Math.round((P.startHour % 1) * 60)).padStart(2, "0")}`,
        start_location: P.startLocation,
        people: P.people,
        mood: P.mood,
        interests: P.interests,
        constraints: P.constraints,
      }
    : {};
  const out = { ...clean(fromHistory), ...clean(fromPrefs), ...clean((ctx.formPrefs ?? {}) as Record<string, unknown>) };
  if (ctx.cityRejected) delete out.city; // the city is what needs fixing: do not offer the rejected one back
  return out;
}

const present = (v: unknown) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => present(v)));

function asObject(v: unknown): Record<string, unknown> {
  if (typeof v === "string") {
    try {
      const j = JSON.parse(v);
      return j && typeof j === "object" && !Array.isArray(j) ? j : {};
    } catch {
      return {};
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * The prefill the browser will show: what the server knows, plus whatever the model adds for fields the server has no
 * value for. The one exception is a number the user wrote in their newest message (a new budget or time): that is
 * newer than the form, so the model's copy of it wins.
 */
export function mergePrefill(modelPrefill: unknown, ctx: Ctx, messages: UIMessage[]): Record<string, unknown> {
  const model = clean(asObject(modelPrefill));
  const known = knownDetails(ctx, messages);
  const merged: Record<string, unknown> = { ...model, ...known };
  if (typeof model.budget === "number" && model.budget !== known.budget && statedIn(ctx.latestUserText, model.budget)) merged.budget = model.budget;
  const hours = Number.parseFloat(String(model.available_time ?? ""));
  if (model.available_time !== undefined && model.available_time !== known.available_time && statedIn(ctx.latestUserText, hours)) merged.available_time = model.available_time;
  return merged;
}
