import type { Category, Place } from "../types";

type Row = [key: string, name: string, cat: Category, lat: number, lon: number, cost: number, dur: number, crowd: Place["crowd"], outdoor: boolean, opens: number, closes: number, veg: Place["veg"], tags: string, blurb: string, area: string];

const build = (city: string, rows: Row[]): Place[] =>
  rows.map(([key, name, category, lat, lon, cost, durationMin, crowd, outdoor, opens, closes, veg, tags, blurb, area]) => ({
    id: `cur-${city}-${key}`, name, category, lat, lon, cost, durationMin, crowd, outdoor, opens, closes, veg,
    tags: tags.split(","), blurb, area, source: "curated" as const,
  }));

export const MORE_CITIES: Record<string, { center: { lat: number; lon: number }; places: Place[] }> = {
  delhi: {
    center: { lat: 28.6139, lon: 77.209 },
    places: build("delhi", [
      ["lodhi", "Lodhi Garden", "park", 28.5931, 77.2197, 0, 75, "medium", true, 5, 20, "unknown", "walks,nature,quiet,free", "Tomb-dotted garden, Delhi's favourite stroll; calmer on weekday mornings and at dusk.", "Lodhi Road"],
      ["sundernursery", "Sunder Nursery", "park", 28.5937, 77.2437, 50, 90, "low", true, 7, 19, "unknown", "walks,nature,quiet,photography,heritage", "Restored Mughal-era heritage park next to Humayun's Tomb, spacious and quiet.", "Nizamuddin"],
      ["humayun", "Humayun's Tomb", "museum", 28.5933, 77.2507, 40, 80, "medium", true, 6, 18, "unknown", "history,culture,photography,walks", "UNESCO World Heritage Mughal garden-tomb; go late afternoon for soft light.", "Nizamuddin"],
      ["natmuseum", "National Museum", "museum", 28.6117, 77.2193, 20, 100, "low", false, 10, 18, "unknown", "art,history,culture,indoor,quiet", "Air-conditioned museum with sprawling collections; closed Mondays.", "Janpath"],
      ["trivenik", "Triveni Kala Sangam", "art", 28.6256, 77.2321, 0, 45, "low", false, 10, 19, "unknown", "art,culture,indoor,quiet,free", "Art complex with galleries and a leafy courtyard, near Mandi House.", "Tansen Marg"],
      ["ihc", "India Habitat Centre", "music", 28.5918, 77.2255, 300, 90, "low", false, 9, 22, "unknown", "music,culture,indoor,quiet,events", "Cultural campus with concerts, talks and exhibitions; check the evening programme.", "Lodhi Road"],
      ["kamani", "Kamani Auditorium", "music", 28.6262, 77.2349, 400, 110, "medium", false, 10, 22, "unknown", "music,theatre,culture,indoor", "Long-running venue for classical music and dance performances.", "Mandi House"],
      ["dilli", "Dilli Haat INA", "market", 28.5726, 77.2087, 30, 70, "high", true, 10.5, 22, "yes", "shopping,market,food,crafts", "Craft bazaar with regional food stalls; busy on Saturday evenings.", "INA"],
      ["khan", "Khan Market", "market", 28.6005, 77.227, 400, 60, "high", true, 10, 21, "unknown", "shopping,cafe,books", "Upmarket lane of bookshops and cafes; crowded on weekends.", "Khan Market"],
      ["triveni_cafe", "Triveni Terrace Cafe", "cafe", 28.6256, 77.2321, 300, 50, "low", false, 10, 19, "only", "food,cafe,vegetarian,quiet,cheap", "Pure-vegetarian courtyard cafe at Triveni Kala Sangam, quiet and affordable.", "Tansen Marg"],
      ["saravana", "Saravana Bhavan (Janpath)", "food", 28.6258, 77.2178, 450, 60, "high", false, 8, 22.5, "only", "food,vegetarian,south indian,classic", "Reliable pure-veg South Indian meals; expect a queue at peak lunch hours.", "Janpath"],
      ["sagarratna", "Sagar Ratna (Defence Colony)", "food", 28.574, 77.2326, 500, 60, "medium", false, 8, 22.5, "only", "food,vegetarian,south indian", "Long-standing pure-vegetarian South Indian restaurant.", "Defence Colony"],
      ["parantha", "Paranthe Wali Gali", "food", 28.656, 77.2316, 250, 50, "high", false, 9, 22, "only", "food,vegetarian,street food,classic,cheap", "Old Delhi lane of stuffed parathas since the 1870s; narrow and busy.", "Chandni Chowk"],
      ["ich", "Indian Coffee House (Connaught Place)", "cafe", 28.6322, 77.2158, 250, 45, "medium", false, 9, 21, "yes", "food,cafe,coffee,classic,cheap,vegetarian-friendly", "Retro cafe with simple South Indian snacks and filter coffee.", "Connaught Place"],
    ]),
  },
  mumbai: {
    center: { lat: 18.975, lon: 72.8258 },
    places: build("mumbai", [
      ["marine", "Marine Drive Promenade", "viewpoint", 18.944, 72.8235, 0, 60, "medium", true, 5, 23.5, "unknown", "walks,views,sunset,free", "Iconic seafront promenade; stunning near sunset.", "Marine Drive"],
      ["hanging", "Hanging Gardens", "park", 18.956, 72.8049, 0, 50, "low", true, 5, 21, "unknown", "walks,nature,quiet,views,free", "Terraced garden on Malabar Hill with city views.", "Malabar Hill"],
      ["csmvs", "Chhatrapati Shivaji Maharaj Vastu Sangrahalaya", "museum", 18.9269, 72.8326, 100, 90, "medium", false, 10.25, 18, "unknown", "art,history,culture,indoor", "Grand Indo-Saracenic museum; excellent for a cool, unhurried visit.", "Kala Ghoda"],
      ["jehangir", "Jehangir Art Gallery", "art", 18.9275, 72.8322, 0, 40, "low", false, 11, 19, "unknown", "art,culture,indoor,quiet,free", "Mumbai's classic contemporary art gallery.", "Kala Ghoda"],
      ["ncpa", "NCPA (National Centre for the Performing Arts)", "music", 18.9254, 72.8197, 600, 120, "medium", false, 10, 22, "unknown", "music,theatre,culture,indoor", "Premier venue for classical, jazz and theatre; check the programme.", "Nariman Point"],
      ["gateway", "Gateway of India", "viewpoint", 18.922, 72.8347, 0, 30, "high", true, 6, 23, "unknown", "views,history,photography,free", "Landmark arch on the harbour; very crowded on weekends.", "Colaba"],
      ["colaba", "Colaba Causeway", "market", 18.9186, 72.8315, 400, 60, "high", true, 10, 22, "unknown", "shopping,market,busy", "Busy street market with bargains and cafes.", "Colaba"],
      ["samovar", "Cafe Samovar (Jehangir Art Gallery)", "cafe", 18.9276, 72.8322, 450, 50, "low", false, 11, 19, "yes", "food,cafe,quiet,vegetarian-friendly,art", "Garden-style cafe inside the art gallery with veg options.", "Kala Ghoda"],
      ["kgcafe", "Kala Ghoda Cafe", "cafe", 18.9285, 72.8316, 600, 55, "medium", false, 8, 23, "yes", "food,cafe,coffee,vegetarian-friendly", "Cosy all-day cafe in the arts district.", "Kala Ghoda"],
      ["swati", "Swati Snacks", "food", 18.9709, 72.8112, 600, 60, "high", false, 11.5, 22.5, "only", "food,vegetarian,gujarati,classic", "Famed pure-veg Gujarati snacks; typically a wait at peak hours.", "Tardeo"],
    ]),
  },
  hyderabad: {
    center: { lat: 17.385, lon: 78.4867 },
    places: build("hyderabad", [
      ["lumbini", "Lumbini Park", "park", 17.4094, 78.4733, 20, 60, "medium", true, 9, 21, "unknown", "walks,nature,lake,evening", "Lakeside park by Hussain Sagar with a Buddha statue view.", "Hussain Sagar"],
      ["necklace", "Necklace Road (Hussain Sagar)", "viewpoint", 17.4239, 78.4738, 0, 50, "medium", true, 5, 23, "unknown", "walks,views,sunset,free", "Waterfront promenade, pleasant at sunset.", "Hussain Sagar"],
      ["salarjung", "Salar Jung Museum", "museum", 17.3713, 78.4804, 20, 120, "medium", false, 10, 17, "unknown", "art,history,culture,indoor", "Huge private collection; closed Fridays.", "Dar-ul-Shifa"],
      ["chowmahalla", "Chowmahalla Palace", "museum", 17.3578, 78.4717, 80, 80, "low", false, 10, 17, "unknown", "history,culture,quiet,photography", "Restored Nizam-era palace complex; closed Fridays.", "Khilwat"],
      ["shilparamam", "Shilparamam", "market", 17.4521, 78.3813, 50, 90, "medium", true, 10.5, 20, "yes", "shopping,crafts,culture,food", "Arts-and-crafts village with stalls and performances.", "Madhapur"],
      ["ravindra", "Ravindra Bharathi", "music", 17.41, 78.466, 300, 110, "medium", false, 10, 22, "unknown", "music,theatre,culture,indoor", "Historic auditorium for concerts and plays.", "Saifabad"],
      ["chutneys", "Chutneys", "food", 17.4147, 78.4482, 500, 55, "medium", false, 7, 23, "only", "food,vegetarian,south indian", "Pure-veg tiffin and meals with many chutneys.", "Banjara Hills"],
      ["minerva", "Minerva Coffee Shop", "food", 17.413, 78.442, 450, 50, "medium", false, 7, 23, "only", "food,vegetarian,south indian,cheap", "Popular veg South Indian restaurant.", "Himayatnagar"],
    ]),
  },
  chennai: {
    center: { lat: 13.0827, lon: 80.2707 },
    places: build("chennai", [
      ["marina", "Marina Beach", "viewpoint", 13.05, 80.2824, 0, 60, "high", true, 5, 21, "unknown", "walks,views,sunset,free", "Long city beach, best at sunrise or early evening; crowded on Saturdays.", "Marina"],
      ["elliots", "Elliot's Beach", "viewpoint", 13.0003, 80.2723, 0, 70, "low", true, 5, 21, "unknown", "walks,views,quiet,sunset,free", "Calmer beach in Besant Nagar with cafes nearby.", "Besant Nagar"],
      ["theosophical", "Theosophical Society Gardens", "park", 13.0079, 80.261, 20, 70, "low", true, 8.5, 17, "unknown", "walks,nature,quiet", "Huge shaded campus with a giant banyan tree.", "Adyar"],
      ["govtmuseum", "Government Museum Chennai", "museum", 13.0732, 80.257, 50, 100, "low", false, 9.5, 17, "unknown", "art,history,culture,indoor,quiet", "Bronze gallery and archaeology collections; closed Fridays.", "Egmore"],
      ["kapaleeshwarar", "Kapaleeshwarar Temple", "temple", 13.0337, 80.2697, 0, 45, "medium", true, 6, 21, "unknown", "temple,culture,photography,free", "Dravidian temple with colourful gopuram in Mylapore.", "Mylapore"],
      ["musicacademy", "The Music Academy", "music", 13.0407, 80.2578, 300, 110, "medium", false, 9, 21, "unknown", "music,culture,indoor", "Carnatic music hub; check the concert schedule.", "Royapettah"],
      ["ratna", "Ratna Cafe", "food", 13.0568, 80.279, 250, 40, "high", false, 7, 21.5, "only", "food,vegetarian,south indian,classic,cheap", "Legendary sambar-idli, pure vegetarian; busy at peak.", "Triplicane"],
      ["murugan", "Murugan Idli Shop", "food", 13.0415, 80.2335, 300, 40, "medium", false, 6.5, 22.5, "only", "food,vegetarian,south indian,cheap", "Soft idlis and chutney trio, pure-veg.", "T Nagar"],
    ]),
  },
  kolkata: {
    center: { lat: 22.5726, lon: 88.3639 },
    places: build("kolkata", [
      ["victoria", "Victoria Memorial", "museum", 22.5448, 88.3426, 30, 100, "high", false, 10, 17, "unknown", "history,art,culture,photography,walks", "Marble landmark with museum and gardens; closed Mondays and busy on weekends.", "Maidan"],
      ["indianmuseum", "Indian Museum", "museum", 22.558, 88.351, 50, 100, "medium", false, 10, 17, "unknown", "history,culture,indoor", "India's oldest and largest museum; closed Mondays.", "Chowringhee"],
      ["princep", "Prinsep Ghat", "viewpoint", 22.557, 88.332, 0, 50, "medium", true, 5, 20, "unknown", "walks,views,sunset,free", "Riverside promenade by Vidyasagar Setu; lovely at sunset.", "Strand"],
      ["maidan", "The Maidan", "park", 22.5575, 88.3426, 0, 60, "low", true, 5, 19, "unknown", "walks,nature,quiet,free", "Vast green expanse in the city centre.", "Maidan"],
      ["afa", "Academy of Fine Arts", "art", 22.544, 88.348, 10, 50, "low", false, 15, 20, "unknown", "art,culture,quiet,indoor,cheap", "Gallery and museum with a quiet courtyard.", "Cathedral Road"],
      ["rabindra", "Rabindra Sadan", "music", 22.539, 88.349, 300, 110, "medium", false, 10, 22, "unknown", "music,theatre,culture,indoor", "Major hall for concerts and theatre.", "Rabindra Sadan"],
      ["flurys", "Flurys", "cafe", 22.5535, 88.351, 500, 60, "medium", false, 7.5, 21.5, "yes", "food,cafe,classic,coffee,vegetarian-friendly", "Heritage tearoom on Park Street with pastries and breakfast.", "Park Street"],
      ["ichcollege", "Indian Coffee House (College Street)", "cafe", 22.575, 88.364, 200, 60, "medium", false, 9, 21, "yes", "food,cafe,coffee,classic,cheap,culture", "Adda institution among the book stalls.", "College Street"],
    ]),
  },
  pune: {
    center: { lat: 18.5204, lon: 73.8567 },
    places: build("pune", [
      ["shaniwar", "Shaniwar Wada", "museum", 18.5195, 73.8553, 25, 60, "medium", true, 8, 18, "unknown", "history,culture,photography", "Peshwa-era fortification ruins in the old city.", "Old Pune"],
      ["agakhan", "Aga Khan Palace", "museum", 18.5522, 73.9019, 25, 80, "low", true, 9, 17.5, "unknown", "history,culture,quiet,walks,gardens", "Gandhi memorial in leafy grounds.", "Yerawada"],
      ["kelkar", "Raja Dinkar Kelkar Museum", "museum", 18.5105, 73.8553, 50, 80, "low", false, 10, 17.5, "unknown", "art,culture,indoor,quiet", "Eclectic personal collection of everyday artefacts.", "Shukrawar Peth"],
      ["pula", "Pu La Deshpande Garden", "park", 18.488, 73.8405, 20, 60, "low", true, 6, 20, "unknown", "walks,nature,quiet,gardens", "Japanese-style garden by the river.", "Sinhagad Road"],
      ["sarasbaug", "Saras Baug", "park", 18.5008, 73.8574, 0, 50, "medium", true, 5, 21, "unknown", "walks,nature,free,temple", "City garden with the Ganesh temple on an island.", "Sadashiv Peth"],
      ["dagdusheth", "Dagdusheth Halwai Ganpati Temple", "temple", 18.5164, 73.8562, 0, 40, "high", false, 6, 23, "unknown", "temple,culture,free", "Beloved Ganesh temple; busy especially on weekends.", "Budhwar Peth"],
      ["balgandharva", "Balgandharva Rang Mandir", "music", 18.5314, 73.8446, 300, 110, "medium", false, 10, 22, "unknown", "music,theatre,culture,indoor", "Historic theatre; check evening shows.", "JM Road"],
      ["vaishali", "Vaishali", "food", 18.5236, 73.8413, 400, 55, "high", false, 7.5, 22.5, "only", "food,vegetarian,south indian,classic", "Iconic pure-veg FC Road eatery; queues at peak.", "FC Road"],
      ["roopali", "Roopali", "food", 18.5234, 73.8418, 350, 50, "medium", false, 7.5, 22.5, "only", "food,vegetarian,south indian,cheap", "Pure-veg classic on FC Road.", "FC Road"],
    ]),
  },
};
