import type { Place } from "../types";

// Hand-curated fallback set (approximate coordinates / prices). Used when live OSM data fails or for Bangalore enrichment.
type P = Omit<Place, "source" | "id"> & { key: string };
const mk = (p: P): Place => {
  const { key, ...rest } = p;
  return { ...rest, id: `cur-${key}`, source: "curated" };
};

export const CURATED: Record<string, { center: { lat: number; lon: number }; places: Place[] }> = {
  bangalore: {
    center: { lat: 12.9716, lon: 77.5946 },
    places: [
      mk({ key: "cubbon", name: "Cubbon Park", category: "park", lat: 12.9763, lon: 77.5929, cost: 0, durationMin: 75, crowd: "low", outdoor: true, opens: 6, closes: 18, veg: "unknown", tags: ["walks", "nature", "quiet", "free"], blurb: "Shaded 300-acre green lung with bamboo groves and old trees; calm on weekday-like mornings.", area: "Central", wiki: "Cubbon Park" }),
      mk({ key: "lalbagh", name: "Lalbagh Botanical Garden", category: "park", lat: 12.9507, lon: 77.5848, cost: 30, durationMin: 90, crowd: "medium", outdoor: true, opens: 6, closes: 19, veg: "unknown", tags: ["walks", "nature", "photography"], blurb: "Historic garden with a glasshouse, lake and rock formations. Go early to beat the Saturday crowd.", area: "South", wiki: "Lalbagh" }),
      mk({ key: "sankey", name: "Sankey Tank", category: "park", lat: 13.0074, lon: 77.5731, cost: 0, durationMin: 60, crowd: "low", outdoor: true, opens: 5, closes: 19, veg: "unknown", tags: ["walks", "nature", "quiet", "lake", "free"], blurb: "Lakeside walking track in Malleshwaram, mellow in the late afternoon.", area: "Malleshwaram", wiki: "Sankey Tank" }),
      mk({ key: "map", name: "Museum of Art & Photography (MAP)", category: "museum", lat: 12.9718, lon: 77.5964, cost: 500, durationMin: 90, crowd: "low", outdoor: false, opens: 10, closes: 18, veg: "unknown", tags: ["art", "indoor", "quiet", "photography", "culture"], blurb: "Modern museum, air-conditioned and spacious; a gentle way to do 'something' while tired.", area: "Kasturba Road", wiki: "Museum of Art & Photography, Bangalore" }),
      mk({ key: "venkatappa", name: "Venkatappa Art Gallery", category: "art", lat: 12.9761, lon: 77.5958, cost: 20, durationMin: 45, crowd: "low", outdoor: false, opens: 10, closes: 17, veg: "unknown", tags: ["art", "indoor", "quiet", "culture", "cheap"], blurb: "Small, quiet gallery next to Cubbon Park; pairs with a park walk.", area: "Kasturba Road" }),
      mk({ key: "ranga", name: "Ranga Shankara", category: "music", lat: 12.9109, lon: 77.5751, cost: 400, durationMin: 120, crowd: "medium", outdoor: false, opens: 10, closes: 22, veg: "unknown", tags: ["music", "theatre", "culture", "indoor", "evening"], blurb: "Beloved theatre and performance space with a cafe; check the evening programme.", area: "JP Nagar" }),
      mk({ key: "bic", name: "Bangalore International Centre", category: "music", lat: 12.9785, lon: 77.6408, cost: 0, durationMin: 90, crowd: "low", outdoor: false, opens: 9, closes: 21, veg: "unknown", tags: ["music", "culture", "indoor", "quiet", "garden"], blurb: "Calm cultural centre with a garden cafe and frequent talks and concerts.", area: "Domlur" }),
      mk({ key: "vvpuram", name: "VV Puram Food Street", category: "market", lat: 12.9467, lon: 77.5715, cost: 250, durationMin: 60, crowd: "high", outdoor: true, opens: 17, closes: 22, veg: "only", tags: ["food", "street food", "vegetarian", "evening"], blurb: "Legendary vegetarian street food lane that comes alive after 5pm; busy on Saturdays.", area: "Basavanagudi" }),
      mk({ key: "bullt", name: "Bull Temple & Dodda Ganesha", category: "temple", lat: 12.9429, lon: 77.568, cost: 0, durationMin: 45, crowd: "medium", outdoor: true, opens: 7, closes: 20, veg: "unknown", tags: ["temple", "culture", "walks", "free"], blurb: "Ancient Nandi temple on a rocky hill with a short walk through Basavanagudi.", area: "Basavanagudi" }),
      mk({ key: "mtr", name: "MTR (Mavalli Tiffin Rooms)", category: "food", lat: 12.9552, lon: 77.5853, cost: 450, durationMin: 60, crowd: "high", outdoor: false, opens: 7, closes: 21, veg: "only", tags: ["food", "vegetarian", "south indian", "classic"], blurb: "Iconic 1924 vegetarian restaurant, famous for rava idli and filter coffee. Expect a queue at peak hours.", area: "Lalbagh Road" }),
      mk({ key: "vidyarthi", name: "Vidyarthi Bhavan", category: "food", lat: 12.9453, lon: 77.5733, cost: 200, durationMin: 45, crowd: "high", outdoor: false, opens: 7.5, closes: 20, veg: "only", tags: ["food", "vegetarian", "dosa", "classic", "cheap"], blurb: "Cult masala dosa since 1943; quick service but often a queue outside.", area: "Gandhi Bazaar" }),
      mk({ key: "ctr", name: "CTR (Shri Sagar)", category: "food", lat: 13.0036, lon: 77.5703, cost: 220, durationMin: 45, crowd: "high", outdoor: false, opens: 7.5, closes: 21, veg: "only", tags: ["food", "vegetarian", "dosa", "classic", "cheap"], blurb: "Famous benne masala dosa in Malleshwaram, near Sankey Tank.", area: "Malleshwaram" }),
      mk({ key: "dyu", name: "Garden-view cafe at Bangalore International Centre", category: "cafe", lat: 12.9785, lon: 77.6408, cost: 400, durationMin: 50, crowd: "low", outdoor: false, opens: 9, closes: 20, veg: "yes", tags: ["food", "cafe", "quiet", "vegetarian", "coffee"], blurb: "Quiet garden cafe with vegetarian options, ideal when you want to sit and recharge.", area: "Domlur" }),
      mk({ key: "koshys", name: "Koshy's", category: "cafe", lat: 12.9755, lon: 77.6063, cost: 700, durationMin: 70, crowd: "medium", outdoor: false, opens: 9, closes: 23, veg: "yes", tags: ["food", "cafe", "classic", "coffee", "vegetarian-friendly"], blurb: "Old-world cafe on St Marks Road with vegetarian options and unhurried seating.", area: "St Marks Road" }),
      mk({ key: "commercial", name: "Commercial Street", category: "market", lat: 12.9822, lon: 77.6084, cost: 500, durationMin: 60, crowd: "high", outdoor: true, opens: 10, closes: 21, veg: "unknown", tags: ["shopping", "market", "busy"], blurb: "Dense shopping street, extremely busy on Saturdays.", area: "Shivajinagar" }),
    ],
  },
};
