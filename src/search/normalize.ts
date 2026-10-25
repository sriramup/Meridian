// Text normalisation for place search. Names and queries go through the same pipeline, so
// "W 21st St", "West Twenty-first Street" and "west 21 street" all become the tokens [w, 21, st].
// Street types, directions and stop words are "soft": they help ranking but are never required.

/** long forms → canonical token (both sides of a match are canonicalised) */
const CANON: Record<string, string> = {
  street: "st",
  str: "st",
  avenue: "ave",
  av: "ave",
  aven: "ave",
  boulevard: "blvd",
  blv: "blvd",
  road: "rd",
  drive: "dr",
  lane: "ln",
  court: "ct",
  place: "pl",
  parkway: "pkwy",
  highway: "hwy",
  circle: "cir",
  terrace: "ter",
  trail: "trl",
  square: "sq",
  plaza: "plz",
  expressway: "expy",
  freeway: "fwy",
  crossing: "xing",
  north: "n",
  south: "s",
  east: "e",
  west: "w",
  northeast: "ne",
  northwest: "nw",
  southeast: "se",
  southwest: "sw",
  saint: "st",
  mount: "mt",
  fort: "ft",
  interstate: "i",
  ih: "i",
  junior: "jr",
  doctor: "dr",
  "&": "and",
  "+": "and",
  "n°": "no",
  number: "no",
};

/** canonical tokens that are street types (soft) */
const TYPES = new Set(["st", "ave", "blvd", "rd", "dr", "ln", "ct", "pl", "pkwy", "hwy", "cir", "ter", "trl", "way", "row", "loop", "expy", "fwy", "xing", "plz", "sq", "alley", "path", "walk"]);
/** directions (soft) */
const DIRS = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw"]);
/** stop words, and "building", which a query adds to a name that lacks it ("capitol building") (soft) */
const STOP = new Set(["and", "the", "of", "at", "in", "on", "a", "an", "by", "to", "for", "jr", "sr", "building", "bldg"]);

