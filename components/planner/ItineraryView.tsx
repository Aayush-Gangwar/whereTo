"use client";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { Activity, AlertTriangle, Bus, Check, CheckCircle2, ExternalLink, Footprints, Link2, MapPin, ShieldCheck, ThumbsDown, ThumbsUp, Wallet, XCircle } from "lucide-react";
import type { Itinerary, Stop } from "@/lib/types";
import { clock, money } from "@/lib/derive";
import { stopColor } from "@/lib/colors";

const MapView = dynamic(() => import("./MapView"), { ssr: false, loading: () => <div className="h-72 animate-pulse rounded-xl bg-slate-100 sm:h-80" /> });

const EMOJI: Record<string, string> = {
  food: "🍽️", cafe: "☕", park: "🌳", museum: "🏛️", art: "🎨", music: "🎶", market: "🛍️", temple: "🛕", mall: "🏬", cinema: "🎬", viewpoint: "🌇", activity: "🎯",
};

const GENERIC = new Set(["the", "and", "of", "art", "arts", "gallery", "museum", "park", "garden", "gardens", "cafe", "restaurant", "centre", "center", "temple", "market", "palace", "house", "hall", "hotel", "kitchen", "shop", "bar", "club", "theatre", "auditorium"]);
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
/** Accept a Wikipedia hit only if its title contains the whole place name, or a distinctive (non-generic) word from it. */
function titleMatches(name: string, title: string) {
  const n = norm(name), t = norm(title);
  if (t.includes(n)) return true;
  const words = n.split(/\W+/).filter((w) => w.length > 2 && !GENERIC.has(w));
  return words.some((w) => t.includes(w));
}

const photoCache = new Map<string, string | null>();
function usePhoto(stop: Stop, city: string) {
  const key = stop.name;
  const [url, setUrl] = useState<string | null | undefined>(photoCache.get(key));
  useEffect(() => {
    if (photoCache.has(key)) return setUrl(photoCache.get(key));
    let dead = false;
    const q = encodeURIComponent(`${stop.wiki ?? stop.name} ${stop.wiki ? "" : city}`.trim());
    fetch(`https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${q}&gsrlimit=1&prop=pageimages&pithumbsize=640&format=json&origin=*`)
      .then((r) => r.json())
      .then((j) => {
        const page = Object.values(j?.query?.pages ?? {})[0] as any;
        // only trust a hit whose title overlaps the place name
        const ok = page && page.title && titleMatches(stop.name, page.title);
        const u = ok ? page.thumbnail?.source ?? null : null;
        photoCache.set(key, u);
        if (!dead) setUrl(u);
      })
      .catch(() => {
        photoCache.set(key, null);
        if (!dead) setUrl(null);
      });
    return () => {
      dead = true;
    };
  }, [key, stop.name, stop.wiki, city]);
  return url;
}

function Photo({ stop, city, color, onOpen }: { stop: Stop; city: string; color: string; onOpen: (u: string) => void }) {
  const url = usePhoto(stop, city);
  if (url)
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt={stop.name} onClick={() => onOpen(url)} className="h-28 w-full cursor-zoom-in rounded-lg object-cover transition hover:brightness-110 sm:h-full sm:w-36" loading="lazy" />
    );
  return (
    <div className="flex h-28 w-full items-center justify-center rounded-lg text-4xl sm:h-full sm:w-36" style={{ background: `linear-gradient(135deg, ${color}40, ${color}12)` }}>
      {EMOJI[stop.category]}
    </div>
  );
}

