import { asSchema, zodSchema } from "ai";
import type { z } from "zod";

const SCHEMA = Symbol.for("vercel.ai.schema");

/**
 * A tool input schema whose JSON Schema is rebuilt every time the SDK reads it, so a property can be restricted to
 * values that only become known mid-run. The SDK reads it again for each model step, which means that after the
 * search tools have run, the model is given the exact set of place ids it is allowed to use (an enum) and cannot emit
 * any other. Validation of the arguments is unchanged (the zod schema), and the tool still rejects unknown ids.
 */
export function withLiveEnum<T extends z.ZodType>(schema: T, locate: (json: any) => any, values: () => string[]) {
  const base = zodSchema(schema);
  return {
    [SCHEMA]: true,
    _type: undefined as unknown as z.infer<T>,
    get jsonSchema() {
      const json: any = structuredClone(base.jsonSchema);
      const ids = values();
      const target = ids.length ? locate(json) : undefined;
      if (target) target.enum = ids;
      return json;
    },
    validate: base.validate,
  };
}

/** Removes `null` values (recursively), so "no value" is always `undefined` by the time a tool or validator sees it. */
export function dropNulls<T>(v: T): T {
  if (Array.isArray(v)) return v.map(dropNulls) as unknown as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as object).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNulls(x)])) as T;
  }
  return v;
}

function allowNull(prop: any): any {
  if (!prop || typeof prop !== "object") return prop;
  if (prop.anyOf) return { ...prop, anyOf: [...prop.anyOf, { type: "null" }] };
  if (typeof prop.type === "string") return { ...prop, type: [prop.type, "null"], ...(prop.enum ? { enum: [...prop.enum, null] } : {}) };
  if (Array.isArray(prop.type)) return prop.type.includes("null") ? prop : { ...prop, type: [...prop.type, "null"] };
  return prop;
}

function lenient(json: any): any {
  if (!json || typeof json !== "object") return json;
  const out: any = { ...json };
  if (json.properties) {
    const required = new Set<string>(json.required ?? []);
    out.properties = Object.fromEntries(
      Object.entries(json.properties).map(([k, v]: [string, any]) => {
        const inner = lenient(v);
        return [k, required.has(k) ? inner : allowNull(inner)];
      }),
    );
  }
  if (json.items) out.items = lenient(json.items);
  return out;
}

/**
 * Some models (gpt-oss on Groq among them) send `null` for an optional field they have nothing to say about. Providers
 * that validate tool calls server-side reject that against a plain optional schema and fail the whole request. This
 * wraps a tool's input schema so optional fields also accept `null` (in the schema sent to the provider, and when the
 * SDK validates the call); the nulls are dropped before the arguments are validated and executed.
 */
export function nullTolerant(schema: any) {
  const base = asSchema(schema) as any;
  return {
    [SCHEMA]: true,
    _type: undefined as unknown,
    get jsonSchema() {
      return lenient(base.jsonSchema);
    },
    validate: (value: unknown) => base.validate(coerceArgs(dropNulls(value), base.jsonSchema)),
  };
}

const NONE_WORDS = /^(none|null|n\/a|undefined)?$/i;

/**
 * Smaller models often stringify arguments: "2000" for a number, "[\\"food\\"]" for an array, "None" for "nothing".
 * The meaning is unambiguous, so it is repaired against the declared types before validation instead of failing the
 * whole step. Anything that cannot be repaired is left as it is and fails validation as before.
 */
export function coerceArgs(value: unknown, json: any): unknown {
  if (!json || typeof json !== "object") return value;
  const types: string[] = ([] as string[]).concat(json.type ?? []);
  if (typeof value === "string") {
    const t = value.trim();
    if (types.includes("number") || types.includes("integer")) {
      const n = Number(t.replace(/[,₹\s]/g, ""));
      if (t !== "" && Number.isFinite(n)) return n;
    }
    if (types.includes("boolean")) {
      if (/^(true|yes)$/i.test(t)) return true;
      if (/^(false|no)$/i.test(t)) return false;
    }
    if (types.includes("array") && t.startsWith("[")) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) return coerceArgs(parsed, json);
      } catch { /* leave as is */ }
    }
    if (types.includes("object") && t.startsWith("{")) {
      try {
        const parsed = JSON.parse(t);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return coerceArgs(parsed, json);
      } catch { /* leave as is */ }
    }
    return value;
  }
  if (Array.isArray(value)) return json.items ? value.map((v) => coerceArgs(v, json.items)) : value;
  if (value && typeof value === "object" && json.properties) {
    const required = new Set<string>(json.required ?? []);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const sub = json.properties[k];
      // "None" for an optional field means the model has nothing to say about it
      if (typeof v === "string" && !required.has(k) && NONE_WORDS.test(v.trim()) && (v.trim() !== "" || (sub && sub.type !== "string"))) continue;
      out[k] = sub ? coerceArgs(v, sub) : v;
    }
    return out;
  }
  return value;
}
