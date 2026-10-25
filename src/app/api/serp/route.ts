import { normalizeRequest } from "@/serp/params";
import { serpService } from "@/serp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SerpApi proxy (src/serp/server.ts does the work). The browser posts a whitelisted request
 * {engine, q, near?, zoom?, location?, num?, since?} and gets compact, normalised JSON back; the key
 * stays on the server. Engines: google (answers, facts, sources), google_maps (local places),
 * google_news and google_scholar.
 *
 * GET reports whether search is configured, the credit cap and what this server has used;
 * GET ?account=1 adds the account's remaining searches (SerpApi's account endpoint costs no search).
 */

export async function GET(req: Request) {
  const withAccount = new URL(req.url).searchParams.get("account") === "1";
  return Response.json(await serpService().status(withAccount), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, code: "bad_request", error: "Expected a JSON body." }, { status: 400 });
  }
  const n = normalizeRequest(body);
  if (!n.ok) return Response.json({ ok: false, code: "bad_request", error: n.error }, { status: 400 });
  const out = await serpService().search(n.req);
  const status = out.ok ? 200 : out.code === "not_configured" ? 503 : out.code === "cap" ? 429 : out.code === "bad_request" ? 400 : out.code === "no_fixture" ? 404 : 502;
  return Response.json(out, { status, headers: { "Cache-Control": "no-store" } });
}
