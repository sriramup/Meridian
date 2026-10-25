// Browser side of the SerpApi integration: posts whitelisted requests to the server proxy
// (/api/serp) and reads its status. The key never reaches the browser. Tests swap the transport for
// the server's fixture mode (setSerpTransport), so nothing here touches the network in vitest.

import type { SerpCredits, SerpData, SerpRequest, SerpResponse, SerpStatus } from "./types";

export class SerpError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export type SerpTransport = (req: SerpRequest, signal?: AbortSignal) => Promise<SerpResponse>;

async function fetchTransport(req: SerpRequest, signal?: AbortSignal): Promise<SerpResponse> {
  let res: Response;
  try {
    res = await fetch("/api/serp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req), signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    return { ok: false, code: "upstream", error: "The search service could not be reached." };
  }
  try {
    return (await res.json()) as SerpResponse;
  } catch {
    return { ok: false, code: "upstream", error: `The search service answered HTTP ${res.status}.` };
  }
}

let transport: SerpTransport = fetchTransport;
/** replace the transport (tests answer from fixtures); null restores the proxy */
export function setSerpTransport(t: SerpTransport | null) {
  transport = t ?? fetchTransport;
}

type Listener = (c: SerpCredits) => void;
const listeners = new Set<Listener>();
/** follow the server's credit counter as searches come back */
export function onCredits(f: Listener): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** one search through the proxy; throws SerpError with the server's message on refusal */
export async function serpSearch(req: SerpRequest, signal?: AbortSignal): Promise<{ data: SerpData; cached: boolean; fixture: boolean }> {
  const r = await transport(req, signal);
  if (r.credits) for (const f of listeners) f(r.credits);
  if (!r.ok) throw new SerpError(r.error, r.code);
  return { data: r.data, cached: r.cached, fixture: !!r.fixture };
}

export async function serpStatus(account = false): Promise<SerpStatus | null> {
  try {
    const res = await fetch(`/api/serp${account ? "?account=1" : ""}`);
    return res.ok ? ((await res.json()) as SerpStatus) : null;
  } catch {
    return null;
  }
}
