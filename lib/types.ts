export type Category = "food" | "cafe" | "park" | "museum" | "music" | "market" | "temple" | "art" | "mall" | "cinema" | "viewpoint" | "activity";

export type Place = {
  id: string;
  name: string;
  category: Category;
  lat: number;
  lon: number;
  /** estimated INR per person (entry or typical meal) */
  cost: number;
  /** typical visit length in minutes */
  durationMin: number;
  crowd: "low" | "medium" | "high";
  outdoor: boolean;
  /** opening window, hours in 24h clock */
  opens: number;
  closes: number;
  veg: "yes" | "only" | "unknown" | "no";
  tags: string[];
  blurb: string;
  source: "osm" | "curated";
  wiki?: string;
  area?: string;
};

export type Prefs = {
  city: string;
  budget: number;
  availableHours: number;
  startHour: number;
  people: number;
  startLocation?: string;
  mood: string;
  interests: string[];
  constraints: string[];
  flags: { vegetarian: boolean; vegan: boolean; avoidCrowds: boolean; lowWalking: boolean; noAlcohol: boolean };
};

export type Leg = { mode: "walk" | "auto/cab"; km: number; minutes: number; cost: number; mapsUrl: string };

export type Stop = {
  placeId: string;
  name: string;
  category: Category;
  lat: number;
  lon: number;
  startMin: number; // minutes from midnight
  endMin: number;
  cost: number;
  why: string;
  tradeOff?: string;
  crowd: Place["crowd"];
  veg: Place["veg"];
  blurb: string;
  source: Place["source"];
  wiki?: string;
  legFromPrev?: Leg;
};

export type Itinerary = {
  city: string;
  center: { lat: number; lon: number };
  title: string;
  stops: Stop[];
  people: number;
  /** The place the plan is for, as resolved by the geocoder (so a wrong guess is visible). */
  place?: { name: string; country: string; typed?: string };
  flags?: { vegetarian: boolean; avoidCrowds: boolean; lowWalking: boolean };
  start?: { name: string; lat: number; lon: number };
  totals: { cost: number; budget: number; minutes: number; availableMinutes: number; travelMinutes: number };
  validation: { ok: boolean; issues: string[]; warnings: string[] };
  weather?: { summary: string; tempMax: number; rainChance: number };
  notes?: Record<string, string>;
};

export type Span = {
  id: string;
  parentId?: string;
  name: string;
  kind: "tool" | "llm" | "internal" | "human";
  startMs: number; // epoch ms (server clock)
  endMs: number;
  input?: unknown;
  output?: unknown;
  status: "ok" | "error" | "fallback";
  note?: string;
  tokensIn?: number;
  tokensOut?: number;
};
