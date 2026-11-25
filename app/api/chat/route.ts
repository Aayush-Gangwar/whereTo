import { convertToModelMessages, createUIMessageStreamResponse, isStepCount, streamText, toUIMessageStream, type UIMessage } from "ai";
import { makeTools, seedFromHistory } from "@/lib/agent/tools";
import type { Ctx } from "@/lib/agent/trace";
import { extractPrefs, runFallback } from "@/lib/agent/fallback";
import { resolveCityCached } from "@/lib/agent/city";
import { classifyError, markFailed, providerOrder, usableChoices } from "@/lib/agent/llm";
import { formToRaw, normalizePrefs } from "@/lib/agent/prefs";
import { WARNING_MARK } from "@/lib/marks";
import { mergePrefill } from "@/lib/agent/prefill";

export const maxDuration = 60;

const PRETTY: Record<string, string> = { google: "Gemini", groq: "Groq", openrouter: "OpenRouter", cerebras: "Cerebras", mistral: "Mistral", zai: "Z.ai" };

/** Thinking is provider-specific and not needed to continue; the tool calls and results are what the next provider needs. */
function textOfLatestUser(messages: UIMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  return ((last?.parts ?? []) as any[]).map((p) => (p?.type === "text" ? p.text : "")).join(" ");
}

function withoutReasoning(msgs: any[]): any[] {
  return msgs.map((m) => (Array.isArray(m?.content) ? { ...m, content: m.content.filter((p: any) => p?.type !== "reasoning") } : m));
}
const MAX_MESSAGES = 60;
const MAX_STEPS = 8;
// The function is cut off at maxDuration (60s) and the user would see a silent empty run. The models get this long
// (measured from the start of the request); after that the built-in planner answers while there is still time.
const DEADLINE_MS = Number(process.env.RUN_DEADLINE_MS) || 40_000;
const MIN_ATTEMPT_MS = Number(process.env.MIN_ATTEMPT_MS) || 8_000;

const SYSTEM = `You are "WhereTo", a practical planner that builds a realistic Saturday plan. Use tools; never invent places.

FLOW
1. A form submission arrives as JSON-like details: in your FIRST step call parse_preferences, get_weather, get_activity_options and get_food_options TOGETHER (city, interests, vegetarian and avoid_crowds come from the details; budget_per_meal_inr is PER PERSON = budget / people / meals). For free text, call parse_preferences first (evening=17:30, morning=09:00, afternoon=15:00, night=19:30).
2. If city, budget or time is missing, call ask_user_preferences ONCE and wait. If get_weather returns city_not_found or city_unclear, do NOT plan: follow its instruction and wait.
3. Choose 3-5 stops from the returned options ONLY, by their ids. Consider opening hours, distance, meal timing, mood (tired = fewer, calmer, closer), budget and time of day (mornings: parks, museums, breakfast; evenings: food streets, music, sunset views).
4. build_itinerary with a title and the stops (the user's budget, time, people and constraints are applied for you). If it reports issues, fix every one and call again (max 3). If it still cannot fit, build the best cheaper plan and say plainly what was cut.
5. When valid, reply in at most ~100 words: the plan's idea, 2-3 honest caveats taken from its warnings, and an invitation to refine. Do not list the stops again; the UI shows them.

FAITHFULNESS: in each stop's "why" and "trade_off" use ONLY facts from the options table (category, price, crowd, diet, hours, distance, note). Do not invent events, menus, ratings or opening times. Do not write prices or amounts in rupees. Do not call a place quiet if its crowd is high, free if it has a price, or vegetarian if its diet is not confirmed. In your reply do not state costs or durations; the UI shows the verified totals.

FEEDBACK: messages starting "[feedback]" are structured reactions (like, dislike, swap, cheaper, shorter, less walking). Re-plan with build_itinerary using the options already returned; search again only if nothing suitable remains. Keep liked stops. If the user states a new budget or time in chat (for example "600 rupees"), pass it as budget_inr or available_hours to build_itinerary, and search food again with the new per-meal budget if you need food stops. Stop revising after 3 attempts: present the best valid draft and say what could not be met.

ASKING: when you need something from the user, ask only through ask_user_preferences, with the question in its "reason" (one sentence), and do not also write it as chat text. The user may instead answer by typing in the chat: then use what they wrote (a new budget or time they state replaces the old one).

STYLE: friendly and concise. Defaults: solo, start 10:00, no start location.`;

