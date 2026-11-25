import { makeTools } from "./tools";
import { curatedCityNames, interestsToCategories, haversineKm } from "./providers";
import type { Ctx } from "./trace";
import type { Itinerary } from "../types";
import { WARNING_MARK } from "../marks";
import { MAX_PEOPLE, normalizePrefs, parseClock } from "./prefs";

/**
 * Deterministic planner used when the LLM is unavailable (quota, outage, missing key).
 * Runs the SAME tools and validation as the agent, emitting the same UI stream chunks,
 * so the itinerary, map and trace render identically.
 */

type Emit = (chunk: any) => void;
type FP = {
  city?: string; budget?: number; available_time?: string | number; start_time?: string; start_location?: string;
  people?: number; mood?: string; interests?: string[]; constraints?: string[];
};

export function reasonLabel(msg: string) {
  if (/quota|429|rate.?limit|exceeded|RESOURCE_EXHAUSTED/i.test(msg)) return "the AI quota is reached";
  if (/api key|API_KEY|not configured|missing/i.test(msg)) return "the AI key is not configured";
  return "the AI model is temporarily unavailable";
}

function textOf(m: any): string {
  return (m.parts ?? []).map((p: any) => (p.type === "text" ? p.text : "")).join("");
}

export function extractPrefs(messages: any[]) {
  const prefs: FP = {};
  const feedback: string[] = [];
  const merge = (o: any) => {
    if (!o || typeof o !== "object") return;
    for (const k of ["city", "budget", "available_time", "start_time", "start_location", "people", "mood", "interests", "constraints"] as const) {
      if (o[k] !== undefined && o[k] !== null && o[k] !== "") (prefs as any)[k] = o[k];
    }
  };
  for (const m of messages) {
    if (m.role === "user") {
      const t = textOf(m);
      if (t.startsWith("[feedback]")) {
        feedback.push(t.replace("[feedback]", "").trim());
        continue;
      }
      const j = t.match(/\{[\s\S]*\}/);
      if (j) {
        try { merge(JSON.parse(j[0])); } catch { /* ignore */ }
      }
    } else if (m.role === "assistant") {
      for (const p of m.parts ?? []) {
        if (p.type === "tool-ask_user_preferences" && p.state === "output-available") merge(p.output);
      }
    }
  }
  return { prefs, feedback };
}

