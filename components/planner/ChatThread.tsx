"use client";
import { ComposerPrimitive, ErrorPrimitive, MessagePrimitive, ThreadPrimitive, useAui, useAuiState, type ToolCallMessagePartProps } from "@assistant-ui/react";
import { useEffect, useRef } from "react";
import { ArrowUp, CheckCircle2, Loader2, Square, XCircle, AlertTriangle } from "lucide-react";
import { MarkdownText } from "./MarkdownText";
import { WARNING_MARK } from "@/lib/marks";
import { EXAMPLE, PrefsForm, PrefsSummary, formToText, type FormValues } from "./PrefsForm";

const TOOL_LABELS: Record<string, string> = {
  parse_preferences: "Understanding your preferences",
  get_weather: "Checking Saturday's weather",
  get_activity_options: "Finding activities nearby",
  get_food_options: "Finding food that fits",
  build_itinerary: "Building & validating the plan",
};

const TRY_CASES: { label: string; values: Partial<FormValues> | string }[] = [
  { label: "Example: Bangalore", values: EXAMPLE },
  { label: "Evening, group of 4", values: { city: "Delhi", budget: 6000, people: 4, start_time: "17:30", start_location: "Connaught Place", available_time: "4 hours", mood: "celebratory", interests: ["food", "music", "walks"], constraints: ["vegetarian"] } },
  { label: "Tiny budget (₹300)", values: { city: "Bangalore", budget: 300, available_time: "5 hours", mood: "bored", interests: ["food", "art", "walks"], constraints: ["vegetarian"] } },
  { label: "Other city: Pune", values: { city: "Pune", budget: 2500, available_time: "4 hours", mood: "energetic", interests: ["food", "walks", "culture"], constraints: [] } },
  { label: "Vague: just say hi", values: "I want to do something fun this Saturday" },
  { label: "Unknown city", values: { city: "Zzzxqwland", budget: 1500, available_time: "3 hours", mood: "curious", interests: ["food"], constraints: [] } },
];

function ToolChip({ toolName, result, status }: ToolCallMessagePartProps) {
  const r = result as any;
  const running = result === undefined && status?.type !== "incomplete";
  const failed = r?.error || (toolName === "build_itinerary" && r?.itinerary && !r.itinerary.validation.ok);
  const degraded = r?._spans?.some((s: any) => s.status === "fallback");
  const ms = r?._spans?.[0] ? r._spans[0].endMs - r._spans[0].startMs : null;
  let detail = "";
  if (toolName === "build_itinerary" && r?.itinerary) {
    const v = r.itinerary.validation;
    detail = v.ok ? `valid · ${r.itinerary.stops.length} stops` : `${v.issues.length} issue(s) → revising`;
  } else if (toolName === "get_weather" && r?.weather) detail = r.weather;
  else if (r?.count !== undefined) detail = `${r.count} options${r.source ? " · " + r.source : ""}`;
  else if (r?.missing?.length) detail = `missing: ${r.missing.join(", ")}`;
  else if (r?.error) detail = String(r.error).replace(/_/g, " ");
  return (
    <div className="my-1 flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600">
      <span className="mt-0.5">
        {running ? <Loader2 size={13} className="animate-spin text-indigo-500" /> : failed ? <XCircle size={13} className="text-rose-500" /> : degraded ? <AlertTriangle size={13} className="text-amber-500" /> : <CheckCircle2 size={13} className="text-emerald-500" />}
      </span>
      <span className="flex-1">
        <b className="font-medium text-slate-800">{TOOL_LABELS[toolName] ?? toolName}</b>
        {detail && <span className="text-slate-500"> — {detail}</span>}
        {degraded && <span className="text-amber-600"> (fallback used)</span>}
      </span>
      {ms !== null && <span className="tabular-nums text-slate-400">{ms} ms</span>}
    </div>
  );
}

function AskForm({ args, result, isError, addResult }: ToolCallMessagePartProps) {
  const a = args as { reason?: string; prefill?: Partial<FormValues>; suggestion?: { city: string; country?: string } };
  // Typing in the chat while the form is open closes the form with an error result. That is not a confirmation.
  const r0 = result as Partial<FormValues> | string | undefined;
  const answered = !isError && r0 !== undefined && typeof r0 === "object" && r0 !== null && Boolean(r0.city || r0.budget || r0.interests?.length || r0.mood || r0.start_location);
  if (result !== undefined && !answered) {
    return <div className="my-2 text-xs text-slate-400">Form skipped: you replied in the chat instead.</div>;
  }
  if (result !== undefined) {
    const r = result as Partial<FormValues>;
    return (
      <div className="my-2 rounded-xl border border-teal-200 bg-teal-50 p-3 text-teal-900">
        <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-teal-700">You confirmed</div>
        <PrefsSummary v={r} labelClass="text-teal-700" valueClass="text-teal-900" />
      </div>
    );
  }
  return (
    <div className="my-2">
      <p className="mb-2 text-sm text-slate-700">{a.reason ?? "Let me confirm a few details:"}</p>
      {a.suggestion && (
        <button
          type="button"
          onClick={() => addResult({ ...(a.prefill ?? {}), city: a.suggestion!.city })}
          className="mb-2 inline-flex items-center gap-1.5 rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-100"
        >
          Use {a.suggestion.city}{a.suggestion.country ? `, ${a.suggestion.country}` : ""}
        </button>
      )}
      <PrefsForm compact initial={a.prefill} submitLabel="Confirm & continue" onSubmit={(v) => addResult(v)} />
    </div>
  );
}