// naive per-instance rate limit (best-effort protection for the demo key)
const hits = new Map<string, number[]>();
function limited(ip: string) {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 12;
}

const textOf = (m: UIMessage | undefined) => (m?.parts ?? []).map((p: any) => (p.type === "text" ? p.text : "")).join("");

/** The structured details of the newest user input (a fresh form, or an answered in-chat form), or null. */
function structuredInput(messages: UIMessage[]): Record<string, unknown> | null {
  const last = messages.at(-1);
  const freshForm = last?.role === "user" && textOf(last).startsWith("Plan my perfect Saturday");
  const lastPart: any = last?.role === "assistant" ? last.parts.at(-1) : undefined;
  const answeredForm = lastPart?.type === "tool-ask_user_preferences" && lastPart?.state === "output-available";
  if (!freshForm && !answeredForm) return null;
  return extractPrefs(messages).prefs as Record<string, unknown>;
}

/** "unknown" / "suggest" when the newest structured input names a city that cannot be planned for. Null: carry on. */
async function checkCity(ctx: Ctx, form: Record<string, unknown> | null): Promise<"unknown" | "suggest" | null> {
  const city = form?.city;
  if (!city || !String(city).trim()) return null; // a missing city is handled by the normal flow (form)
  const r = await resolveCityCached(ctx, String(city));
  return r.status === "ok" ? null : r.status;
}

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0] ?? "local";
  if (limited(ip)) return new Response("Too many requests - please wait a minute and try again.", { status: 429 });

  let body: { messages?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid request body.", { status: 400 });
  }
  const messages = body?.messages as UIMessage[] | undefined;
  if (!Array.isArray(messages) || messages.length === 0) return new Response("Expected a non-empty messages array.", { status: 400 });
  if (messages.length > MAX_MESSAGES) return new Response("This conversation is too long. Please start a new plan.", { status: 413 });
  const ctx: Ctx = { t0: Date.now(), spans: [], places: new Map() };
  seedFromHistory(ctx, messages);
  ctx.latestUserText = textOfLatestUser(messages);

  // The user's own form values are authoritative: the model may fill gaps but never override them (see parse_preferences).
  const form = structuredInput(messages);
  if (form) {
    ctx.formPrefs = form;
    ctx.prefs = normalizePrefs(formToRaw(form)).prefs ?? ctx.prefs; // known from the first step, before any tool has run
  }

  // Cheap input check before any model call: an unknown or doubtful city never reaches the model (free-text requests
  // still need the model to find the city; the get_weather tool performs the same check there).
  const cityProblem = await checkCity(ctx, form);

  const prevAssistant = [...messages].reverse().find((m) => m.role === "assistant") as any;
  const llm: any[] = [...(prevAssistant?.metadata?.trace?.llm ?? [])];
  const attempts: { provider: string; status: "failed" | "ok"; kind?: string; error?: string }[] = [];
  const meta = (model: string, extra: object = {}) => ({
    type: "message-metadata",
    messageMetadata: { trace: { model, llm: [...llm], providers: [...attempts], totalMs: Date.now() - ctx.t0, ...extra } },
  });

  const choices = cityProblem ? [] : usableChoices();
  const tools = makeTools(ctx);
  // Tool results reach the model in a compact form (toModelOutput), also for earlier turns. Unanswered tool calls
  // (for example a form the user ignored) are dropped instead of making the provider reject the conversation.
  const modelMessages = choices.length ? await convertToModelMessages(messages, { tools: tools as any, ignoreIncompleteToolCalls: true }) : [];

  const stream = new ReadableStream<any>({
    async start(controller) {
      let started = false;
      let served = false;
      let failure: string | null = cityProblem ? "input check" : null;

      // Steps a provider completed before it failed (assistant tool calls and their results). The next provider is given
      // them, so it carries on from that point instead of repeating the same tool calls.
      const carried: any[] = [];

      /** Runs one provider over the conversation. Resolves to why it failed, or null when it served the request. */
      const attempt = async (choice: (typeof choices)[number], history: any[], lastChoice: boolean): Promise<{ failed: string | null; openStep: boolean; stepsDone: number; validPlan: boolean }> => {
        let stepStart = 0;
        let openStep = false;
        let failed: string | null = null;
        let validPlan = false; // a validated itinerary was already produced during this attempt
        const steps: any[] = []; // this provider's steps, to tell a finished run from one that just stopped
        const result = streamText({
          model: choice.model,
          system: SYSTEM,
          messages: history,
          tools,
          stopWhen: isStepCount(MAX_STEPS),
          maxOutputTokens: 1500,
          // The last allowed step must be the written answer. Without this, a model that keeps revising can use every step on
          // tool calls and the run just ends, with no summary for the user.
          prepareStep: ({ stepNumber }: { stepNumber: number }) => (stepNumber >= MAX_STEPS - 1 ? { toolChoice: "none" as const } : undefined),
          abortSignal: AbortSignal.timeout(Math.max(1, DEADLINE_MS - (Date.now() - ctx.t0))),
          maxRetries: lastChoice ? 1 : 0, // a spent quota never succeeds on retry; move on to the next provider quickly
          temperature: 0.4,
          providerOptions: choice.providerOptions,
          onStepStart: () => {
            stepStart = Date.now();
          },
          onStepEnd: (e: any) => {
            steps.push(e);
            if ((e.toolResults ?? []).some((r: any) => r.toolName === "build_itinerary" && (r.output ?? r.result)?.itinerary?.validation?.ok)) validPlan = true;
            // Only a step that did something is worth handing on (an empty one is the failure itself).
            if ((e.toolCalls ?? []).length || String(e.text ?? "").trim()) carried.push(...withoutReasoning(e.response?.messages ?? []));
            llm.push({
              step: llm.length + 1,
              provider: choice.label,
              startMs: stepStart,
              endMs: Date.now(),
              tokensIn: e.usage?.inputTokens ?? 0,
              tokensOut: e.usage?.outputTokens ?? 0,
              finishReason: e.finishReason,
              toolCalls: (e.toolCalls ?? []).map((t: any) => t.toolName),
            });
          },
        } as any);
        const ui = toUIMessageStream({
          stream: result.stream,
          originalMessages: messages,
          messageMetadata: ({ part }: any) => {
            if (part.type === "finish" || part.type === "finish-step") {
              return { trace: { model: choice.label, llm: [...llm], providers: [...attempts, { provider: choice.label, status: "ok" }], totalMs: Date.now() - ctx.t0, totalTokens: part.totalUsage?.totalTokens } };
            }
          },
          onError: (e: unknown) => (e instanceof Error ? e.message : "agent error"),
        } as any) as ReadableStream<any>;

        const reader = ui.getReader();
        try {
          while (true) {
            const { done, value: raw } = await reader.read();
            if (done) break;
            let value = raw;
            if (value?.type === "tool-input-available" && value.toolName === "ask_user_preferences") {
              // The form is pre-filled by the server from what it knows, whatever the model passed (or forgot to).
              value = { ...value, input: { ...(value.input ?? {}), prefill: mergePrefill(value.input?.prefill, ctx, messages) } };
            }
            if (value?.type === "abort") {
              failed = "timeout: the model took too long to answer"; // our own deadline (or the client leaving) ended the run
              break;
            }
            if (value?.type === "error") {
              failed = String(value.errorText ?? "model error");
              break;
            }
            if (value?.type === "start") {
              if (started) continue; // one start per response, however many providers were tried
              started = true;
            }
            if (value?.type === "start-step") openStep = true;
            if (value?.type === "finish-step") openStep = false;
            controller.enqueue(value);
          }
        } catch (e) {
          failed = e instanceof Error ? e.message : "model error";
        }

        // A run can end "successfully" with nothing to show: reasoning models sometimes spend the whole output cap thinking
        // (finish reason `length`, no text, no tool call). That is a failed attempt, not an answer: move on.
        if (!failed) {
          const last = steps.at(-1);
          const nothing = !!last && !String(last.text ?? "").trim() && !(last.toolCalls ?? []).length;
          const hasPlan = steps.some((s) => (s.toolCalls ?? []).some((t: any) => t.toolName === "build_itinerary" || t.toolName === "ask_user_preferences"));
          if (nothing && !hasPlan) failed = last.finishReason === "length" ? "the model ran out of its output limit before answering (finish reason: length)" : "the model returned an empty response";
        }
        if (failed) reader.cancel().catch(() => {});
        return { failed, openStep, stepsDone: steps.length, validPlan };
      };

      for (const [i, choice] of choices.entries()) {
        if (DEADLINE_MS - (Date.now() - ctx.t0) < MIN_ATTEMPT_MS) {
          failure = "the AI models took too long to answer (timeout)";
          break;
        }
        const lastChoice = i === choices.length - 1;
        const resumed = carried.length > 0;
        let outcome = await attempt(choice, [...modelMessages, ...carried], lastChoice);
        // The carried steps are another provider's output. If this one rejects the request outright (a format it does not
        // accept), try it once more from a clean start rather than writing it off.
        if (outcome.failed && resumed && outcome.stepsDone === 0 && classifyError(outcome.failed) === "other") {
          if (outcome.openStep) controller.enqueue({ type: "finish-step" });
          console.warn(`[agent] ${choice.label} rejected the carried-over steps, retrying from a clean start:`, outcome.failed.slice(0, 160));
          carried.length = 0;
          outcome = await attempt(choice, modelMessages, lastChoice);
        }
        const { failed, openStep } = outcome;

        // The deadline hit after a validated plan was already on screen (only the written summary was missing): keep that
        // plan and say so, rather than running the built-in planner and showing a second one.
        if (failed && /^timeout/.test(failed) && outcome.validPlan) {
          if (openStep) controller.enqueue({ type: "finish-step" });
          if (!started) { controller.enqueue({ type: "start" }); started = true; }
          attempts.push({ provider: choice.label, status: "failed", kind: "transient", error: failed.slice(0, 160) });
          controller.enqueue({ type: "start-step" });
          controller.enqueue({ type: "text-start", id: "deadline" });
          controller.enqueue({ type: "text-delta", id: "deadline", delta: `${WARNING_MARK}Time limit reached
The plan above is complete and validated, but the AI ran out of time before writing its summary.` });
          controller.enqueue({ type: "text-end", id: "deadline" });
          controller.enqueue({ type: "finish-step" });
          controller.enqueue(meta(choice.label, { deadline: true }));
          controller.enqueue({ type: "finish" });
          served = true;
          break;
        }

        if (!failed) {
          served = true;
          break;
        }
        const kind = classifyError(failed);
        markFailed(choice.id, kind);
        attempts.push({ provider: choice.label, status: "failed", kind, error: failed.slice(0, 160) });
        console.warn(`[agent] ${choice.label} failed (${kind}):`, failed.slice(0, 200));
        failure = failed;
        if (openStep) controller.enqueue({ type: "finish-step" }); // close the dangling step before the next provider starts

        const next = choices[i + 1];
        if (next) {
          // A small notice in the chat (the existing callout), so the switch is not silent.
          if (!started) { controller.enqueue({ type: "start" }); started = true; }
          const id = `switch_${i}`;
          const why = kind === "quota" ? "hit its quota" : kind === "auth" ? "has a key or billing problem" : kind === "transient" ? "is unavailable" : "gave no usable answer";
          controller.enqueue({ type: "start-step" });
          controller.enqueue({ type: "text-start", id });
          controller.enqueue({ type: "text-delta", id, delta: `${WARNING_MARK}${PRETTY[choice.id]} ${why}. Continuing with ${PRETTY[next.id]}${carried.length ? ", picking up from the steps already done" : ""}.` });
          controller.enqueue({ type: "text-end", id });
          controller.enqueue({ type: "finish-step" });
        }
      }

      if (!served) {
        if (!failure) failure = providerOrder().length ? "all AI providers are temporarily unavailable" : "API key not configured";
        if (!started) controller.enqueue({ type: "start" });
        controller.enqueue({ type: "start-step" });
        if (cityProblem) {
          // No model was needed or used: the built-in flow just reports the city problem and reopens the form.
          await runFallback(ctx, messages, (c) => controller.enqueue(c), null);
          controller.enqueue(meta("input check (no AI call)", { fallback: false, cityCheck: cityProblem }));
        } else {
          await runFallback(ctx, messages, (c) => controller.enqueue(c), failure);
          controller.enqueue(meta("built-in planner (AI unavailable)", { fallback: true, reason: failure.slice(0, 160) }));
        }
        controller.enqueue({ type: "finish-step" });
        controller.enqueue({ type: "finish" });
      }
      controller.close();
    },
  });

  return createUIMessageStreamResponse({ stream });
}
