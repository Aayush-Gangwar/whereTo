/** Small text-matching helpers shared by the geocoder and the city resolver. No I/O. */

/** lower-case, accents removed, only letters and digits: "Delhi, India" -> "delhiindia" */
export const norm = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

/** The words of a name, normalised: "New Delhi, India" -> ["new", "delhi", "india"] */
export const words = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter(Boolean);

/** Optimal-string-alignment distance: single edits and adjacent swaps ("Delih" -> "Delhi" is 1). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** How many typos to forgive: none for very short text, one for short, two for longer. */
export const typoAllowance = (len: number) => (len <= 4 ? 0 : len <= 7 ? 1 : 2);

/**
 * The typed text names this place: identical, or whole words match ("Jaipur, Rajasthan" and "jaipur city" name
 * Jaipur; "New Delhi" names Delhi). A mere prefix does not count: "Bangalor" is not "Bangalore Town".
 */
export const sameName = (typed: string, name: string) => {
  const t = norm(typed), n = norm(name);
  if (!t || !n) return false;
  if (t === n) return true;
  const tw = words(typed), nw = words(name);
  if (nw.length && nw.every((w) => tw.includes(w))) return n.length >= 4; // the place's whole name appears in the text
  // the text is the main part of the place's name ("Delhi" in "New Delhi"); at most one extra word, so "Mysore Road Tolgate" is not Mysore
  if (t.length >= 4 && tw.length && tw.every((w) => nw.includes(w)) && nw.length - tw.length <= 1) return true;
  return false;
};

/** The typed text is a small typo away from the name. */
export const closeName = (typed: string, name: string) => {
  const t = norm(typed), n = norm(name);
  const allowed = typoAllowance(t.length);
  return allowed > 0 && editDistance(t, n) <= allowed;
};
