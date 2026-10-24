"use client";

// Inspector section for anything placed from the library: the same parameter form as the palette,
// applied live to the instance, plus heading, move, duplicate and delete. Every change is undoable.

import { Copy, Move, RotateCcw, RotateCw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { NumberField, Tooltip } from "@/components/ui/kit";
import { ensureLibrary, getPrimitive, type ParamValues } from "@/library";
import { rt } from "@/state/runtime";
import { useApp } from "@/state/store";
import { programmeOf } from "@/world/ops/core";
import { instanceOf } from "@/world/ops/library";
import type { Building, Entity, LibraryRef } from "@/world/types";
import { IconButton } from "../ui";
import { CATEGORY, PrimitiveIcon } from "./icons";
import { duplicate, reconfigure, remove, rotateBy, setHeading } from "./instanceOps";
import { useLibrary } from "./libraryStore";
import { ParamForm } from "./ParamForm";

export function hasLib(e: Entity): e is Entity & { lib: LibraryRef } {
  return "lib" in e && !!(e as { lib?: LibraryRef }).lib;
}

export function LibraryInspector({ e, onClose }: { e: Entity & { lib: LibraryRef }; onClose: () => void }) {
  ensureLibrary();
  const R = rt();
  const def = getPrimitive(e.lib.def);
  const info = instanceOf(R.world, e.id);
  const params = (info?.params ?? e.lib.params) as ParamValues;
  // the form shows what was last asked for while a throttled change is still being applied
  const [values, setValues] = useState<ParamValues>(params);
  const key = JSON.stringify(params);
  useEffect(() => setValues(params), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const id = info?.primary ?? e.id;
  const heading = info?.placement.rotation ?? 0;
  const hasHeading = !!info?.placement.at;
  const name = ("name" in e && (e as { name?: string }).name) || def?.name || e.lib.def;
  const members = info?.entities.length ?? 1;
  return (
    <>
      <div className="flex items-start gap-2 border-b border-line px-3 py-2.5">
        <span className="mt-0.5 text-rose">{def ? <PrimitiveIcon def={def} size={15} /> : null}</span>
        <div className="min-w-0 flex-1">
          <div className="font-legend text-[12.5px] leading-none text-ink-3">{def ? `${CATEGORY[def.category]?.label ?? def.category} · ${def.name}` : e.lib.def}</div>
          <div className="font-display truncate text-[17px] leading-tight font-semibold text-ink">{name}</div>
        </div>
        <IconButton size="sm" onClick={onClose} className="-mr-1" aria-label="Close">
          <X size={14} />
        </IconButton>
      </div>
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        {hasHeading && (
          <>
            <Tooltip content="Turn 15° left">
              <IconButton size="sm" aria-label="Turn left" onClick={() => rotateBy(id, 15)}>
                <RotateCcw size={14} />
              </IconButton>
            </Tooltip>
            <div className="w-[76px]">
              <NumberField value={Math.round(heading)} onChange={() => {}} onCommit={(v) => setHeading(id, v)} min={-360} max={720} step={5} unit="°" aria-label="Heading" stepper={false} />
            </div>
            <Tooltip content="Turn 15° right">
              <IconButton size="sm" aria-label="Turn right" onClick={() => rotateBy(id, -15)}>
                <RotateCw size={14} />
              </IconButton>
            </Tooltip>
          </>
        )}
        <span className="flex-1" />
        <Tooltip content="Move: click the new spot (G)">
          <IconButton size="sm" aria-label="Move" onClick={() => startMove(id)}>
            <Move size={14} />
          </IconButton>
        </Tooltip>
        <Tooltip content="Duplicate beside it">
          <IconButton size="sm" aria-label="Duplicate" onClick={() => duplicate(id)}>
            <Copy size={14} />
          </IconButton>
        </Tooltip>
        <Tooltip content="Delete (Del)">
          <IconButton size="sm" aria-label="Delete" onClick={() => remove(id)} className="hover:text-bad">
            <Trash2 size={14} />
          </IconButton>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {def ? (
          <ParamForm
            def={def}
            values={values}
            onChange={(v, final) => {
              setValues(v);
              reconfigure(id, v, final);
            }}
            onReset={() => {
              const d = Object.fromEntries(def.params.map((p) => [p.key, p.default]));
              setValues(d);
              reconfigure(id, d, true);
            }}
          />
        ) : (
          <p className="px-3 py-2 text-[12px] text-bad">The definition {e.lib.def} is no longer in the library; this instance can be moved or deleted but not re-configured.</p>
        )}
        <Facts e={R.world.get(id) ?? e} members={members} />
      </div>
    </>
  );
}

const num = (x: number) => (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10).toLocaleString("en-US");

/** a few numbers about what the instance is */
function Facts({ e, members }: { e: Entity; members: number }) {
  const R = rt();
  const rows: [string, string][] = [];
  if (e.kind === "building") {
    const b = e as Building;
    const p = programmeOf(b, R.meta.calibration.householdSize);
    rows.push(["Height", `${num(b.height)} m · ${b.floors} floors`], ["Floor area", `${num(p.gfa)} m²`]);
    if (p.units) rows.push(["Homes", num(p.units)]);
    if (p.jobs) rows.push(["Jobs", num(p.jobs)]);
  } else if (e.kind === "prop") rows.push(["Height", `${num(e.height)} m`]);
  if (members > 1) rows.push(["Parts", `${members} features`]);
  if (!rows.length) return null;
  return (
    <div className="mt-1 border-t border-line px-3 py-2">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between py-[2px] text-[12px]">
          <span className="text-ink-3">{k}</span>
          <span className="tabular text-ink">{v}</span>
        </div>
      ))}
    </div>
  );
}

/** pick the instance up: it follows the cursor until a click puts it down (Esc cancels) */
export function startMove(id: string) {
  useLibrary.getState().startMove(id);
}

