import type { Stop } from "../types";

/**
 * Faithfulness check: the reasons and trade-offs the model writes for each stop must not contradict the data the
 * tools returned. Deliberately conservative (high precision), so it only flags clear contradictions. A contradiction
 * is a validation issue, which sends the agent back to rewrite the reason; a claim the data cannot confirm is a warning.
 */

const QUIET = /\b(quiet|calm|peaceful|serene|tranquil|uncrowded|not crowded|less crowded|low[- ]crowds?|crowd[- ]free)\b/i;
const FREE = /\b(free (entry|admission|to enter|of charge)|entry is free|admission is free|is free to|costs? nothing|no (entry )?(fee|charge|cost)|complimentary)\b/i;
const PURE_VEG = /\b(pure[- ]veg(etarian)?|fully vegetarian|100% vegetarian|all[- ]vegetarian|vegan[- ]friendly|vegetarian[- ]friendly|serves? (only )?vegetarian)\b/i;
const ANY_VEG = /\b(vegetarian|vegan)\b/i;
const AMOUNT = /(?:₹|\brs\.?|\binr)\s?(\d[\d,]*)/gi;

export type ClaimCheck = { issues: string[]; warnings: string[] };

export function checkReasons(stops: Stop[], people: number): ClaimCheck {
  const issues: string[] = [];
  const warnings: string[] = [];
  for (const s of stops) {
    const why = s.why ?? "";
    const both = `${why} ${s.tradeOff ?? ""}`;
    const isFood = s.category === "food" || s.category === "cafe";

    // positive claims only in "why" ("go early to avoid crowds" is a legitimate trade-off for a busy place)
    if (QUIET.test(why) && s.crowd === "high") {
      issues.push(`The reason given for ${s.name} calls it quiet or uncrowded, but the data says it is usually crowded. Rewrite the reason to match the data.`);
    }
    if (FREE.test(both) && s.cost > 0) {
      issues.push(`The reason given for ${s.name} says it is free, but the data says it costs INR ${s.cost} per person. Correct the reason.`);
    }
    if (isFood && ANY_VEG.test(both) && s.veg === "no") {
      issues.push(`The reason given for ${s.name} claims vegetarian food, but the data says it is not vegetarian-friendly. Correct the reason.`);
    } else if (isFood && PURE_VEG.test(both) && s.veg === "unknown") {
      warnings.push(`${s.name}: the description claims a fully vegetarian menu, which the data cannot confirm - verify before going.`);
    }

    const allowed = new Set<number>([0, s.cost, s.cost * people]);
    if (s.legFromPrev) allowed.add(s.legFromPrev.cost);
    for (const m of both.matchAll(AMOUNT)) {
      const n = Number(m[1].replace(/,/g, ""));
      if (!allowed.has(n)) {
        issues.push(`The reason given for ${s.name} mentions INR ${n}, which does not match the data (INR ${s.cost} per person). Remove the amount or correct it.`);
        break;
      }
    }
  }
  return { issues, warnings };
}
