// Model assumptions go back to the team, not onto the screen: each distinct set (per model kind and
// city) is posted once per session to /api/telemetry, which logs it server-side.

const sent = new Set<string>();

/** the session-dedup key of an assumption set */
export function assumptionKey(kind: string, city: string, assumptions: string[]): string {
  return `${kind}|${city}|${assumptions.join("\u0001")}`;
}

/** queue a report unless this session already sent the same one; returns whether it was sent */
export function reportAssumptions(kind: string, city: string, assumptions: unknown, detail?: unknown, post: (body: string) => void = beacon): boolean {
  if (!Array.isArray(assumptions) || !assumptions.length) return false;
  const lines = assumptions.filter((x): x is string => typeof x === "string");
  const key = assumptionKey(kind, city, lines);
  if (sent.has(key)) return false;
  sent.add(key);
  try {
    post(JSON.stringify({ type: "assumptions", kind, city, assumptions: lines, ...(detail !== undefined ? { detail } : {}) }));
  } catch {
    // telemetry never breaks a model run
  }
  return true;
}

function beacon(body: string) {
  if (typeof window === "undefined") return; // headless runs have no server to report to
  void fetch("/api/telemetry", { method: "POST", body, headers: { "content-type": "application/json" }, keepalive: true }).catch(() => {});
}

/** test hook */
export function resetTelemetrySession() {
  sent.clear();
}
