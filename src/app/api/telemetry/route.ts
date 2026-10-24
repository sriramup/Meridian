import { parseRecord, TelemetryLog, telemetryFile } from "./log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let log: TelemetryLog | null = null;

/** model telemetry from the client (POST only: the log is never readable over HTTP) */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(null, { status: 400 });
  }
  const rec = parseRecord(body);
  if (!rec) return new Response(null, { status: 400 });
  log ??= new TelemetryLog(telemetryFile());
  try {
    log.append(rec);
  } catch {
    // telemetry must never break the app
  }
  return new Response(null, { status: 204 });
}
