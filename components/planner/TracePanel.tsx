"use client";
import { useState } from "react";
import { Activity, AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Brain, ChevronDown, ChevronRight, CornerDownRight, Hand, Timer, Wrench, XCircle, Zap } from "lucide-react";
import type { FeedbackEvent, Run } from "@/lib/derive";
import type { Span } from "@/lib/types";
import { JsonView } from "./JsonView";

type Kind = "llm" | "tool" | "internal" | "human";
type Row = {
  key: string;
  label: string;
  kind: Kind;
  depth: number;
  start: number;
  end: number;
  status: "ok" | "error" | "fallback" | "running";
  note?: string;
  tokensIn?: number;
  tokensOut?: number;
  input?: unknown;
  output?: unknown;
};

// Distinct hues per kind. Fallback = amber hatched, human = teal, error = red, so none are confusable.
const KIND: Record<Kind, { bar: string; soft: string; text: string; label: string }> = {
  llm: { bar: "#7c3aed", soft: "bg-violet-50", text: "text-violet-700", label: "LLM call" },
  tool: { bar: "#2563eb", soft: "bg-blue-50", text: "text-blue-700", label: "Tool" },
  internal: { bar: "#64748b", soft: "bg-slate-100", text: "text-slate-600", label: "Sub-step" },
  human: { bar: "#0d9488", soft: "bg-teal-50", text: "text-teal-700", label: "Human input" },
};
const FALLBACK_BG = "repeating-linear-gradient(45deg,#f59e0b,#f59e0b 5px,#fbbf24 5px,#fbbf24 10px)";
const barStyle = (r: Row) =>
  r.status === "error" ? { background: "#dc2626" } : r.status === "fallback" ? { background: FALLBACK_BG } : { background: KIND[r.kind].bar };

const stripSpans = (o: any) => {
  if (!o || typeof o !== "object") return o;
  const { _spans, ...rest } = o;
  return rest;
};

function buildRows(run: Run): Row[] {
  const rows: Row[] = [];
  run.llm.forEach((l) =>
    rows.push({
      key: `llm${l.step}`,
      label: `LLM step ${l.step}`,
      kind: "llm",
      depth: 0,
      start: l.startMs,
      end: l.endMs,
      status: "ok",
      tokensIn: l.tokensIn,
      tokensOut: l.tokensOut,
      note: l.toolCalls?.length ? `decided to call: ${l.toolCalls.join(", ")}` : "wrote the final answer",
      input: { prompt_tokens: l.tokensIn },
      output: { completion_tokens: l.tokensOut, finish_reason: l.finishReason, tool_calls: l.toolCalls },
    }),
  );
  const firstStart = Math.min(...[...run.llm.map((l) => l.startMs), ...run.tools.flatMap((t) => t.spans.map((s) => s.startMs))].filter(Boolean));
  for (const t of run.tools) {
    if (t.toolName === "ask_user_preferences") {
      const at = isFinite(firstStart) ? firstStart : 0;
      rows.push({ key: t.id, label: "ask_user_preferences", kind: "human", depth: 0, start: at, end: 0, status: t.running ? "running" : "ok", note: "form shown to the user; their submission is the tool result", input: t.args, output: t.result });
      continue;
    }
    if (!t.spans.length) {
      rows.push({ key: t.id, label: t.toolName, kind: "tool", depth: 0, start: 0, end: 0, status: t.running ? "running" : "ok", input: t.args });
      continue;
    }
    const root = t.spans.find((s) => !s.parentId) as Span;
    rows.push({ key: root.id, label: root.name, kind: "tool", depth: 0, start: root.startMs, end: root.endMs, status: root.status, note: root.note, input: t.args, output: stripSpans(t.result) });
    t.spans
      .filter((s) => s.parentId === root.id)
      .forEach((c) => rows.push({ key: c.id, label: c.name, kind: "internal", depth: 1, start: c.startMs, end: c.endMs, status: c.status, note: c.note }));
  }
  return rows.sort((a, b) => (a.start || Infinity) - (b.start || Infinity) || a.depth - b.depth);
}

