"use client";
import { Activity, AlertTriangle, Bot, CheckCircle2, CloudSun, Loader2, MapPinned, MessageSquare, Route, ShieldCheck, Sparkles, XCircle } from "lucide-react";
import type { Run } from "@/lib/derive";
import { Logo } from "./Logo";

const PILLARS = [
  { icon: Bot, title: "AI agent", body: "Reads your mood, budget and time, then decides which tools to call, the way a human planner would.", tone: "bg-violet-100 text-violet-700" },
  { icon: MapPinned, title: "Real places", body: "Live OpenStreetMap places and Saturday's actual forecast, with a curated backup when a source is down.", tone: "bg-emerald-100 text-emerald-700" },
  { icon: ShieldCheck, title: "Validated plans", body: "Every plan is checked for budget, time, opening hours, diet, crowds and weather. If it fails, it is repaired.", tone: "bg-sky-100 text-sky-700" },
  { icon: Activity, title: "Transparent runs", body: "See every model call and tool call with latency, tokens, inputs and outputs. Nothing is a black box.", tone: "bg-amber-100 text-amber-700" },
];

const FLOW: [string, string][] = [
  ["You tell it your mood, budget and time", "Form or free text. It asks follow-ups if something important is missing."],
  ["It checks the weather and finds real places", "Open-Meteo forecast plus OpenStreetMap, filtered by your interests, diet and crowd preference."],
  ["It drafts a schedule", "Order, timing, travel legs and per-person cost, using only places the tools actually returned."],
  ["It validates the draft", "Budget, time window, opening hours, diet, crowds, weather. Failed? It repairs the plan and tries again."],
  ["You review, tweak and share", "Map, timeline, directions. Swap a stop or say \"cheaper\" and it re-plans. Share a link."],
];

export function HowItWorks({ onOpenChat }: { onOpenChat?: () => void }) {
  return (
    <div className="mx-auto max-w-3xl space-y-6 py-2">
      <div className="flex items-center gap-4">
        <Logo size={88} />
        <div>
        <h2 className="text-xl font-bold tracking-tight text-slate-900">An AI agent that plans a day you can trust</h2>
        <p className="mt-1 text-sm text-slate-500">Fill in the form in the chat and watch it work.</p>
        {onOpenChat && (
          <button onClick={onOpenChat} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-indigo-700 lg:hidden">
            <MessageSquare size={15} />
            Open the chat form
          </button>
        )}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {PILLARS.map(({ icon: Icon, title, body, tone }) => (
          <div key={title} className="rounded-xl border border-slate-200 bg-white p-4">
            <span className={`mb-2 inline-flex h-9 w-9 items-center justify-center rounded-lg ${tone}`}>
              <Icon size={18} />
            </span>
            <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
            <p className="mt-1 text-[13px] leading-5 text-slate-500">{body}</p>
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Route size={16} className="text-indigo-600" />
          How a plan gets made
        </h3>
        <ol>
          {FLOW.map(([t, d], i) => (
            <li key={t} className="relative flex gap-3 pb-4 last:pb-0">
              {i < FLOW.length - 1 && <span className="absolute left-[13px] top-7 h-[calc(100%-1.75rem)] w-px bg-slate-200" />}
              <span className="z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-semibold text-white">{i + 1}</span>
              <div>
                <div className="text-sm font-medium text-slate-900">{t}</div>
                <div className="text-[13px] leading-5 text-slate-500">{d}</div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

const STEPS = [
  { key: "prefs", label: "Understanding your request", icon: Sparkles, tools: ["parse_preferences", "ask_user_preferences"] },
  { key: "weather", label: "Checking Saturday's weather", icon: CloudSun, tools: ["get_weather"] },
  { key: "places", label: "Finding real places nearby", icon: MapPinned, tools: ["get_activity_options", "get_food_options"] },
  { key: "plan", label: "Building and validating the plan", icon: ShieldCheck, tools: ["build_itinerary"] },
] as const;

type Status = "pending" | "running" | "done" | "fallback" | "error";

/** Live view of the agent's pipeline, driven by the real tool calls of the latest run. */
export function LiveSteps({ run }: { run: Run }) {
  const info = STEPS.map((st) => {
    const tools = run.tools.filter((t) => (st.tools as readonly string[]).includes(t.toolName));
    let status: Status = "pending";
    let detail = "";
    if (tools.length) {
      status = tools.some((t) => t.running) ? "running" : "done";
      const r = tools.map((t) => t.result as any);
      if (status === "done" && tools.some((t) => t.spans.some((s) => s.status === "fallback"))) status = "fallback";
      if (r.some((x) => x?.error)) status = "error";
      if (st.key === "weather" && r[0]?.weather) detail = r[0].weather;
      if (st.key === "places") detail = r.filter((x) => x?.count !== undefined).map((x) => `${x.count} options`).join(" + ");
      if (st.key === "prefs" && r[0]?.missing?.length) detail = `missing: ${r[0].missing.join(", ")}`;
      if (st.key === "plan") {
        const builds = tools.filter((t) => (t.result as any)?.itinerary);
        const last = builds.at(-1)?.result as any;
        if (last) {
          const n = last.itinerary.validation.issues.length;
          detail = `attempt ${builds.length}: ${n ? `${n} issue(s), repairing` : "all checks passed"}`;
          if (n) status = run.running ? "running" : "error";
        }
      }
    }
    return { ...st, status, detail };
  });
  // the first pending step after finished ones is "up next" while the agent is still going
  const firstPending = info.findIndex((i) => i.status === "pending");
  if (run.running && firstPending >= 0 && !info.some((i) => i.status === "running")) info[firstPending].status = "running";

  const tone: Record<Status, string> = {
    done: "bg-emerald-100 text-emerald-700",
    fallback: "bg-amber-100 text-amber-700",
    error: "bg-rose-100 text-rose-700",
    running: "bg-indigo-100 text-indigo-700",
    pending: "bg-slate-100 text-slate-400",
  };

  return (
    <div className="mx-auto max-w-xl space-y-4 py-4">
      <div className="text-center">
        <h2 className="text-lg font-bold tracking-tight text-slate-900">{run.running ? "The agent is working" : "Run finished"}</h2>
        <p className="text-sm text-slate-500">Each step below is a real tool call. Open the Agent trace tab for full detail.</p>
      </div>
      <ol className="space-y-2">
        {info.map(({ key, label, icon: Icon, status, detail }) => (
          <li key={key} className={`flex items-start gap-3 rounded-xl border p-3 ${status === "running" ? "border-indigo-300 bg-indigo-50" : "border-slate-200 bg-white"}`}>
            <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tone[status]}`}>
              <Icon size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <div className={`text-sm font-medium ${status === "pending" ? "text-slate-400" : "text-slate-900"}`}>{label}</div>
              {detail && <div className="truncate text-xs text-slate-500">{detail}</div>}
              {status === "fallback" && <div className="text-xs text-amber-700">A fallback data source was used</div>}
            </div>
            <span className="mt-1">
              {status === "running" ? (
                <Loader2 size={16} className="animate-spin text-indigo-500" />
              ) : status === "done" ? (
                <CheckCircle2 size={16} className="text-emerald-500" />
              ) : status === "fallback" ? (
                <AlertTriangle size={16} className="text-amber-500" />
              ) : status === "error" ? (
                <XCircle size={16} className="text-rose-500" />
              ) : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