const UNITS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19,
};
const TENS_ORD: Record<string, number> = { twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50, sixtieth: 60, seventieth: 70, eightieth: 80, ninetieth: 90 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** phrases rewritten before tokenising */
const PHRASES: [RegExp, string][] = [
  [/\bmartin luther king\b/g, "mlk"],
  [/\bm l k\b/g, "mlk"],
  [/\bcesar chavez\b/g, "cesar chavez"],
];

export interface Token {
  /** canonical text */
  t: string;
  /** a street type, direction or stop word: helps ranking, never required */
  soft: boolean;
  /** all digits (house numbers, numbered streets): matched exactly, never fuzzily */
  num: boolean;
}

/** lower case, no accents or apostrophes, separators → spaces */
export function fold(s: string): string {
  return (/[^ -~]/.test(s) ? s.normalize("NFD").replace(/\p{M}/gu, "") : s)
    .toLowerCase()
    .replace(/['\u2019`.]/g, "")
    .replace(/&/g, " & ")
    .replace(/\+/g, " + ");
}

function canon(w: string): string {
  if (CANON[w]) return CANON[w];
  // 21st, 2nd, 3rd, 4th → 21, 2, 3, 4
  const m = /^(\d+)(st|nd|rd|th)$/.exec(w);
  if (m) return m[1];
  if (UNITS[w]) return String(UNITS[w]);
  if (TENS_ORD[w]) return String(TENS_ORD[w]);
  return w;
}

/** raw words of a string (after folding and phrase rewrites) */
export function words(s: string): string[] {
  let f = fold(s);
  for (const [re, to] of PHRASES) f = f.replace(re, to);
  const out = f.split(/[^a-z0-9&+]+/).filter(Boolean);
  // twenty-first / twenty first → 21
  const merged: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const w = out[i];
    const n = out[i + 1];
    if (TENS[w] && n && UNITS[n] && UNITS[n] < 10) {
      merged.push(String(TENS[w] + UNITS[n]));
      i++;
    } else merged.push(w);
  }
  return merged;
}

function tokenOf(t: string): Token {
  return { t, soft: TYPES.has(t) || DIRS.has(t) || STOP.has(t), num: /^\d+$/.test(t) };
}

/** canonical tokens of a name or query */
export function tokenize(s: string): Token[] {
  let t = tokCache.get(s);
  if (!t) {
    if (tokCache.size > 50_000) tokCache.clear();
    t = words(s).map((w) => tokenOf(canon(w)));
    tokCache.set(s, t);
  }
  return t;
}
/** names repeat (every segment of a street): tokens are cached per string; treat them as read-only */
const tokCache = new Map<string, Token[]>();
const keyCache = new Map<string, string>();

/** the normalised key of a name ("West 21st Street" → "w 21 st") */
export function normKey(s: string): string {
  let k = keyCache.get(s);
  if (k === undefined) {
    if (keyCache.size > 50_000) keyCache.clear();
    k = tokenize(s)
      .map((t) => t.t)
      .join(" ");
    keyCache.set(s, k);
  }
  return k;
}

const LONG = Object.keys(CANON).filter((k) => k.length >= 4);

/** a long form written with one typo ("stret", "avenu", "sqare", "boulvard") */
function misspeltLong(word: string): string | null {
  if (word.length < 4 || CANON[word]) return null;
  for (const l of LONG) if (Math.abs(l.length - word.length) <= 1 && within1(word, l)) return CANON[l];
  return null;
}

/** edit distance ≤ 1 (one insertion, deletion, substitution or adjacent swap) */
function within1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length,
    lb = b.length;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/**
 * Canonical forms a query word may stand for: its own, a misspelt long form's ("stret" → st), and,
 * for the word being typed, every long form it begins ("aven" → ave, "boule" → blvd).
 */
export function queryForms(word: string, partial: boolean): string[] {
  const c = canon(word);
  const out = new Set([c]);
  const m = misspeltLong(word);
  if (m) out.add(m);
  if (partial) {
    out.add(word);
    if (word.length >= 3) for (const l of LONG) if (l.startsWith(word)) out.add(CANON[l]);
  }
  return [...out];
}

export const isSoft = (t: string) => TYPES.has(t) || DIRS.has(t) || STOP.has(t);
/** a street type ("st", "sq", "plz"): the head of a place's name ("Capitol Square" is a square), not of a street's */
export const isType = (t: string) => TYPES.has(t);
/** a stop word ("the", "of", "building"): neutral when a name lacks it */
export const isStop = (t: string) => STOP.has(t);
export const isStreetType = (t: string) => TYPES.has(t);

// ---- display -------------------------------------------------------------------------------

const ABBR: Record<string, string> = {
  street: "St", avenue: "Ave", boulevard: "Blvd", road: "Rd", drive: "Dr", lane: "Ln", court: "Ct", place: "Pl", parkway: "Pkwy", highway: "Hwy",
  circle: "Cir", terrace: "Ter", trail: "Trl", north: "N", south: "S", east: "E", west: "W", square: "Sq",
};

/** a street name as people write it: "West 21st Street" → "W 21st St", "East Avenue" → "East Ave" */
export function abbreviate(name: string): string {
  const parts = name.trim().split(/\s+/);
  const n = parts.length;
  return parts
    .map((p, i) => {
      const a = ABBR[p.toLowerCase()];
      if (!a) return p;
      const dir = /^[NSEW]$/.test(a);
      if (dir) return i === 0 && n >= 3 ? a : p;
      return i === n - 1 && n >= 2 ? a : p;
    })
    .join(" ");
}

/** "CESAR CHAVEZ/BRAZOS" → "Cesar Chavez/Brazos" (all-caps source names) */
export function titleCase(s: string): string {
  if (s !== s.toUpperCase()) return s.replace(/\b(\d+)(St|Nd|Rd|Th)\b/g, (_, n, o) => n + o.toLowerCase());
  return s
    .toLowerCase()
    .replace(/(^|[\s/(-])([a-z])/g, (_, a, b) => a + b.toUpperCase())
    .replace(/\b(\d+)(St|Nd|Rd|Th)\b/g, (_, n, o) => n + o.toLowerCase());
}

/**
 * Split an intersection query into its two streets: "21st & Guadalupe", "21st and Guadalupe",
 * "W 21st St / Guadalupe St", "21st at guadalupe", "21st @ guadalupe". Null when it is not one.
 */
export function splitIntersection(q: string): [string, string] | null {
  const m = /^(.+?)\s*(?:&|\+|\/|@|\band\b|\bat\b|\bx\b)\s*(.*)$/i.exec(q.trim());
  if (!m) return null;
  const a = m[1].trim(),
    b = m[2].trim();
  if (!a) return null;
  return [a, b];
}

/** looks like a street address: a house number followed by a word ("1100 congress", "101 e 21st st") */
export function looksLikeAddress(q: string): boolean {
  const w = words(q);
  return w.length >= 2 && /^\d+[a-z]?$/.test(w[0]) && /[a-z]/.test(w.slice(1).join(" "));
}
