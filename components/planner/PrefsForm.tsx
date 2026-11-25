"use client";
import { useState } from "react";
import { Sparkles } from "lucide-react";

export type FormValues = {
  city: string;
  budget: number;
  available_time: string;
  start_time: string;
  start_location: string;
  people: number;
  mood: string;
  interests: string[];
  constraints: string[];
};

export const EXAMPLE: FormValues = {
  city: "Bangalore",
  budget: 2000,
  available_time: "4 hours",
  start_time: "10:00",
  start_location: "",
  people: 1,
  mood: "tired but wants to do something fun",
  interests: ["food", "music", "walks"],
  constraints: ["vegetarian", "avoid crowded places"],
};

const INTERESTS = ["food", "coffee", "music", "walks", "nature", "art", "culture", "history", "shopping", "movies", "temples", "views"];
const CONSTRAINTS = ["vegetarian", "vegan", "avoid crowded places", "less walking", "no alcohol", "kid friendly"];
const DAYPARTS: [string, string][] = [["Morning", "09:00"], ["Midday", "12:00"], ["Afternoon", "15:00"], ["Evening", "17:30"], ["Night", "19:30"]];
const GROUPS: [string, number][] = [["Solo", 1], ["2", 2], ["3", 3], ["4", 4], ["5", 5], ["6+", 6]];
const HOURS = ["2 hours", "3 hours", "4 hours", "5 hours", "6 hours", "8 hours"];

export function Chip({ on, children, onClick }: { on: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-xs transition ${
        on ? "border-indigo-500 bg-indigo-500 text-white" : "border-slate-300 bg-white text-slate-700 hover:border-indigo-400"
      }`}
    >
      {children}
    </button>
  );
}

const toggle = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

export function PrefsForm({
  initial,
  submitLabel = "Plan my Saturday",
  onSubmit,
  disabled,
  compact,
}: {
  initial?: Partial<FormValues>;
  submitLabel?: string;
  onSubmit: (v: FormValues) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [v, setV] = useState<FormValues>({
    city: initial?.city ?? "",
    budget: initial?.budget ?? 0,
    available_time: initial?.available_time ?? "4 hours",
    start_time: initial?.start_time ?? "10:00",
    start_location: initial?.start_location ?? "",
    people: initial?.people ?? 1,
    mood: initial?.mood ?? "",
    interests: initial?.interests ?? [],
    constraints: initial?.constraints ?? [],
  });
  const [customI, setCustomI] = useState("");
  const set = <K extends keyof FormValues>(k: K, val: FormValues[K]) => setV((p) => ({ ...p, [k]: val }));
  const allInterests = [...new Set([...INTERESTS, ...v.interests])];
  const allConstraints = [...new Set([...CONSTRAINTS, ...v.constraints])];
  const field = "w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-indigo-500";

  return (
    <form
      className={`space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm ${compact ? "text-sm" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(v);
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <label className="col-span-2 text-xs font-medium text-slate-600 sm:col-span-1">
          City
          <input className={field} value={v.city} onChange={(e) => set("city", e.target.value)} placeholder="e.g. Bangalore" autoComplete="off" />
        </label>
        <label className="col-span-2 text-xs font-medium text-slate-600 sm:col-span-1">
          Budget (₹, whole group)
          <input className={field} type="number" min={0} step={100} value={v.budget ? v.budget : ""} onChange={(e) => set("budget", Number(e.target.value))} placeholder="e.g. 2000" />
        </label>
        <label className="col-span-2 text-xs font-medium text-slate-600">
          Starting from <span className="font-normal text-slate-400">(optional: area or landmark)</span>
          <input className={field} value={v.start_location} onChange={(e) => set("start_location", e.target.value)} placeholder="e.g. Indiranagar, or Connaught Place" />
        </label>
        <div className="col-span-2">
          <div className="mb-1 text-xs font-medium text-slate-600">Who&apos;s going</div>
          <div className="flex flex-wrap gap-1.5">
            {GROUPS.map(([l, n]) => (
              <Chip key={l} on={v.people === n} onClick={() => set("people", n)}>{l}</Chip>
            ))}
          </div>
        </div>
        <div className="col-span-2">
          <div className="mb-1 text-xs font-medium text-slate-600">Start time</div>
          <div className="flex flex-wrap items-center gap-1.5">
            {DAYPARTS.map(([l, t]) => (
              <Chip key={l} on={v.start_time === t} onClick={() => set("start_time", t)}>{l}</Chip>
            ))}
            <input type="time" className="rounded-lg border border-slate-300 px-2 py-1 text-xs outline-none focus:border-indigo-500" value={v.start_time} onChange={(e) => set("start_time", e.target.value)} />
          </div>
        </div>
        <label className="col-span-2 text-xs font-medium text-slate-600">
          Available time
          <select className={field} value={v.available_time} onChange={(e) => set("available_time", e.target.value)}>
            {[...new Set([...HOURS, v.available_time])].map((h) => (
              <option key={h}>{h}</option>
            ))}
          </select>
        </label>
        <label className="col-span-2 text-xs font-medium text-slate-600">
          Mood
          <input className={field} value={v.mood} onChange={(e) => set("mood", e.target.value)} placeholder="e.g. tired but wants to do something fun" />
        </label>
      </div>

      <div>
        <div className="mb-1 text-xs font-medium text-slate-600">Interests</div>
        <div className="flex flex-wrap gap-1.5">
          {allInterests.map((i) => (
            <Chip key={i} on={v.interests.includes(i)} onClick={() => set("interests", toggle(v.interests, i))}>
              {i}
            </Chip>
          ))}
          <input
            className="w-24 rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs outline-none focus:border-indigo-500"
            placeholder="+ add"
            value={customI}
            onChange={(e) => setCustomI(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && customI.trim()) {
                e.preventDefault();
                set("interests", [...new Set([...v.interests, customI.trim().toLowerCase()])]);
                setCustomI("");
              }
            }}
          />
        </div>
      </div>

      <div>
        <div className="mb-1 text-xs font-medium text-slate-600">Constraints</div>
        <div className="flex flex-wrap gap-1.5">
          {allConstraints.map((c) => (
            <Chip key={c} on={v.constraints.includes(c)} onClick={() => set("constraints", toggle(v.constraints, c))}>
              {c}
            </Chip>
          ))}
        </div>
      </div>

      <button
        type="submit"
        disabled={disabled || !v.city.trim() || !(v.budget > 0)}
        title={!v.city.trim() || !(v.budget > 0) ? "Enter a city and a budget to continue" : undefined}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 disabled:hover:bg-slate-300"
      >
        <Sparkles size={16} /> {submitLabel}
      </button>
    </form>
  );
}