const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`);

function Stat({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-2.5 py-2">
      <div className="flex items-center gap-1 truncate text-[10px] font-medium uppercase tracking-wide text-slate-400">{icon}<span className="truncate">{label}</span></div>
      <div className={`mt-0.5 text-base font-semibold tabular-nums ${tone ?? "text-slate-900"}`}>{value}</div>
    </div>
  );
}

function StatusBadge({ r }: { r: Row }) {
  if (r.status === "fallback") return <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800"><AlertTriangle size={10} />FALLBACK</span>;
  if (r.status === "error") return <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700"><XCircle size={10} />ERROR</span>;
  if (r.status === "running") return <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-700">RUNNING</span>;
  if (r.kind === "human") return <span className="inline-flex items-center gap-1 rounded-full bg-teal-100 px-2 py-0.5 text-[10px] font-semibold text-teal-700"><Hand size={10} />HUMAN</span>;
  return <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">OK</span>;
}

function KindIcon({ r }: { r: Row }) {
  const cls = `shrink-0 ${r.status === "fallback" ? "text-amber-600" : KIND[r.kind].text}`;
  if (r.kind === "llm") return <Brain size={13} className={cls} />;
  if (r.kind === "human") return <Hand size={13} className={cls} />;
  if (r.kind === "internal") return <CornerDownRight size={12} className={cls} />;
  return <Wrench size={13} className={cls} />;
}

function Detail({ r }: { r: Row }) {
  const dur = r.end > 0 ? r.end - r.start : null;
  return (
    <div className="mb-2 ml-5 mt-1 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-1.5 text-[11px]">
        <StatusBadge r={r} />
        {dur !== null && <span className="inline-flex items-center gap-1 text-slate-600"><Timer size={11} />{ms(dur)}</span>}
        {r.tokensIn !== undefined && (
          <>
            <span className="inline-flex items-center gap-1 rounded bg-sky-50 px-1.5 py-0.5 font-medium text-sky-700"><ArrowDownToLine size={11} />{r.tokensIn.toLocaleString()} input tokens</span>
            <span className="inline-flex items-center gap-1 rounded bg-fuchsia-50 px-1.5 py-0.5 font-medium text-fuchsia-700"><ArrowUpFromLine size={11} />{r.tokensOut?.toLocaleString()} completion tokens</span>
          </>
        )}
        {r.note && <span className={`${r.status === "fallback" ? "text-amber-700" : "text-slate-500"}`}>{r.note}</span>}
      </div>
      {(r.input !== undefined || r.output !== undefined) && (
        <div className="grid divide-slate-200 md:grid-cols-2 md:divide-x">
          <div className="p-2.5">
            <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-sky-600"><ArrowDownToLine size={11} />Input</div>
            <JsonView data={r.input} />
          </div>
          <div className="border-t border-slate-200 p-2.5 md:border-t-0">
            <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-600"><ArrowUpFromLine size={11} />Output</div>
            <JsonView data={r.output} />
          </div>
        </div>
      )}
    </div>
  );
}

function RunView({ run, index }: { run: Run; index: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const rows = buildRows(run);
  const timed = rows.filter((r) => r.end > 0);
  const t0 = timed.length ? Math.min(...timed.map((r) => r.start)) : 0;
  const t1 = timed.length ? Math.max(...timed.map((r) => r.end)) : 1;
  const total = Math.max(t1 - t0, 1);
  const tokIn = run.llm.reduce((t, l) => t + l.tokensIn, 0);
  const tokOut = run.llm.reduce((t, l) => t + l.tokensOut, 0);
  const llmMs = run.llm.reduce((t, l) => t + (l.endMs - l.startMs), 0);
  const toolCalls = run.tools.filter((t) => t.toolName !== "ask_user_preferences").length;
  const fallbacks = rows.filter((r) => r.status === "fallback").length;
  const inPct = tokIn + tokOut ? (tokIn / (tokIn + tokOut)) * 100 : 50;
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="space-y-2.5 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Run {index + 1}</h3>
        {run.model && (run.model.startsWith("built-in") ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800"><AlertTriangle size={10} />Built-in planner: AI unavailable</span>
        ) : (
          <span className="rounded-full bg-white px-2 py-0.5 font-mono text-[10px] text-slate-500 ring-1 ring-slate-200">{run.model}</span>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <Stat icon={<Timer size={10} />} label="Latency" value={ms(total)} />
        <Stat icon={<Brain size={10} />} label="LLM calls" value={run.llm.length} tone="text-violet-700" />
        <Stat icon={<Wrench size={10} />} label="Tool calls" value={toolCalls} tone="text-blue-700" />
        <Stat icon={<ArrowDownToLine size={10} />} label="Input tokens" value={tokIn.toLocaleString()} tone="text-sky-700" />
        <Stat icon={<ArrowUpFromLine size={10} />} label="Output tokens" value={tokOut.toLocaleString()} tone="text-fuchsia-700" />
        <Stat icon={<AlertTriangle size={10} />} label="Fallbacks" value={fallbacks} tone={fallbacks ? "text-amber-600" : "text-slate-900"} />
      </div>

      {tokIn + tokOut > 0 && (
        <div>
          <div className="flex h-2 overflow-hidden rounded-full bg-slate-200">
            <div className="bg-sky-500" style={{ width: `${inPct}%` }} title="input tokens" />
            <div className="bg-fuchsia-500" style={{ width: `${100 - inPct}%` }} title="output tokens" />
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-slate-500">
            <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-sky-500" />input {Math.round(inPct)}%</span>
            <span>model {ms(llmMs)} · tools {ms(Math.max(total - llmMs, 0))}</span>
            <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-fuchsia-500" />output {Math.round(100 - inPct)}%</span>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white p-2">
        <div className="relative mb-1 ml-[18px] h-4 text-[10px] text-slate-400">
          {ticks.map((t) => (
            <span key={t} className="absolute whitespace-nowrap" style={{ left: `${t * 100}%`, transform: t === 0 ? "none" : t === 1 ? "translateX(-100%)" : "translateX(-50%)" }}>{ms(total * t)}</span>
          ))}
        </div>
        <div className="space-y-0.5">
          {rows.map((r) => {
            const left = r.end ? ((r.start - t0) / total) * 100 : 0;
            const width = r.end ? Math.max(((r.end - r.start) / total) * 100, 0.8) : 0;
            const isOpen = open === r.key;
            return (
              <div key={r.key}>
                <button
                  onClick={() => setOpen(isOpen ? null : r.key)}
                  className={`block w-full rounded-md px-1.5 py-1.5 text-left hover:bg-slate-50 ${isOpen ? "bg-slate-50" : ""}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: r.depth * 14 }}>
                      {isOpen ? <ChevronDown size={12} className="shrink-0 text-slate-400" /> : <ChevronRight size={12} className="shrink-0 text-slate-400" />}
                      <KindIcon r={r} />
                      <span className="truncate font-mono text-[11.5px] font-medium text-slate-800" title={r.label}>{r.label}</span>
                      {r.status === "fallback" && <span className="shrink-0 rounded bg-amber-100 px-1 text-[9px] font-bold text-amber-800">FALLBACK</span>}
                      {r.kind === "human" && <span className="shrink-0 rounded bg-teal-100 px-1 text-[9px] font-bold text-teal-700">HUMAN</span>}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-slate-500">
                      {r.end > 0 ? ms(r.end - r.start) : r.status === "running" ? "running…" : ""}
                    </span>
                  </div>
                  {r.tokensIn !== undefined && (
                    <div className="mt-0.5 text-[11px] text-slate-500" style={{ paddingLeft: r.depth * 14 + 18 }}>
                      <span className="text-sky-600">{r.tokensIn.toLocaleString()} input tokens</span>
                      <span className="mx-1 text-slate-300">·</span>
                      <span className="text-fuchsia-600">{r.tokensOut?.toLocaleString()} output tokens</span>
                    </div>
                  )}
                  <div className="relative mt-1 h-3 rounded bg-slate-100" style={{ marginLeft: r.depth * 14 + 18 }}>
                    {ticks.slice(1, -1).map((t) => <span key={t} className="absolute inset-y-0 border-l border-dashed border-slate-200" style={{ left: `${t * 100}%` }} />)}
                    {r.end > 0 ? (
                      <span className="absolute top-0.5 h-2 rounded-sm" style={{ left: `${left}%`, width: `${width}%`, minWidth: 3, ...barStyle(r) }} />
                    ) : r.kind === "human" ? (
                      <span className="absolute inset-y-0.5 left-0 w-1/4 rounded-sm bg-teal-400" />
                    ) : r.status === "running" ? (
                      <span className="absolute inset-y-0.5 left-0 w-1/3 animate-pulse rounded bg-blue-300" />
                    ) : null}
                  </div>
                </button>
                {isOpen && <Detail r={r} />}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-500">
        {(Object.keys(KIND) as Kind[]).map((k) => (
          <span key={k} className="flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: KIND[k].bar }} />{KIND[k].label}</span>
        ))}
        <span className="flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: FALLBACK_BG }} />Fallback used</span>
        <span className="flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-sm bg-red-600" />Error</span>
      </div>
    </div>
  );
}

export function TracePanel({ runs, feedback }: { runs: Run[]; feedback: FeedbackEvent[] }) {
  const active = runs.filter((r) => r.tools.length || r.llm.length);
  if (!active.length)
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 text-center text-sm text-slate-500">
        <Activity />
        Agent trace appears here: every LLM call and tool call with timing, tokens, inputs and outputs.
      </div>
    );
  return (
    <div className="space-y-3">
      {active.map((r, i) => <RunView key={r.messageId} run={r} index={i} />)}
      {feedback.length > 0 && (
        <div className="rounded-xl border border-teal-200 bg-teal-50 p-3 text-xs text-teal-900">
          <div className="mb-1 flex items-center gap-1 font-semibold"><Zap size={12} />Human feedback events</div>
          <ul className="list-disc pl-4">{feedback.map((f, i) => <li key={i}>{f.text}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
