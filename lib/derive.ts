"use client";
import { useMemo } from "react";
import { useAuiState } from "@assistant-ui/react";
import type { Itinerary, Span } from "./types";

export type LlmStep = { step: number; startMs: number; endMs: number; tokensIn: number; tokensOut: number; finishReason?: string; toolCalls?: string[] };
export type ToolRow = {
  id: string;
  toolName: string;
  args: unknown;
  result: unknown;
  running: boolean;
  isError: boolean;
  spans: Span[];
};
export type Run = {
  messageId: string;
  llm: LlmStep[];
  tools: ToolRow[];
  model?: string;
  totalTokens?: number;
  running: boolean;
};
export type FeedbackEvent = { at: number; text: string };

function traceOf(m: any) {
  return m?.metadata?.custom?.trace ?? m?.metadata?.trace ?? m?.metadata?.unstable_data?.find?.((d: any) => d?.trace)?.trace;
}

export function derive(messages: any[]) {
  let itinerary: Itinerary | null = null;
  let attempts = 0;
  const runs: Run[] = [];
  const feedback: FeedbackEvent[] = [];

  messages.forEach((m, i) => {
    if (m.role === "user") {
      const text = (m.content ?? []).map((p: any) => (p.type === "text" ? p.text : "")).join("");
      if (text.startsWith("[feedback]")) feedback.push({ at: i, text: text.replace("[feedback]", "").trim() });
      return;
    }
    if (m.role !== "assistant") return;
    const tr = traceOf(m);
    const run: Run = {
      messageId: m.id,
      llm: tr?.llm ?? [],
      tools: [],
      model: tr?.model,
      totalTokens: tr?.totalTokens,
      running: m.status?.type === "running",
    };
    for (const p of m.content ?? []) {
      if (p.type !== "tool-call") continue;
      const result = p.result as any;
      run.tools.push({
        id: p.toolCallId,
        toolName: p.toolName,
        args: p.args,
        result,
        running: result === undefined,
        isError: !!p.isError,
        spans: result?._spans ?? [],
      });
      if (p.toolName === "build_itinerary" && result?.itinerary) {
        attempts++;
        itinerary = result.itinerary as Itinerary;
      }
    }
    runs.push(run);
  });
  return { itinerary, attempts, runs, feedback };
}

export function useDerived() {
  const messages = useAuiState((s) => s.thread.messages) as any[];
  return useMemo(() => derive(messages), [messages]);
}

export const money = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
export const clock = (m: number) => {
  const h = Math.floor(m / 60) % 24;
  const mm = Math.round(m % 60);
  const ap = h >= 12 ? "pm" : "am";
  return `${h % 12 || 12}:${String(mm).padStart(2, "0")} ${ap}`;
};
