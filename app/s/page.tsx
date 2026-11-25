"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ItineraryView } from "@/components/planner/ItineraryView";
import { APP_NAME, Logo } from "@/components/planner/Logo";
import { ThemeToggle } from "@/components/planner/ThemeToggle";
import type { Itinerary } from "@/lib/types";

export default function SharedItinerary() {
  const [it, setIt] = useState<Itinerary | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    try {
      const h = location.hash.slice(1);
      setIt(JSON.parse(decodeURIComponent(escape(atob(h)))));
    } catch {
      setErr(true);
    }
  }, []);
  return (
    <main className="mx-auto max-w-3xl p-4">
      <div className="mb-4 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <Logo size={34} />
          <span className="font-bold tracking-tight text-slate-900">{APP_NAME}</span>
        </Link>
        <div className="flex items-center gap-3">
          <Link href="/" className="text-xs font-medium text-indigo-600 hover:underline">Plan your own Saturday →</Link>
          <ThemeToggle />
        </div>
      </div>
      {err && <p className="text-sm text-rose-600">This share link is invalid or incomplete.</p>}
      {it && <ItineraryView it={it} extras={{ notes: it.notes ?? {}, setNote: () => {}, liked: {}, readOnly: true }} />}
    </main>
  );
}
