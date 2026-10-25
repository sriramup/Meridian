// Token similarity for place search: exact, prefix (as you type) and typo-tolerant matches.

/** optimal-string-alignment distance (adjacent swaps count once), or max + 1 once it exceeds max */
export function editDistance(a: string, b: string, max: number): number {
  const la = a.length,
    lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (a === b) return 0;
  let prev2 = new Array<number>(lb + 1).fill(0);
  let prev = new Array<number>(lb + 1);
  let cur = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cb = b.charCodeAt(j - 1);
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca === cb ? 0 : 1));
      if (i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === cb) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const t = prev2;
    prev2 = prev;
    prev = cur;
    cur = t;
  }
  return prev[lb];
}

/** typos allowed in a word of this length */
export const typoBudget = (len: number) => (len <= 3 ? 0 : len <= 5 ? 1 : 2);

/**
 * How well query word `q` matches name token `t` (0 = not at all, 1 = exactly).
 * `last`: the word being typed, which may be a prefix. Numbers never match fuzzily.
 */
export function tokenSim(q: string, t: string, last: boolean, num: boolean): number {
  if (q === t) return 1;
  if (t.startsWith(q)) {
    if (last) return 0.82 + 0.13 * (q.length / t.length);
    // an abbreviation written out partly elsewhere in the query ("guad st")
    if (!num && q.length >= 4) return 0.72 + 0.1 * (q.length / t.length);
    return 0;
  }
  if (num || /^\d/.test(t)) return 0;
  const k = typoBudget(q.length);
  if (!k) return 0;
  const d = editDistance(q, t, k);
  if (d <= k) return 0.8 - 0.12 * d - (q[0] !== t[0] ? 0.04 : 0);
  // a typo in the part typed so far ("guadelu" → guadalupe)
  if (last && t.length > q.length) {
    const dp = editDistance(q, t.slice(0, q.length), k);
    if (dp <= k) return 0.7 - 0.1 * dp;
  }
  return 0;
}
