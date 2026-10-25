/** "just now", "5 min ago", "3 h ago", "yesterday", "Tue", "Mar 4", "Mar 4, 2025" */
export function relativeTime(t: number, now = Date.now()): string {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  const d = new Date(t),
    n = new Date(now);
  const sameDay = d.toDateString() === n.toDateString();
  if (sameDay || s < 6 * 3600) return `${Math.round(s / 3600)} h ago`;
  const y = new Date(now - 86400_000);
  if (d.toDateString() === y.toDateString()) return "yesterday";
  if (s < 6 * 86400) return d.toLocaleDateString("en-US", { weekday: "short" });
  return d.toLocaleDateString("en-US", d.getFullYear() === n.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}
