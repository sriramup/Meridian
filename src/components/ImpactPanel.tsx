"use client";

import { useEffect, useMemo } from "react";
import { runSim, useSims, type SimRecord } from "@/sim/client";
import type { SimKind } from "@/sim/engine";
import { nearestModelHour, planImpact, useImpact } from "@/sim/impact";
import { rt } from "@/state/runtime";
import { useApp } from "@/state/store";

/** show `kind` for the active scenario as a difference against scenario `sid` ("" clears) */
export async function compareWith(kind: SimKind, sid: string, params: Record<string, unknown>) {
  if (!sid) return useSims.getState().setCompare(kind, undefined);
  const base = await runSim(kind, params, sid);
  const cur = await runSim(kind, params);
  useSims.getState().setShown(kind, cur.id);
  useSims.getState().setCompare(kind, base.id);
}

/**
 * Keeps the per-edit heat effect (sim/impact) current while the heat overlay is open: runs the
 * current city with the same parameters as the plan, then credits each change to its edit. The map
 * shows the result as pins.
 */
export function usePlanImpact() {
  const overlay = useApp((s) => s.overlay);
  const hour = useApp((s) => s.hour);
  useApp((s) => s.worldVersion);
  useApp((s) => s.scenarioVersion);
  const records = useSims((s) => s.records);
  const shown = useSims((s) => s.shown);
  const R = rt();
  const rec = records.find((r) => r.id === shown.heat);
  const edited = R.scenarios.activeId !== "baseline" && R.scenarios.active.cursor > 0;
  const params = rec?.params ?? {};
  const base: SimRecord | undefined = records.find((r) => r.kind === "heat" && r.scenarioId === "baseline" && r.status === "done" && JSON.stringify(r.params) === JSON.stringify(params));
  const current = rec?.status === "done" && rec.scenarioId === R.scenarios.activeId && rec.cursor === R.scenarios.active.cursor ? rec : undefined;

  useEffect(() => {
    if (overlay === "heat" && edited && !base && rec?.status === "done") runSim("heat", params, "baseline").catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay, edited, !!base, rec?.id]);

  // impacts are read at the modelled hour nearest the clock: scrubbing between two of them changes nothing
  const modelHour = base ? nearestModelHour(base.result.hours, hour) : null;
  const impact = useMemo(() => (overlay === "heat" && edited && base && current && modelHour !== null ? planImpact(base.result, current.result, modelHour, R.meta.grid, R.scenarios.appliedChangesets()) : null), [overlay, edited, base, current, modelHour, R]);
  useEffect(() => useImpact.getState().set(impact), [impact]);
  return { edited, base, params };
}