export const formToText = (v: FormValues) =>
  `Plan my perfect Saturday. Here are my details:\n${JSON.stringify(
    { city: v.city, ...(v.start_location?.trim() ? { start_location: v.start_location.trim() } : {}), people: v.people ?? 1, start_time: v.start_time ?? "10:00", budget: v.budget, available_time: v.available_time, mood: v.mood, interests: v.interests, constraints: v.constraints },
    null,
    2,
  )}`;

const fmtClock = (t?: string) => {
  const m = t?.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return t ?? "";
  const h = +m[1];
  return `${h % 12 || 12}:${m[2]} ${h >= 12 ? "PM" : "AM"}`;
};

type SummaryInput = Partial<Omit<FormValues, "people" | "budget">> & { people?: number; budget?: number };

/** Labelled key: value view of submitted trip details. */
export function PrefsSummary({ v, labelClass = "text-slate-500", valueClass = "text-slate-800" }: { v: SummaryInput; labelClass?: string; valueClass?: string }) {
  const rows: [string, string][] = [];
  if (v.city) rows.push(["City", v.city]);
  if (v.start_location) rows.push(["Starting from", v.start_location]);
  rows.push(["Who's going", v.people && v.people > 1 ? `${v.people} people` : "Solo"]);
  if (v.start_time) rows.push(["Start time", fmtClock(v.start_time)]);
  if (v.available_time) rows.push(["Time available", String(v.available_time)]);
  if (v.budget) rows.push(["Budget", `₹${Number(v.budget).toLocaleString("en-IN")}${v.people && v.people > 1 ? " (whole group)" : ""}`]);
  if (v.mood) rows.push(["Mood", v.mood]);
  if (v.interests?.length) rows.push(["Interests", v.interests.join(", ")]);
  rows.push(["Constraints", v.constraints?.length ? v.constraints.join(", ") : "None"]);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm leading-5">
      {rows.map(([k, val]) => (
        <div key={k} className="contents">
          <dt className={`font-medium ${labelClass}`}>{k}:</dt>
          <dd className={valueClass}>{val}</dd>
        </div>
      ))}
    </dl>
  );
}
