import { describe, expect, it } from "vitest";
import { adjacentMonths, evictLru, heatBytes, staleRuns, stateKey } from "@/sim/heatCache";
import { monthDate } from "@/state/store";

describe("heat run buffering", () => {
  it("evicts least recently used, never pinned, until under the cap", () => {
    const e = [
      { id: "a", bytes: 50, lastUsed: 1 },
      { id: "b", bytes: 50, lastUsed: 2 },
      { id: "c", bytes: 50, lastUsed: 3 },
      { id: "d", bytes: 50, lastUsed: 4 },
    ];
    expect(evictLru(e, 200, new Set())).toEqual([]);
    expect(evictLru(e, 120, new Set())).toEqual(["a", "b"]);
    expect(evictLru(e, 120, new Set(["a"]))).toEqual(["b", "c"]);
    // pinned runs alone over the cap: keep them, drop everything else
    expect(evictLru(e, 10, new Set(["c", "d"]))).toEqual(["a", "b"]);
  });

  it("an edit makes that scenario's other states stale; other scenarios are kept", () => {
    const cur = stateKey("s1", ["c1", "c2"]);
    const runs = [
      { id: "old", scenarioId: "s1", state: stateKey("s1", ["c1"]) },
      { id: "now", scenarioId: "s1", state: cur },
      { id: "base", scenarioId: "baseline", state: stateKey("baseline", []) },
      { id: "shown", scenarioId: "s1", state: stateKey("s1", []) },
    ];
    expect(staleRuns(runs, "s1", cur, new Set(["shown"]))).toEqual(["old"]);
  });

  it("state keys distinguish order and content of edits", () => {
    expect(stateKey("s", ["a", "b"])).not.toBe(stateKey("s", ["b", "a"]));
    expect(stateKey("s", [])).not.toBe(stateKey("t", []));
  });

  it("neighbouring months wrap the year", () => {
    expect(adjacentMonths("12-10", monthDate)).toEqual(["01-17", "11-14"]);
    expect(adjacentMonths("01-17", monthDate)).toEqual(["02-16", "12-10"]);
  });

  it("sizes a run by its rasters and tiles", () => {
    expect(heatBytes({ exposure: [new Uint8Array(10)], surface: [new Uint8Array(10)], tiles: { hourly: [new Float32Array(5)] } })).toBe(40);
  });
});