function WarningCallout({ raw }: { raw: string }) {
  const [title, ...rest] = raw.split(String.fromCharCode(10));
  return (
    <div role="status" className="my-2 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-900">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />
      <div className="min-w-0 text-[13px] leading-5">
        <div className="font-semibold">{title}</div>
        {rest.length > 0 && <div className="text-amber-800/90">{rest.join(" ")}</div>}
      </div>
    </div>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="mb-4 flex">
      <div className="max-w-full min-w-0 flex-1 text-[15px] leading-7 text-slate-700">
        <MessagePrimitive.Parts
          components={{
            Text: ({ text }: { text: string }) => (text.startsWith(WARNING_MARK) ? <WarningCallout raw={text.slice(WARNING_MARK.length)} /> : <MarkdownText />),
            tools: { by_name: { ask_user_preferences: AskForm }, Fallback: ToolChip },
          }}
        />
        <MessagePrimitive.Error>
          <ErrorPrimitive.Root className="my-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            <b className="font-medium">Something went wrong.</b> Please try again in a moment.
            <div className="mt-1 text-xs text-rose-600"><ErrorPrimitive.Message /></div>
          </ErrorPrimitive.Root>
        </MessagePrimitive.Error>
      </div>
    </MessagePrimitive.Root>
  );
}

function UserMessage() {
  const text = useAuiState((s) => (s.message.content as any[]).map((p) => (p.type === "text" ? p.text : "")).join(""));
  const isFeedback = text.startsWith("[feedback]");
  let form: any = null;
  if (text.startsWith("Plan my perfect Saturday")) {
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) form = JSON.parse(m[0]);
    } catch {
      form = null;
    }
  }
  return (
    <MessagePrimitive.Root className="mb-4 flex justify-end">
      {form ? (
        <div className="w-full max-w-[90%] rounded-2xl bg-indigo-600 px-4 py-3 text-white">
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-white/70">Your Saturday details</div>
          <PrefsSummary v={form} labelClass="text-white/70" valueClass="text-white" />
        </div>
      ) : (
        <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-[15px] leading-6 ${isFeedback ? "bg-teal-100 text-teal-900" : "bg-indigo-600 text-white"}`}>
          {isFeedback ? "↺ " + text.replace("[feedback]", "").trim() : text}
        </div>
      )}
    </MessagePrimitive.Root>
  );
}

function EmptyState() {
  const aui = useAui();
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => {
    top.current?.scrollIntoView({ block: "start" });
  }, []);
  const send = (t: string) => aui.thread().append(t);
  return (
    <div ref={top} className="space-y-4 pb-4">
      <div>
        <h2 className="mb-1 text-lg font-bold tracking-tight text-slate-900">Where to this Saturday?</h2>
        <p className="text-sm text-slate-600">Tell me your mood, budget and time, by form or just by typing. I&apos;ll check the weather and real places, then build a plan and double-check it works.</p>
      </div>
      <PrefsForm initial={{ ...EXAMPLE, city: "", budget: undefined, mood: "" }} onSubmit={(v) => send(formToText(v))} />
      <div>
        <div className="mb-1.5 text-xs font-medium text-slate-500">Try an edge case</div>
        <div className="flex flex-wrap gap-1.5">
          {TRY_CASES.map((t) => (
            <button
              key={t.label}
              className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 hover:border-indigo-400"
              onClick={() => send(typeof t.values === "string" ? t.values : formToText(t.values as FormValues))}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ChatThread() {
  const empty = useAuiState((s) => s.thread.messages.length === 0);
  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col bg-white">
      <ThreadPrimitive.Viewport autoScroll={!empty} className="flex-1 overflow-y-auto px-4 pt-4">
        <ThreadPrimitive.Empty>
          <EmptyState />
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages>
          {({ message }) => (message.role === "user" ? <UserMessage /> : <AssistantMessage />)}
        </ThreadPrimitive.Messages>
        <ThreadPrimitive.If running>
          <div className="mb-3 flex items-center gap-2 text-xs text-slate-500">
            <Loader2 size={13} className="animate-spin" /> Agent is working…
          </div>
        </ThreadPrimitive.If>
      </ThreadPrimitive.Viewport>
      <ComposerPrimitive.Root className="m-3 flex items-end gap-2 rounded-2xl border border-slate-300 bg-white p-2 shadow-sm focus-within:border-slate-500">
        <ComposerPrimitive.Input
          rows={1}
          placeholder="Ask or refine: “make it cheaper”, “swap the museum”…"
          className="max-h-32 min-h-[2rem] flex-1 resize-none bg-transparent px-2 py-1 text-[15px] outline-none placeholder:text-slate-400"
        />
        <ThreadPrimitive.If running={false}>
          <ComposerPrimitive.Send className="rounded-full bg-indigo-600 p-2 text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 disabled:hover:bg-slate-300">
            <ArrowUp size={16} />
          </ComposerPrimitive.Send>
        </ThreadPrimitive.If>
        <ThreadPrimitive.If running>
          <ComposerPrimitive.Cancel className="rounded-full bg-slate-700 p-2 text-white">
            <Square size={16} />
          </ComposerPrimitive.Cancel>
        </ThreadPrimitive.If>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}
