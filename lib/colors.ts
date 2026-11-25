/** One color per stop (by position), shared by the timeline, map marker and stop card so they are easy to match. */
export const STOP_COLORS = ["#4f46e5", "#e11d48", "#059669", "#d97706", "#0891b2", "#9333ea", "#db2777", "#4d7c0f"];
export const stopColor = (i: number) => STOP_COLORS[i % STOP_COLORS.length];