/** `reason` is why the model is not being used; null means no model was ever needed (input check), so no notice is shown. */
export async function runFallback(ctx: Ctx, messages: any[], emit: Emit, reason: string | null) {
  const tools = makeTools(ctx) as Record<string, any>;
  let n = 0;
  const call = async (name: string, input: any) => {
    const id = `fb_${Date.now().toString(36)}_${n++}`;
    emit({ type: "tool-input-available", toolCallId: id, toolName: name, input });
    try {
      const output = await tools[name].execute(input, { toolCallId: id, messages: [] });
      emit({ type: "tool-output-available", toolCallId: id, output });
      return output;
    } catch (e) {
      emit({ type: "tool-output-error", toolCallId: id, errorText: e instanceof Error ? e.message : "tool failed" });
      throw e;
    }
  };
  let tid = 0;
  const emitText = (text: string) => {
    const id = `fbt_${tid++}`;
    emit({ type: "text-start", id });
    emit({ type: "text-delta", id, delta: text });
    emit({ type: "text-end", id });
  };
  // The first message of a fallback run carries a warning callout (rendered by the chat UI via the marker).
  let warned = false;
  const say = (text: string) => {
    if (!warned && reason !== null) {
      warned = true;
      emitText(`${WARNING_MARK}Built-in planner used
${reasonLabel(reason)[0].toUpperCase() + reasonLabel(reason).slice(1)}, so this plan comes from the built-in planner. It uses the same real places and validation checks, with simpler reasoning.`);
    }
    emitText(text);
  };

  const { prefs, feedback } = extractPrefs(messages);
  // Same normalisation as the LLM path: rejects non-positive budgets/durations, caps absurd values.
  const norm = normalizePrefs({
    city: prefs.city, budget_inr: Number(prefs.budget), available_time: prefs.available_time, start_time: prefs.start_time,
    start_location: prefs.start_location, people: prefs.people === undefined ? undefined : Number(prefs.people), mood: prefs.mood,
    interests: prefs.interests, constraints: prefs.constraints,
  });
  if (!norm.prefs) {
    emit({ type: "tool-input-available", toolCallId: `fb_ask_${Date.now().toString(36)}`, toolName: "ask_user_preferences", input: { reason: "I need a few details to plan your Saturday.", prefill: prefs } });
    say("Please fill in the form so I can plan your day.");
    return;
  }

  const city = norm.prefs.city;

  // ---- feedback adjustments
  let budget = norm.prefs.budget;
  let hours = norm.prefs.availableHours;
  let lowWalking = false;
  let extraFood = false;
  let cheaper = false;
  const excluded = new Set<string>();
  const kept = new Set<string>();
  for (const f of feedback) {
    const q = [...f.matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase());
    if (/cheaper/i.test(f)) { budget = Math.round(budget * 0.7); cheaper = true; }
    if (/less walking/i.test(f)) lowWalking = true;
    if (/shorter/i.test(f)) hours = Math.min(hours, 3);
    if (/more food/i.test(f)) extraFood = true;
    if (/don't want|swap/i.test(f)) q.forEach((x) => excluded.add(x));
    else if (/like|keep/i.test(f)) q.forEach((x) => kept.add(x));
  }

  const interests = prefs.interests ?? [];
  // One implementation of constraint detection, shared with the agent's parse_preferences tool.
  const { vegetarian, avoidCrowds, lowWalking: lowEffort } = norm.prefs.flags;
  lowWalking = lowWalking || lowEffort;
  const people = Math.min(MAX_PEOPLE, norm.prefs.people);
  const startTime = prefs.start_time || "10:00";
  const startHour = parseClock(startTime, 10);

  try {
    await call("parse_preferences", {
      raw_text: "(built-in planner)", city: city, budget_inr: norm.prefs.budget, available_time: String(hours), start_time: startTime,
      start_location: prefs.start_location, people, mood: prefs.mood, interests, constraints: prefs.constraints,
    });
    const w = await call("get_weather", { city: city });
    if (w.error) {
      // w.message is written for the LLM; the user gets their own wording, and the form reopens to fix the city.
      const askCity = (text: string, suggestion?: { city: string; country?: string }) => {
        say(text);
        emit({
          type: "tool-input-available",
          toolCallId: `fb_ask_${Date.now().toString(36)}`,
          toolName: "ask_user_preferences",
          input: { reason: suggestion ? "Pick the suggestion or type the right city:" : "Please enter the correct city:", prefill: { ...prefs, city: "" }, ...(suggestion ? { suggestion } : {}) },
        });
      };
      if (w.error === "city_unclear" && w.suggestion) {
        const label = `${w.suggestion.city}${w.suggestion.country ? ", " + w.suggestion.country : ""}`;
        askCity(`I couldn't find a city called "${city}". Did you mean ${label}?`, w.suggestion);
      } else {
        const rich = curatedCityNames.map((c) => c[0].toUpperCase() + c.slice(1)).join(", ");
        askCity(`I couldn't find "${city}". Please check the spelling or try a nearby larger city. WhereTo has its richest data for ${rich}.`);
      }
      return;
    }
    const cityName: string = w.city ?? city; // the geocoder's proper name (for example "Bengaluru")
    const perMeal = Math.max(150, Math.round(budget / people / (hours >= 5 ? 3 : 2)));
    const [acts, food] = await Promise.all([
      call("get_activity_options", { city: city, interests, avoid_crowds: avoidCrowds }),
      call("get_food_options", { city: city, budget_per_meal_inr: perMeal, vegetarian, avoid_crowds: avoidCrowds }),
    ]);
    const center = ctx.center ?? { lat: 0, lon: 0 };
    const origin = center; // distance proxy; exact start leg is handled by build_itinerary
    const wanted = new Set(interestsToCategories(interests));
    const score = (p: any, isFood: boolean) => {
      let s = 0;
      if (!isFood && wanted.has(p.category)) s += 3;
      if (kept.has(String(p.name).toLowerCase())) s += 5;
      s += p.crowd === "low" ? 1.5 : p.crowd === "medium" ? 0.5 : avoidCrowds ? -4 : -1;
      if (p.cost === 0) s += 0.5;
      if (isFood && vegetarian) s += p.veg === "only" ? 1.5 : p.veg === "yes" ? 1 : 0;
      s -= (haversineKm(origin, p) || 0) * 0.15;
      if (p.cost_inr * people > budget * 0.35) s -= 2;
      if (cheaper) s -= p.cost_inr / 60;
      return s;
    };
    const ok = (p: any) => !excluded.has(String(p.name).toLowerCase());
    const hoursOf = (p: any): [number, number] => {
      const [o, c] = String(p.hours ?? "10:00-18:00").split("-").map((x) => { const [h, m] = x.split(":").map(Number); return h + (m || 0) / 60; });
      return [o, c <= o ? c + 24 : c];
    };
    const availMin = hours * 60;
    // Only consider places that are open for a meaningful part of the window.
    const feasible = (p: any) => {
      const [o, c] = hoursOf(p);
      return c * 60 >= startHour * 60 + Math.min(availMin, 120) && o * 60 <= startHour * 60 + availMin - 45;
    };
    const mk = (list: any[], isFood: boolean) =>
      list.filter(ok).filter(feasible).map((p: any) => ({ p, s: score(p, isFood), food: isFood })).sort((a: any, b: any) => b.s - a.s);
    const actC = mk(acts.options ?? [], false);
    const foodC = mk(food.options ?? [], true);

    if (actC.length + foodC.length < 2) {
      say("I couldn't find enough matching places that are open at that time. Try a different start time or interest, a larger nearby city, or relax a constraint such as crowd level or budget.");
      return;
    }

    let target = Math.max(2, Math.min(4, Math.round(hours * 0.7)));
    if (lowWalking) target = Math.min(target, 3);
    const perStop = Math.max(40, Math.min(90, Math.floor((availMin * 0.88 - 20 * target) / target / 5) * 5));
    const capDur = (p: any) => Math.min(p.duration_min, perStop);
    let nFood = hours >= 5 ? 2 : hours >= 2.5 ? 1 : 0;
    if (extraFood) nFood = Math.min(2, nFood + 1);
    nFood = Math.min(nFood, foodC.length, target - 1);

    const used = new Set<string>();
    const chosen: any[] = [];
    let est = 0;
    const add = (c: any) => { chosen.push(c); used.add(c.p.id); est += capDur(c.p) + 20; };
    foodC.slice(0, nFood).forEach(add);
    // greedy activities with category diversity; stop when the window is full
    const catCount: Record<string, number> = {};
    while (chosen.length < target) {
      const next = actC
        .filter((c: any) => !used.has(c.p.id))
        .map((c: any) => ({ c, s: c.s - 2.5 * (catCount[c.p.category] ?? 0) }))
        .sort((a: any, b: any) => b.s - a.s)[0]?.c;
      if (!next) break;
      catCount[next.p.category] = (catCount[next.p.category] ?? 0) + 1;
      add(next);
    }
    if (chosen.length < 2) for (const c of [...foodC, ...actC]) { if (chosen.length >= 2) break; if (!used.has(c.p.id)) add(c); }

    // A stop that is already open when you set off (allowing for the first bit of travel) must come first.
    const canFirst = (p: any) => hoursOf(p)[0] * 60 <= startHour * 60 + 40;
    const arrange = (list: any[]) => {
      const acts2 = list.filter((c) => !c.food).sort((a, b) => hoursOf(a.p)[0] - hoursOf(b.p)[0]);
      const foods = list.filter((c) => c.food);
      if (startHour >= 16) return [...acts2, ...foods];
      if (!foods.length) return acts2;
      const res = [...acts2];
      foods.forEach((f, i) => res.splice(Math.min(1 + i * 2, res.length), 0, f));
      return res;
    };
    const order = (list: any[]) => {
      const first = list.find((c) => !c.food && canFirst(c.p)) ?? list.find((c) => canFirst(c.p));
      if (!first) return arrange(list);
      return [first, ...arrange(list.filter((c) => c !== first))];
    };
    // Make sure the plan contains something that is open at the start time; swap out the weakest stop if not.
    if (!chosen.some((c) => canFirst(c.p))) {
      const opener = [...actC, ...foodC].find((c) => !used.has(c.p.id) && canFirst(c.p));
      if (opener && chosen.length) {
        const weakest = [...chosen].sort((a, b) => a.s - b.s)[0];
        chosen.splice(chosen.indexOf(weakest), 1, opener);
        used.add(opener.p.id);
      }
    }

    const interestOf = (p: any) => interests.find((i) => interestsToCategories([i]).includes(p.category));
    let durScale = 1;
    const stopOf = (c: any) => {
      const p = c.p;
      const bits = [
        interestOf(p) ? `matches your interest in ${interestOf(p)}` : c.food ? "a good meal break" : "a nice change of scene",
        `${p.crowd} crowd levels`,
        p.cost_inr ? `about ₹${p.cost_inr} per person` : "free",
      ];
      if (lowWalking) bits.push("keeps effort low");
      const trade: string[] = [];
      if (p.crowd === "high") trade.push("can be busy; go early or off-peak");
      if (c.food && vegetarian && p.veg === "unknown") trade.push("vegetarian options not confirmed; check the menu");
      if (p.source === "osm") trade.push("cost and timings are estimates");
      if (durScale < 1) trade.push("visit shortened to fit your time window");
      return {
        place_id: p.id,
        duration_min: Math.max(30, Math.round((capDur(p) * durScale) / 5) * 5),
        why: bits[0][0].toUpperCase() + bits[0].slice(1) + "; " + bits.slice(1).join(", ") + ".",
        trade_off: trade.join("; ") || undefined,
      };
    };

    const daypart = startHour < 12 ? "morning" : startHour < 16 ? "afternoon" : "evening";
    let current = order(chosen);
    let last: any = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await call("build_itinerary", {
        city: city, title: `A relaxed ${daypart} in ${cityName}`, budget_inr: budget, available_hours: hours,
        start_time: startTime, start_location: prefs.start_location, people, vegetarian, avoid_crowds: avoidCrowds, low_walking: lowWalking,
        stops: current.map(stopOf),
      });
      last = res.itinerary as Itinerary;
      if (last.validation.ok) break;

      // ---- repair ladder: (1) shorten visits, (2) drop/replace offending stops, (3) drop the least valuable stop
      const issues = last.validation.issues.join(" | ").toLowerCase();
      const overTime = /plan runs|too packed|closes at/.test(issues);
      const overBudget = /exceeds budget|budget/.test(issues);
      if (overTime && durScale > 0.55 && !overBudget) {
        durScale = Math.round(durScale * 80) / 100;
        continue;
      }
      const bad = current.filter((c) => issues.includes(String(c.p.name).toLowerCase()));
      let next = current.filter((c) => !bad.includes(c));
      if (!bad.length || overBudget || /plan runs|too packed/.test(issues)) {
        const dropPool = next.filter((c) => !c.food || next.filter((x) => x.food).length > 1);
        const victim = overBudget
          ? [...dropPool].sort((a, b) => b.p.cost_inr - a.p.cost_inr)[0]
          : [...dropPool].reverse()[0];
        if (victim) next = next.filter((c) => c !== victim);
      } else {
        const refill = bad.some((b) => b.food) ? [...foodC, ...actC] : [...actC, ...foodC];
        for (const c of refill) {
          if (next.length >= current.length) break;
          if (!used.has(c.p.id)) { next.push(c); used.add(c.p.id); }
        }
      }
      if (next.length < 2) break;
      current = order(next);
    }

    const it = last as Itinerary;
    const h = Math.floor(it.totals.minutes / 60), m = Math.round(it.totals.minutes % 60);
    const lines = [
      `**${it.title}**: ${it.stops.length} stops, about ₹${it.totals.cost.toLocaleString("en-IN")} for ${people === 1 ? "one person" : people + " people"}, roughly ${h}h ${m}m.`,
    ];
    if (it.validation.ok) {
      const warn = it.validation.warnings.slice(0, 3);
      if (warn.length) lines.push("", "**Worth knowing:**", ...warn.map((x) => `- ${x}`));
    } else {
      lines.push("", "I couldn't fully satisfy every check, so treat this as a best effort:", ...it.validation.issues.slice(0, 3).map((x) => `- ${x}`));
    }
    lines.push("", "Tell me to swap a stop, make it cheaper, or change the pace, and I'll adjust.");
    say(lines.join("\n"));
  } catch (e) {
    say(`Sorry, I couldn't finish planning (${e instanceof Error ? e.message : "unexpected error"}). Please try again in a moment.`);
  }
}
