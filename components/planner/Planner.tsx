"use client";
import { useState } from "react";
import { AssistantRuntimeProvider, useAui, useAuiState } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { Activity, CalendarDays, MessageSquare } from "lucide-react";
import { ChatThread } from "./ChatThread";
import { ItineraryView } from "./ItineraryView";
import { TracePanel } from "./TracePanel";
import { HowItWorks, LiveSteps } from "./Concept";
import { useDerived } from "@/lib/derive";
import { shouldResumeAfterHuman } from "@/lib/hitl";
import { APP_NAME, Logo, TAGLINE } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";
import type { Stop } from "@/lib/types";

type Tab = "chat" | "plan" | "trace";

function Shell() {
  const aui = useAui();
  const { itinerary, runs, feedback, attempts } = useDerived();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const [tab, setTab] = useState<Tab>("chat");
  const [side, setSide] = useState<"plan" | "trace">("plan");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [liked, setLiked] = useState<Record<string, "up" | "down">>({});

  const send = (t: string) => {
    aui.thread().append(t);
    setTab("chat");
  };
  const feedbackFn = (s: Stop, kind: "up" | "down") => {
    setLiked((p) => ({ ...p, [s.placeId]: kind }));
    send(kind === "up" ? `[feedback] I like "${s.name}" - keep it in the plan.` : `[feedback] I don't want "${s.name}". Swap it for something else that fits my preferences.`);
  };

  const view = (which: "plan" | "trace") =>
    which === "plan" ? (
      itinerary ? (
        <ItineraryView it={itinerary} extras={{ notes, setNote: (id, v) => setNotes((p) => ({ ...p, [id]: v })), liked, feedback: feedbackFn, quick: send, onOpenTrace: () => { setSide("trace"); setTab("trace"); } }} />
      ) : isRunning || runs.at(-1)?.tools.length ? (
        <LiveSteps run={runs.at(-1)?.tools.length ? { ...runs.at(-1)!, running: runs.at(-1)!.running || isRunning } : { messageId: "pending", llm: [], tools: [], running: true }} />
      ) : (
        <HowItWorks onOpenChat={() => setTab("chat")} />
      )
    ) : (
      <TracePanel runs={runs} feedback={feedback} />
    );

  const mobileTab = (id: Tab, label: string, icon: React.ReactNode) => (
    <button key={id} onClick={() => setTab(id)} className={`flex flex-1 items-center justify-center gap-1.5 py-2 text-xs font-medium ${tab === id ? "border-t-2 border-indigo-600 text-indigo-700" : "text-slate-500"}`}>
      {icon}{label}
    </button>
  );

  return (
    <div className="flex h-dvh flex-col bg-slate-50">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Logo size={38} />
          <div>
            <h1 className="text-base font-bold leading-tight tracking-tight text-slate-900">{APP_NAME}</h1>
            <p className="hidden text-[11px] text-slate-500 sm:block">{TAGLINE}</p>
            <p className="text-[11px] text-slate-500 sm:hidden">Your perfect Saturday, planned.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {attempts > 0 && <span className="hidden rounded-full bg-indigo-50 px-2.5 py-1 text-[11px] text-indigo-700 sm:inline">{attempts} plan attempt{attempts > 1 ? "s" : ""}</span>}
          <ThemeToggle />
        </div>
      </header>

      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(380px,32%)_minmax(0,1fr)]">
        <section className={`min-h-0 min-w-0 border-r border-slate-200 ${tab === "chat" ? "block" : "hidden"} lg:block`}>
          <ChatThread />
        </section>
        <section className={`min-h-0 min-w-0 flex-col ${tab !== "chat" ? "flex" : "hidden"} lg:flex`}>
          <div className="hidden gap-1 border-b border-slate-200 bg-white px-3 pt-2 lg:flex">
            {([["plan", "Itinerary", <CalendarDays key="a" size={14} />], ["trace", "Agent trace", <Activity key="b" size={14} />]] as const).map(([id, l, ic]) => (
              <button key={id} onClick={() => setSide(id)} className={`flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-xs font-medium ${side === id ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
                {ic}{l}
              </button>
            ))}
          </div>
          <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-3 sm:p-4">
            <div className="hidden lg:block">{view(side)}</div>
            <div className="lg:hidden">{tab === "plan" ? view("plan") : tab === "trace" ? view("trace") : null}</div>
          </div>
        </section>
      </div>

      <nav className="flex border-t border-slate-200 bg-white lg:hidden">
        {mobileTab("chat", "Chat", <MessageSquare size={14} />)}
        {mobileTab("plan", "Itinerary", <CalendarDays size={14} />)}
        {mobileTab("trace", "Trace", <Activity size={14} />)}
      </nav>
    </div>
  );
}

export function Planner() {
  // Resume the run once the human has answered the in-chat form (the runtime does not do this by default).
  const runtime = useChatRuntime({ sendAutomaticallyWhen: shouldResumeAfterHuman });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Shell />
    </AssistantRuntimeProvider>
  );
}
