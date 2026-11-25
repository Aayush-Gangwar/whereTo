"use client";
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

const C = {
  key: "text-indigo-700",
  str: "text-emerald-700",
  num: "text-amber-600",
  bool: "text-pink-600",
  nul: "text-slate-400",
  punct: "text-slate-400",
};

function Leaf({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <span className={C.nul}>{String(v)}</span>;
  if (typeof v === "number") return <span className={C.num}>{v}</span>;
  if (typeof v === "boolean") return <span className={C.bool}>{String(v)}</span>;
  const s = String(v);
  const short = s.length > 160 ? s.slice(0, 160) + "…" : s;
  return <span className={C.str} title={s.length > 160 ? s : undefined}>&quot;{short}&quot;</span>;
}

function Node({ k, v, depth, last }: { k?: string; v: unknown; depth: number; last: boolean }) {
  const isObj = v !== null && typeof v === "object";
  const entries = isObj ? (Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as object)) : [];
  const [open, setOpen] = useState(depth < 2);
  const comma = last ? "" : ",";
  const label = k !== undefined && (
    <>
      <span className={C.key}>&quot;{k}&quot;</span>
      <span className={C.punct}>: </span>
    </>
  );
  if (!isObj)
    return (
      <div className="pl-4">
        {label}
        <Leaf v={v} />
        <span className={C.punct}>{comma}</span>
      </div>
    );
  const arr = Array.isArray(v);
  const [o, c] = arr ? ["[", "]"] : ["{", "}"];
  if (!entries.length)
    return (
      <div className="pl-4">
        {label}
        <span className={C.punct}>{o}{c}{comma}</span>
      </div>
    );
  return (
    <div className="pl-4">
      <button onClick={() => setOpen(!open)} className="-ml-4 inline-flex items-center text-left hover:bg-slate-100">
        {open ? <ChevronDown size={12} className="mr-0.5 text-slate-400" /> : <ChevronRight size={12} className="mr-0.5 text-slate-400" />}
        {label}
        <span className={C.punct}>{o}</span>
        {!open && <span className="mx-1 text-slate-400">{entries.length} {arr ? "items" : "keys"}</span>}
        {!open && <span className={C.punct}>{c}{comma}</span>}
      </button>
      {open && (
        <>
          {entries.map(([ek, ev], i) => (
            <Node key={ek} k={arr ? undefined : ek} v={ev} depth={depth + 1} last={i === entries.length - 1} />
          ))}
          <div className={C.punct}>{c}{comma}</div>
        </>
      )}
    </div>
  );
}

export function JsonView({ data }: { data: unknown }) {
  if (data === undefined) return <span className="text-xs italic text-slate-400">— none —</span>;
  return (
    <div className="max-h-72 overflow-auto font-mono text-[11.5px] leading-[1.55]">
      <div className="-ml-4">
        <Node v={data} depth={0} last />
      </div>
    </div>
  );
}
