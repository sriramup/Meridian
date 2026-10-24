import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseRecord, recordHash, TelemetryLog } from "@/app/api/telemetry/log";
import { reportAssumptions, resetTelemetrySession } from "@/sim/telemetry";

describe("model telemetry", () => {
  it("the client posts each assumption set once per session", () => {
    resetTelemetrySession();
    const posted: string[] = [];
    const post = (b: string) => posted.push(b);
    expect(reportAssumptions("heat", "austin", ["a", "b"], undefined, post)).toBe(true);
    expect(reportAssumptions("heat", "austin", ["a", "b"], undefined, post)).toBe(false);
    expect(reportAssumptions("heat", "sandbox", ["a", "b"], undefined, post)).toBe(true);
    expect(reportAssumptions("traffic", "austin", ["a", "b"], undefined, post)).toBe(true);
    expect(reportAssumptions("heat", "austin", [], undefined, post)).toBe(false);
    expect(reportAssumptions("heat", "austin", undefined, undefined, post)).toBe(false);
    expect(posted.length).toBe(3);
    expect(JSON.parse(posted[0])).toEqual({ type: "assumptions", kind: "heat", city: "austin", assumptions: ["a", "b"] });
  });

  it("validates bodies", () => {
    expect(parseRecord(null)).toBeNull();
    expect(parseRecord({ type: "other", kind: "heat", assumptions: [] })).toBeNull();
    expect(parseRecord({ type: "assumptions", kind: "heat", assumptions: [1] })).toBeNull();
    expect(parseRecord({ type: "assumptions", kind: "heat", assumptions: ["x"], city: "austin", extra: 1 })).toEqual({ type: "assumptions", kind: "heat", assumptions: ["x"], city: "austin" });
  });

  it("the server log keeps one line per distinct record, across restarts", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tel-")), "sub", "log.jsonl");
    const r = parseRecord({ type: "assumptions", kind: "heat", city: "austin", assumptions: ["x", "y"] })!;
    const a = new TelemetryLog(file);
    expect(a.append(r)).toBe(true);
    expect(a.append(r)).toBe(false);
    expect(a.append({ ...r, assumptions: ["x"] })).toBe(true);
    const b = new TelemetryLog(file); // a restarted server
    expect(b.append(r)).toBe(false);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBe(2);
    expect(lines[0].hash).toBe(recordHash(r));
    expect(lines[0].assumptions).toEqual(["x", "y"]);
  });
});
