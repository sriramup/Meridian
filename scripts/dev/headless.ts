// Headless runtime: loads a city pack from disk into the same singletons the
// browser uses, so the agent's tool executor (and the simulation engine, run
// in-process) can be driven from Node for acceptance testing.
import fs from "node:fs";
import { sandboxRuntime, setRuntime, type Runtime } from "@/state/runtime";
import { ScenarioManager } from "@/world/scenarios";
import type { Entity } from "@/world/types";
import { World } from "@/world/world";

export function loadHeadless(cityId = "austin", climateId = "austin"): Runtime {
  if (cityId === "sandbox") {
    const R = sandboxRuntime(climateId, JSON.parse(fs.readFileSync(`public/data/${climateId}/meta.json`, "utf8")));
    setRuntime(R);
    return R;
  }
  const dir = `public/data/${cityId}`;
  const json = (f: string) => JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8"));
  const meta = json("meta.json");
  const w = json("world.json");
  const ref = json("reference.json");
  const world = new World(meta);
  const entities: Entity[] = [...w.nodes, ...w.streets, ...w.buildings, ...w.areas, ...w.trees, ...w.parcels, ...w.stops, ...w.routes, ...w.paths, ...w.pois, ...w.places, ...json("utilities.json")];
  world.load(entities);
  world.takeDirty();
  const buf = (f: string) => {
    const b = fs.readFileSync(`${dir}/${f}`);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };
  const R: Runtime = {
    cityId,
    climateId: cityId,
    meta,
    world,
    scenarios: new ScenarioManager(world),
    scene: null as unknown as Runtime["scene"],
    context: { buildings: [], roads: [], areas: [] },
    census: ref.census,
    counts: ref.counts,
    fema: ref.fema,
    landcover: new Uint8Array(buf("landcover.bin")),
    dem: new Uint16Array(buf("dem.bin")),
    map: null,
    overlay: null,
  };
  setRuntime(R);
  return R;
}