function Timeline({ it, selected, onSelect }: { it: Itinerary; selected: number | null; onSelect: (i: number) => void }) {
  const first = it.stops[0];
  const start = Math.floor((first.startMin - (first.legFromPrev?.minutes ?? 0)) / 60) * 60;
  const end = Math.ceil(it.stops[it.stops.length - 1].endMin / 60) * 60;
  const span = Math.max(end - start, 60);
  const pct = (m: number) => ((m - start) / span) * 100;
  const step = span / 60 <= 6 ? 60 : 120;
  const ticks: number[] = [];
  for (let t = start; t <= end; t += step) ticks.push(t);
  const hr = (m: number) => {
    const h = Math.floor(m / 60) % 24;
    return `${h % 12 || 12}${h >= 12 ? "pm" : "am"}`;
  };

  // cumulative spend (step line)
  let acc = 0;
  const pts: [number, number][] = [[start, 0]];
  it.stops.forEach((s) => {
    acc += s.legFromPrev?.cost ?? 0;
    pts.push([s.startMin, acc]);
    acc += s.cost;
    pts.push([s.endMin, acc]);
  });
  pts.push([end, acc]);
  const maxC = Math.max(it.totals.budget, acc, 1);
  const y = (c: number) => 100 - (c / maxC) * 92 - 4;
  const path = pts.map(([m, c], i) => `${i ? "L" : "M"}${pct(m)},${y(c)}`).join(" ");
  const budgetY = y(it.totals.budget);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
      <div className="mb-3 flex items-center justify-between text-xs">
        <span className="font-semibold text-slate-700">Day at a glance</span>
        <span className="text-slate-400">{clock(it.stops[0].startMin)} to {clock(it.stops[it.stops.length - 1].endMin)}</span>
      </div>

      {/* axis */}
      <div className="relative mb-1 h-4">
        {ticks.map((t, i) => (
          <span
            key={t}
            className="absolute whitespace-nowrap text-[10px] font-medium text-slate-400"
            style={{ left: `${pct(t)}%`, transform: i === 0 ? "none" : i === ticks.length - 1 ? "translateX(-100%)" : "translateX(-50%)" }}
          >
            {hr(t)}
          </span>
        ))}
      </div>

      {/* one swimlane per stop */}
      <div className="relative space-y-2.5">
        {ticks.map((t) => (
          <span key={t} className="pointer-events-none absolute inset-y-0 border-l border-dashed border-slate-200" style={{ left: `${pct(t)}%` }} />
        ))}
        {it.stops.map((s, i) => {
          const dur = s.endMin - s.startMin;
          return (
            <button
              key={i}
              onClick={() => onSelect(i)}
              className={`relative block w-full rounded-lg px-1 py-1 text-left transition ${selected === i ? "bg-slate-100 ring-1 ring-slate-300" : "hover:bg-slate-50"}`}
            >
              <div className="relative flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white" style={{ background: stopColor(i) }}>{i + 1}</span>
                  <span className="truncate font-medium text-slate-800">{s.name}</span>
                </span>
                <span className="shrink-0 tabular-nums text-slate-500">{clock(s.startMin)} · {dur} min{s.cost ? ` · ${money(s.cost)}` : ""}</span>
              </div>
              <div className="relative mt-1 h-2.5 rounded-full bg-slate-100/80">
                {s.legFromPrev && (
                  <span
                    className="absolute top-0 h-2.5 rounded-full bg-[repeating-linear-gradient(45deg,#cbd5e1,#cbd5e1_3px,#f1f5f9_3px,#f1f5f9_6px)]"
                    style={{ left: `${pct(s.startMin - s.legFromPrev.minutes)}%`, width: `${(s.legFromPrev.minutes / span) * 100}%` }}
                    title={`${s.legFromPrev.mode} · ${s.legFromPrev.minutes} min`}
                  />
                )}
                <span className="absolute top-0 h-2.5 rounded-full" style={{ left: `${pct(s.startMin)}%`, width: `${Math.max((dur / span) * 100, 1.5)}%`, background: stopColor(i) }} />
              </div>
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-slate-500">
        <span className="flex items-center gap-1"><i className="inline-block h-2 w-5 rounded-full bg-indigo-500" />time at stop</span>
        <span className="flex items-center gap-1"><i className="inline-block h-2 w-5 rounded-full bg-[repeating-linear-gradient(45deg,#cbd5e1,#cbd5e1_3px,#f1f5f9_3px,#f1f5f9_6px)]" />travel</span>
      </div>

      <div className="mt-4 border-t border-slate-100 pt-3">
        <div className="mb-1 flex justify-between text-xs">
          <span className="font-semibold text-slate-700">Spend over the day</span>
          <span className={acc > it.totals.budget ? "font-medium text-rose-600" : "text-slate-500"}>{money(acc)} of {money(it.totals.budget)} budget</span>
        </div>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-16 w-full overflow-visible rounded-md bg-slate-50">
          <line x1="0" x2="100" y1={budgetY} y2={budgetY} stroke="#e11d48" strokeDasharray="3 2" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <path d={`${path} L${pct(end)},100 L0,100 Z`} fill="#6366f122" />
          <path d={path} fill="none" stroke="#4f46e5" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="mt-1 flex items-center gap-1 text-[10px] text-slate-400"><i className="inline-block h-0 w-4 border-t border-dashed border-rose-500" />budget limit</div>
      </div>
    </div>
  );
}

export type Extras = {
  notes: Record<string, string>;
  setNote: (id: string, v: string) => void;
  liked: Record<string, "up" | "down">;
  feedback?: (stop: Stop, kind: "up" | "down") => void;
  quick?: (text: string) => void;
  onOpenTrace?: () => void;
  readOnly?: boolean;
};

function ValidationStrip({ it, onOpenTrace }: { it: Itinerary; onOpenTrace?: () => void }) {
  const issues = it.validation.issues.join(" ").toLowerCase();
  const warns = it.validation.warnings.join(" ").toLowerCase();
  const st = (bad: boolean, warn: boolean) => (bad ? "fail" : warn ? "warn" : "pass");
  const h = Math.floor(it.totals.minutes / 60);
  const m = Math.round(it.totals.minutes % 60);
  const checks: { label: string; detail: string; s: "pass" | "warn" | "fail" }[] = [
    { label: "Budget", detail: `${money(it.totals.cost)} of ${money(it.totals.budget)}`, s: st(/budget/.test(issues), /budget/.test(warns)) },
    { label: "Time window", detail: `${h}h ${m}m of ${Math.round(it.totals.availableMinutes / 60)}h`, s: st(/plan runs|packed/.test(issues), /travel is/.test(warns)) },
    { label: "Opening hours", detail: "open when you arrive", s: st(/opens at|closes at/.test(issues), /wait for opening/.test(warns)) },
  ];
  if (it.flags?.vegetarian) checks.push({ label: "Vegetarian", detail: /vegetarian/.test(warns) ? "confirm menus" : "diet respected", s: st(/vegetarian/.test(issues), /vegetarian/.test(warns)) });
  if (it.flags?.avoidCrowds) checks.push({ label: "Crowds", detail: "quiet spots only", s: st(/crowd/.test(issues), false) });
  if (it.weather) checks.push({ label: "Weather", detail: `${it.weather.rainChance}% rain`, s: st(/rain/.test(issues), /heat|dark/.test(warns)) });
  const osm = it.stops.filter((s) => s.source === "osm").length;
  const cur = it.stops.length - osm;
  const tone = { pass: "border-emerald-200 bg-emerald-50 text-emerald-800", warn: "border-amber-200 bg-amber-50 text-amber-800", fail: "border-rose-200 bg-rose-50 text-rose-800" };
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
          <ShieldCheck size={14} className="text-sky-600" />
          Validated by WhereTo
        </span>
        {onOpenTrace && (
          <button onClick={onOpenTrace} className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline">
            <Activity size={12} />
            See how it was planned
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {checks.map((c) => (
          <div key={c.label} className={`flex items-start gap-1.5 rounded-lg border px-2 py-1.5 text-xs ${tone[c.s]}`}>
            {c.s === "pass" ? <CheckCircle2 size={13} className="mt-0.5 shrink-0" /> : c.s === "warn" ? <AlertTriangle size={13} className="mt-0.5 shrink-0" /> : <XCircle size={13} className="mt-0.5 shrink-0" />}
            <span className="min-w-0">
              <b className="font-semibold">{c.label}</b>
              <span className="block truncate opacity-80">{c.detail}</span>
            </span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-slate-400">
        Places: {osm ? `${osm} live from OpenStreetMap` : ""}{osm && cur ? ", " : ""}{cur ? `${cur} curated` : ""} {"·"} Weather: Open-Meteo forecast {"·"} Travel times: estimated
      </p>
    </div>
  );
}

export function ItineraryView({ it, extras }: { it: Itinerary; extras: Extras }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const v = it.validation;

  const share = async () => {
    const payload = { ...it, notes: extras.notes };
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    const url = `${location.origin}/s#${b64}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      prompt("Copy this link", url);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const overBudget = it.totals.cost > it.totals.budget;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{it.title}</h2>
          <p className="text-xs text-slate-500">
            <b className="font-semibold text-slate-700">{it.place ? `${it.place.name}${it.place.country ? ", " + it.place.country : ""}` : it.city}</b> · {it.people > 1 ? `${it.people} people` : "Solo"}{it.start ? ` · from ${it.start.name}` : ""} · {it.weather ? `Sat: ${it.weather.summary}` : "weather n/a"}
          </p>
          {it.place?.typed && it.place.typed.toLowerCase().replace(/[^a-z0-9]/g, "") !== it.place.name.toLowerCase().replace(/[^a-z0-9]/g, "") && (
            <p className="mt-1 inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800">
              <AlertTriangle size={11} />Understood &ldquo;{it.place.typed}&rdquo; as {it.place.name}. Wrong city? Ask for another.
            </p>
          )}
        </div>
        {!extras.readOnly && (
          <button onClick={share} className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-indigo-400">
            {copied ? <Check size={14} className="text-emerald-600" /> : <Link2 size={14} />} {copied ? "Link copied" : "Share itinerary"}
          </button>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <div className={`rounded-lg border p-2 ${overBudget ? "border-rose-300 bg-rose-50" : "border-slate-200 bg-white"}`}>
          <Wallet size={14} className="mx-auto mb-0.5 text-slate-400" />
          <b className="text-sm">{money(it.totals.cost)}</b>
          <div className="text-slate-500">of {money(it.totals.budget)}{it.people > 1 ? ` · ${it.people} ppl` : ""}</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-2">
          <div className="mb-0.5 text-slate-400">⏱</div>
          <b className="text-sm">{Math.floor(it.totals.minutes / 60)}h {Math.round(it.totals.minutes % 60)}m</b>
          <div className="text-slate-500">of {Math.round(it.totals.availableMinutes / 60)}h</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-2">
          <Bus size={14} className="mx-auto mb-0.5 text-slate-400" />
          <b className="text-sm">{it.totals.travelMinutes} min</b>
          <div className="text-slate-500">travelling</div>
        </div>
      </div>

      <ValidationStrip it={it} onOpenTrace={extras.onOpenTrace} />

      {!v.ok && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
          <b>This draft failed validation:</b>
          <ul className="ml-4 list-disc">{v.issues.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      )}
      {v.warnings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <div className="mb-0.5 flex items-center gap-1 font-medium"><AlertTriangle size={13} /> Heads-up</div>
          <ul className="ml-4 list-disc">{v.warnings.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      )}

      <Timeline it={it} selected={selected} onSelect={setSelected} />
      <MapView it={it} selected={selected} onSelect={setSelected} />

      <ol className="space-y-3">
        {it.stops.map((s, i) => (
          <li key={s.placeId + i}>
            {s.legFromPrev && (
              <div className="mb-2 flex flex-wrap items-center gap-2 pl-3 text-xs text-slate-500">
                {s.legFromPrev.mode === "walk" ? <Footprints size={13} /> : <Bus size={13} />}
                <span>
                  {s.legFromPrev.mode === "walk" ? "Walk" : "Auto / cab"} · {s.legFromPrev.km} km · ~{s.legFromPrev.minutes} min
                  {s.legFromPrev.cost > 0 && ` · ~${money(s.legFromPrev.cost)}`}
                </span>
                <a href={s.legFromPrev.mapsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-indigo-600 hover:underline">
                  Directions <ExternalLink size={11} />
                </a>
              </div>
            )}
            <div
              onClick={() => setSelected(i)}
              style={{ borderLeft: `4px solid ${stopColor(i)}`, ...(selected === i ? { boxShadow: `0 0 0 2px ${stopColor(i)}66, 0 6px 16px rgba(15,23,42,.10)` } : {}) }}
              className="flex cursor-pointer flex-col gap-3 rounded-xl border border-slate-200 bg-white p-3 transition hover:shadow-sm sm:flex-row"
            >
              <Photo stop={s} city={it.city} color={stopColor(i)} onOpen={setLightbox} />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold text-white" style={{ background: stopColor(i) }}>{i + 1}</span>
                  <h3 className="font-semibold text-slate-900">{s.name}</h3>
                  <span className="text-xs text-slate-500">{clock(s.startMin)} – {clock(s.endMin)}</span>
                </div>
                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">{s.category}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">{s.cost ? money(s.cost) + (it.people > 1 ? " pp" : "") : "free"}</span>
                  <span className={`rounded px-1.5 py-0.5 ${s.crowd === "high" ? "bg-rose-100 text-rose-700" : s.crowd === "medium" ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>{s.crowd} crowd</span>
                  {(s.category === "food" || s.category === "cafe") && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">veg: {s.veg}</span>}
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">{s.source === "osm" ? "OpenStreetMap" : "curated"}</span>
                </div>
                <p className="text-sm text-slate-700"><b className="font-medium">Why it fits:</b> {s.why}</p>
                {s.tradeOff && <p className="text-xs text-amber-700"><b className="font-medium">Trade-off:</b> {s.tradeOff}</p>}
                <p className="text-xs text-slate-500">{s.blurb}</p>
                <div className="flex flex-wrap items-center gap-2 pt-1" onClick={(e) => e.stopPropagation()}>
                  <a className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lon}`}>
                    <MapPin size={12} /> Open in Maps
                  </a>
                  {!extras.readOnly && extras.feedback && (
                    <>
                      <button onClick={() => extras.feedback!(s, "up")} className={`rounded-md border px-2 py-0.5 text-xs ${extras.liked[s.placeId] === "up" ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-slate-300 text-slate-600 hover:border-emerald-400"}`}>
                        <ThumbsUp size={12} className="mr-1 inline" />Keep
                      </button>
                      <button onClick={() => extras.feedback!(s, "down")} className="rounded-md border border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:border-rose-400">
                        <ThumbsDown size={12} className="mr-1 inline" />Swap it
                      </button>
                    </>
                  )}
                </div>
                <textarea
                  rows={1}
                  readOnly={extras.readOnly}
                  value={extras.notes[s.placeId] ?? ""}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => extras.setNote(s.placeId, e.target.value)}
                  placeholder={extras.readOnly ? "" : "Add a note (shared with the link)…"}
                  className={`w-full resize-none rounded-md border border-slate-200 px-2 py-1 text-xs outline-none focus:border-indigo-400 ${extras.readOnly && !extras.notes[s.placeId] ? "hidden" : ""}`}
                />
              </div>
            </div>
          </li>
        ))}
      </ol>

      {!extras.readOnly && extras.quick && (
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <div className="mb-1.5 text-xs font-medium text-slate-600">Not quite right? Tell the agent:</div>
          <div className="flex flex-wrap gap-1.5">
            {[
              ["Make it cheaper", "Make the plan cheaper"],
              ["Less walking", "I want less walking, more relaxed"],
              ["More food", "Add more food stops"],
              ["Shorter day", "Make it shorter, about 3 hours"],
              ["More adventurous", "Make it more adventurous and lively"],
            ].map(([l, t]) => (
              <button key={l} onClick={() => extras.quick!(`[feedback] ${t}`)} className="rounded-full border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:border-indigo-400">
                {l}
              </button>
            ))}
          </div>
        </div>
      )}

      {lightbox && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 p-4" onClick={() => setLightbox(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox} alt="" className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </div>
  );
}
