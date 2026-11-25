import type { Span } from "../types";

export type Ctx = {
  t0: number;
  spans: Span[];
  places: Map<string, import("../types").Place>;
  center?: { lat: number; lon: number; city: string };
  country?: string;
  /** The Saturday forecast request, shared by every tool that needs it so parallel tools make one call. */
  forecast?: Promise<NonNullable<Ctx["weather"]> & { date: string }>;
  /** Preferences as parsed by code: the authoritative source for constraints the model must not drift from. */
  prefs?: import("../types").Prefs;
  /** The structured form the user submitted this turn (set by the route), so parsing cannot corrupt it. */
  formPrefs?: Record<string, unknown>;
  place?: { name: string; country: string; typed?: string };
  /** The user's newest message, so a number they clearly wrote (a new budget, say) can be told from one the model invented. */
  latestUserText?: string;
  /** The city was unknown or doubtful, so a form that reopens must not be pre-filled with it. */
  cityRejected?: boolean;
  /** build_itinerary calls so far this request, to stop an endless repair loop. */
  buildCalls?: number;
  cityCache?: Map<string, Promise<import("./city").CityResolution>>;
  startCache?: Map<string, { name: string; lat: number; lon: number } | null>;
  weather?: { summary: string; tempMax: number; rainChance: number; outdoorOk: boolean };
};

let n = 0;
export const sid = () => `s${Date.now().toString(36)}${(n++).toString(36)}`;

/** Runs fn, recording a span (with timing, io, status). Child spans can be attached via parentId. */
export async function traced<T>(
  ctx: Ctx,
  name: string,
  input: unknown,
  fn: (span: { id: string; note: (s: string) => void; fallback: () => void }) => Promise<T> | T,
  opts: { parentId?: string; kind?: Span["kind"] } = {},
): Promise<T> {
  const span: Span = {
    id: sid(),
    parentId: opts.parentId,
    name,
    kind: opts.kind ?? (opts.parentId ? "internal" : "tool"),
    startMs: Date.now(),
    endMs: 0,
    input,
    status: "ok",
  };
  ctx.spans.push(span);
  try {
    const out = await fn({
      id: span.id,
      note: (s) => (span.note = s),
      fallback: () => (span.status = "fallback"),
    });
    span.output = out;
    return out;
  } catch (e) {
    span.status = "error";
    span.note = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    span.endMs = Date.now();
  }
}
