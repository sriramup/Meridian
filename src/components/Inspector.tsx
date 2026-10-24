"use client";

import { Building2, CircleDot, Combine, Layers3, Leaf, Minus, Plus, Route, Trash2, X, Bike, BusFront, Footprints, ArrowLeftRight, MousePointer2, TramFront } from "lucide-react";
import { useMemo, useState } from "react";
import { carriagewayWidth, DEFAULT_WIDTH, hasSidewalk, laneCount, sectionWidth } from "@/geometry/crossSection";
import { TYPOLOGIES, type Typology } from "@/geometry/massing";
import { polyArea } from "@/geometry/polygon";
import { polyLength } from "@/geometry/polyline";
import { MODEL } from "@/render/theme";
import { applyOp } from "@/state/actions";
import { rt } from "@/state/runtime";
import { useApp } from "@/state/store";
import { entityName } from "@/agent/resolve";
import { modifyBuildings, mergeBuildings, removeBuildings, heightLimitAt } from "@/world/ops/buildings";
import { fmt, programmeOf } from "@/world/ops/core";
import { removeEntities, convertAreas, renameEntities, updateTree } from "@/world/ops/landscape";
import { SPECIES, speciesOf } from "@/world/species";
import { editStreetSections, removeStreets, setNodeControl } from "@/world/ops/streets";
import type { SectionEdit } from "@/world/ops/sectionEdit";
import { checkBuilding } from "@/world/ops/validate";
import type { Area, AreaType, Building, Entity, Parcel, Street, StreetNode, Strip, StripType, TransitRoute, Tree } from "@/world/types";
import { Button, IconButton, Provenance, Segmented, Stat, cx } from "./ui";
import { LibraryInspector, hasLib } from "./library/LibraryInspector";

const user = { author: "user" as const };

export function Inspector() {
  useApp((s) => s.worldVersion);
  const selection = useApp((s) => s.selection);
  const R = rt();
  const ents = selection.map((id) => R.world.get(id)).filter((e): e is Entity => !!e);
  if (!ents.length) return null;
  const close = () => useApp.getState().setSelection([]);
  return (
    <div className="pointer-events-auto flex max-h-full w-[320px] flex-col overflow-hidden chrome">
      {ents.length === 1 ? (
        <Single e={ents[0]} onClose={close} />
      ) : (
        <Multi ents={ents} onClose={close} />
      )}
    </div>
  );
}

function Header({ icon, kind, title, onClose, badge, onRename }: { icon: React.ReactNode; kind: string; title: string; onClose: () => void; badge?: React.ReactNode; onRename?: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const commit = () => {
    setEditing(false);
    if (onRename && draft.trim() !== title) onRename(draft);
  };
  return (
    <div className="flex items-start gap-2 border-b border-line px-3 py-2.5">
      <span className="mt-0.5 text-ink-3">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="font-legend text-[12.5px] leading-none text-ink-3">{kind}</div>
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") setEditing(false);
            }}
            className="font-display h-6 w-full rounded-[4px] border border-line-2 bg-paper px-1 text-[16px] leading-tight font-semibold text-ink outline-none"
          />
        ) : (
          <div
            className={cx("font-display truncate text-[17px] leading-tight font-semibold text-ink", onRename && "cursor-text rounded-[4px] hover:bg-paper-3")}
            title={onRename ? "Rename" : undefined}
            onClick={() => {
              if (!onRename) return;
              setDraft(title.startsWith("Unnamed") ? "" : title);
              setEditing(true);
            }}
          >
            {title}
          </div>
        )}
      </div>
      {badge}
      <IconButton size="sm" onClick={onClose} className="-mr-1">
        <X size={14} />
      </IconButton>
    </div>
  );
}

const rename = (ids: string[]) => (name: string) => applyOp(renameEntities(rt().world, ids, name, user));

function Single({ e, onClose }: { e: Entity; onClose: () => void }) {
  // anything placed from the library is edited through its primitive's parameters
  if (hasLib(e)) return <LibraryInspector e={e} onClose={onClose} />;
  switch (e.kind) {
    case "building":
      return <BuildingPanel b={e} onClose={onClose} />;
    case "street":
      return <StreetPanel s={e} onClose={onClose} />;
    case "node":
      return <NodePanel n={e} onClose={onClose} />;
    case "area":
      return <AreaPanel a={e} onClose={onClose} />;
    case "parcel":
      return <ParcelPanel p={e} onClose={onClose} />;
    case "tree":
      return <TreePanel t={e} onClose={onClose} />;
    case "route":
      return <RoutePanel r={e} onClose={onClose} />;
    default:
      return (
        <>
          <Header icon={<MousePointer2 size={15} />} kind={e.kind} title={entityName(e)} onClose={onClose} />
          <div className="p-3 text-[12px] text-ink-3">{"source" in e ? String((e as { source?: string }).source) : ""}</div>
        </>
      );
  }
}

function Row({ k, v, prov }: { k: string; v: React.ReactNode; prov?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-[3px] text-[12px]">
      <span className="text-ink-3">{k}</span>
      <span className="flex items-center gap-1.5 tabular text-right text-ink">
        {v}
        {prov && <Provenance kind={prov} />}
      </span>
    </div>
  );
}

function BuildingPanel({ b, onClose }: { b: Building; onClose: () => void }) {
  const R = rt();
  const hh = R.meta.calibration.householdSize;
  const p = programmeOf(b, hh);
  const [floors, setFloors] = useState(b.floors);
  const [typo, setTypo] = useState<Typology>("tower_podium");
  const issues = useMemo(() => checkBuilding(R.world, b), [b, R.world]);
  const hl = useMemo(() => heightLimitAt(R.world, b.footprint), [b, R.world]);
  const par = b.parcelId ? R.world.get<Parcel>(b.parcelId) : undefined;
  return (
    <>
      <Header icon={<Building2 size={15} />} kind={`${b.use} building`} title={b.name ?? b.address ?? "Unnamed building"} onClose={onClose} onRename={rename([b.id])} badge={b.createdBy ? <Provenance kind="proposed" /> : b.historic ? <span className="rounded-[4px] bg-paper-3 px-1.5 py-0.5 text-[10.5px] font-medium text-ink-2">Historic</span> : undefined} />
      <div className="scroll-thin overflow-y-auto">
        <div className="grid grid-cols-3 gap-3 px-3 pt-3">
          <Stat label="Height" value={`${b.height.toFixed(0)} m`} />
          <Stat label="Floors" value={b.floors} />
          <Stat label="GFA" value={`${(p.gfa / 1000).toFixed(1)}k m²`} />
          <Stat label="Homes" value={p.units >= 1 ? fmt.int(p.units) : "—"} />
          <Stat label="Residents" value={p.residents >= 1 ? fmt.int(p.residents) : "—"} />
          <Stat label="Jobs" value={p.jobs >= 1 ? fmt.int(p.jobs) : "—"} />
        </div>
        <div className="px-3 pt-3 pb-1">
          <Row k="Height source" v={b.heightSource === "measured" ? "LiDAR 2023" : b.heightSource} prov={b.heightSource} />
          <Row k="Use" v={Object.entries(b.program).map(([u, s]) => `${u} ${Math.round((s ?? 0) * 100)}%`).join(", ")} prov={b.useSource} />
          {b.existing && <Row k="Occupancy" v="Census / LODES" prov="estimated" />}
          <Row k="Footprint" v={fmt.m2(polyArea(b.footprint))} />
          <Row k="Volumes" v={b.masses.map((m) => m.role).filter((r, i, a) => a.indexOf(r) === i).join(" · ")} />
          {par && <Row k="Zoning" v={par.zoning} />}
          <Row k="Height limit" v={hl.limit != null ? `${hl.limit.toFixed(0)} m` : "none (FAR-governed)"} />
          {hl.source.length > 0 && <div className="pb-1 text-right text-[10.5px] text-ink-4">{hl.source[hl.source.length - 1]}</div>}
        </div>
        {issues.length > 0 && (
          <div className="mx-3 mb-2 space-y-1 rounded-[6px] bg-warn-2/70 px-2.5 py-2">
            {issues.map((i, k) => (
              <div key={k} className={cx("text-[11.5px] leading-snug", i.severity === "error" ? "text-bad" : "text-ink-2")}>
                {i.message}
              </div>
            ))}
          </div>
        )}
        <div className="border-t border-line px-3 py-3">
          <div className="mb-2 font-legend text-[12.5px] leading-none text-ink-3">Edit</div>
          <div className="flex items-center gap-2">
            <span className="w-14 text-[12px] text-ink-3">Floors</span>
            <IconButton size="sm" onClick={() => setFloors(Math.max(1, floors - 1))}>
              <Minus size={13} />
            </IconButton>
            <input type="number" value={floors} min={1} max={150} onChange={(e) => setFloors(Math.max(1, +e.target.value))} className="tabular h-7 w-14 rounded-[5px] border border-line-2 bg-paper text-center text-[12.5px] outline-none focus:border-ink-4" />
            <IconButton size="sm" onClick={() => setFloors(floors + 1)}>
              <Plus size={13} />
            </IconButton>
            <Button size="sm" className="ml-auto" disabled={floors === b.floors} onClick={() => applyOp(modifyBuildings(R.world, { ids: [b.id], floors }, user))}>
              Apply
            </Button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="w-14 text-[12px] text-ink-3">Massing</span>
            <select value={typo} onChange={(e) => setTypo(e.target.value as Typology)} className="h-7 min-w-0 flex-1 rounded-[5px] border border-line-2 bg-paper px-1.5 text-[12px] outline-none">
              {TYPOLOGIES.map((t) => (
                <option key={t} value={t}>
                  {t.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <Button size="sm" onClick={() => applyOp(modifyBuildings(R.world, { ids: [b.id], massing: { typology: typo, keepGFA: true } }, user))} title="Regenerate the form on this footprint, holding floor area">
              Reshape
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Button size="sm" onClick={() => applyOp(modifyBuildings(R.world, { ids: [b.id], setbacks: { aboveFloor: Math.max(3, Math.round(b.floors * 0.4)), depth: 3 } }, user))}>
              <Layers3 size={13} /> Upper setbacks
            </Button>
            <Button size="sm" onClick={() => applyOp(modifyBuildings(R.world, { ids: [b.id], greenRoof: !b.greenRoof }, user))}>
              <Leaf size={13} /> {b.greenRoof ? "Remove green roof" : "Green roof"}
            </Button>
            <Button size="sm" tone="danger" onClick={() => applyOp(removeBuildings(R.world, [b.id], user))}>
              <Trash2 size={13} /> Demolish
            </Button>
          </div>
        </div>
        <div className="border-t border-line px-3 py-2 text-[10.5px] leading-snug text-ink-4">{b.source}</div>
      </div>
    </>
  );
}

const STRIP_LABEL: Record<StripType, string> = { sidewalk: "Sidewalk", planting: "Planting", parking: "Parking", bike: "Bike lane", cycletrack: "Cycle track", buffer: "Buffer", travel: "Travel", bus: "Bus", turn: "Turn", median: "Median", tram: "Tram", shoulder: "Shoulder", plaza: "Plaza" };
const rgb = (c: number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** sidewalk status on one side: the current section, with the City inventory's condition where measured */
function sidewalkLabel(s: Street, side: "left" | "right"): string {
  const m = s.sidewalks?.[side];
  const has = hasSidewalk(s.section, side);
  if (!has) return m ? (m.status === "shared" ? "none — planned shared street" : "none (City inventory)") : "none";
  if (!m || m.status === "absent" || m.status === "shared") return m ? "proposed" : "yes";
  return [m.status === "partial" ? `partial (${Math.round(m.coverage * 100)}%)` : "yes", m.grade && `grade ${m.grade}`, m.width && `${(m.width / 0.3048).toFixed(0)} ft`, m.deficient && m.deficient >= 0.25 && `${Math.round(m.deficient * 100)}% deficient`].filter(Boolean).join(" · ");
}

function StreetPanel({ s, onClose }: { s: Street; onClose: () => void }) {
  const R = rt();
  const [strips, setStrips] = useState<Strip[]>(() => s.section.strips.map((x) => ({ ...x })));
  const [sel, setSel] = useState<number | null>(null);
  const [scope, setScope] = useState<"segment" | "corridor">("segment");
  const [keepRow, setKeepRow] = useState(false);
  const corridor = useMemo(() => (s.name ? R.world.all("street").filter((x) => x.name === s.name) : [s]), [s, R.world]);
  // the street as drawn: its named corridor, or the segments drawn with it
  const sameStreet = useMemo(() => (s.name ? corridor : s.createdBy ? R.world.all("street").filter((x) => !x.name && x.createdBy === s.createdBy) : [s]), [s, corridor, R.world]);
  const ids = scope === "corridor" ? corridor.map((x) => x.id) : [s.id];
  const W = strips.reduce((a, x) => a + x.width, 0);
  const W0 = sectionWidth(s.section);
  const dirty = JSON.stringify(strips) !== JSON.stringify(s.section.strips);
  const apply = (edits: SectionEdit[]) => applyOp(editStreetSections(R.world, { streetIds: ids, edits, keepRowWidth: keepRow, policy: "trim" }, user));
  const setW = (i: number, w: number) => setStrips(strips.map((x, k) => (k === i ? { ...x, width: Math.max(0.5, Math.round(w * 10) / 10) } : x)));
  return (
    <>
      <Header icon={<Route size={15} />} kind={`${s.cls} street${s.oneway ? " · one-way" : ""}`} title={s.name ?? "Unnamed street"} onClose={onClose} onRename={rename(sameStreet.map((x) => x.id))} badge={s.createdBy ? <Provenance kind="proposed" /> : undefined} />
      <div className="scroll-thin overflow-y-auto">
        <div className="grid grid-cols-4 gap-2 px-3 pt-3">
          <Stat label="ROW" value={`${W0.toFixed(1)} m`} />
          <Stat label="Kerb–kerb" value={`${carriagewayWidth(s.section).toFixed(1)} m`} />
          <Stat label="Lanes" value={`${laneCount(s.section, 1)}${s.oneway ? "" : `+${laneCount(s.section, -1)}`}`} />
          <Stat label="Length" value={`${polyLength(s.path).toFixed(0)} m`} />
        </div>
        <div className="flex items-center justify-between px-3 pt-3">
          <span className="font-legend text-[12.5px] leading-none text-ink-3">Cross-section</span>
          <Provenance kind={s.sectionSource} />
        </div>
        {/* section diagram */}
        <div className="px-3 pt-2">
          <div className="flex h-12 w-full overflow-hidden rounded-[5px] ring-1 ring-line">
            {strips.map((x, i) => (
              <button
                key={i}
                onClick={() => setSel(sel === i ? null : i)}
                title={`${STRIP_LABEL[x.type]} ${x.width.toFixed(1)} m${x.dir ? (x.dir > 0 ? " →" : " ←") : ""}`}
                className={cx("relative flex items-end justify-center border-r border-white/50 pb-0.5 text-[9px] font-medium text-white/90 last:border-r-0", sel === i && "ring-2 ring-accent ring-inset")}
                style={{ width: `${(x.width / W) * 100}%`, background: rgb(MODEL.strip[x.type]) }}
              >
                {x.width / W > 0.07 && (x.type === "travel" || x.type === "bus" || x.type === "tram" ? (x.dir > 0 ? "→" : x.dir < 0 ? "←" : "") : "")}
              </button>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[10.5px] text-ink-4 tabular">
            <span>left</span>
            <span className={cx(Math.abs(W - W0) > 0.05 && "font-medium text-proposed")}>
              {W.toFixed(1)} m{Math.abs(W - W0) > 0.05 ? ` (${W - W0 > 0 ? "+" : ""}${(W - W0).toFixed(1)})` : ""}
            </span>
            <span>right</span>
          </div>
        </div>
        {s.sidewalks && (
          <div className="px-3 pt-2">
            {(["left", "right"] as const).map((side) => (
              <Row key={side} k={`Sidewalk ${side}`} v={sidewalkLabel(s, side)} prov={s.sidewalks?.[side] ? "measured" : undefined} />
            ))}
          </div>
        )}
        {sel !== null && strips[sel] && (
          <div className="mx-3 mt-2 flex items-center gap-1.5 rounded-[6px] bg-paper-2 p-2">
            <select value={strips[sel].type} onChange={(e) => setStrips(strips.map((x, k) => (k === sel ? { ...x, type: e.target.value as StripType, width: DEFAULT_WIDTH[e.target.value as StripType] } : x)))} className="h-7 min-w-0 flex-1 rounded-[5px] border border-line-2 bg-paper px-1 text-[12px]">
              {(Object.keys(STRIP_LABEL) as StripType[]).map((t) => (
                <option key={t} value={t}>
                  {STRIP_LABEL[t]}
                </option>
              ))}
            </select>
            <IconButton size="sm" onClick={() => setW(sel, strips[sel].width - 0.25)}>
              <Minus size={12} />
            </IconButton>
            <span className="tabular w-10 text-center text-[12px]">{strips[sel].width.toFixed(2)}</span>
            <IconButton size="sm" onClick={() => setW(sel, strips[sel].width + 0.25)}>
              <Plus size={12} />
            </IconButton>
            <IconButton size="sm" title="Reverse direction" onClick={() => setStrips(strips.map((x, k) => (k === sel ? { ...x, dir: (x.dir === 0 ? 0 : -x.dir) as 1 | -1 | 0 } : x)))}>
              <ArrowLeftRight size={12} />
            </IconButton>
            <IconButton
              size="sm"
              title="Remove strip"
              onClick={() => {
                setStrips(strips.filter((_, k) => k !== sel));
                setSel(null);
              }}
            >
              <Trash2 size={12} />
            </IconButton>
            <IconButton
              size="sm"
              title="Insert strip after"
              onClick={() => {
                const c = strips.slice();
                c.splice(sel + 1, 0, { type: "travel", width: 3.3, dir: strips[sel].dir || 1 });
                setStrips(c);
              }}
            >
              <Plus size={12} />
            </IconButton>
          </div>
        )}
        <div className="flex items-center justify-between gap-2 px-3 pt-2.5">
          <Segmented
            size="xs"
            value={scope}
            onChange={setScope}
            options={[
              { value: "segment", label: "This segment" },
              { value: "corridor", label: `Corridor (${corridor.length})` },
            ]}
          />
          <label className="flex items-center gap-1 text-[11px] text-ink-3">
            <input type="checkbox" checked={keepRow} onChange={(e) => setKeepRow(e.target.checked)} className="accent-accent" /> Hold ROW
          </label>
        </div>
        <div className="flex gap-1.5 px-3 pt-2">
          <Button size="sm" tone="primary" disabled={!dirty} onClick={() => apply([{ op: "replace", strips }])}>
            Apply section
          </Button>
          <Button size="sm" disabled={!dirty} onClick={() => setStrips(s.section.strips.map((x) => ({ ...x })))}>
            Reset
          </Button>
        </div>
        <div className="border-t border-line px-3 py-3 mt-3">
          <div className="mb-2 font-legend text-[12.5px] leading-none text-ink-3">Quick changes</div>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" onClick={() => apply([{ op: "add_lanes", count: 1 }])}>
              <Plus size={12} /> Lane each way
            </Button>
            <Button size="sm" onClick={() => apply([{ op: "remove_lanes", count: 1 }])}>
              <Minus size={12} /> Lane each way
            </Button>
            <Button size="sm" onClick={() => apply([{ op: "add_bike_lanes", kind: "track" }])}>
              <Bike size={12} /> Cycle tracks
            </Button>
            <Button size="sm" onClick={() => apply([{ op: "bus_lanes", on: true }])}>
              <BusFront size={12} /> Bus lanes
            </Button>
            <Button size="sm" onClick={() => apply([{ op: "set_oneway", oneway: !s.oneway }])}>
              <ArrowLeftRight size={12} /> {s.oneway ? "Two-way" : "One-way"}
            </Button>
            <Button size="sm" onClick={() => apply([s.closed ? { op: "reopen" } : { op: "pedestrianize" }])}>
              <Footprints size={12} /> {s.closed ? "Reopen" : "Pedestrianise"}
            </Button>
          </div>
          <Button size="sm" tone="danger" className="mt-2" onClick={() => applyOp(removeStreets(R.world, ids, { reclaim: "none" }, user)) && useApp.getState().setSelection([])}>
            <Trash2 size={13} /> {ids.length > 1 ? `Remove ${ids.length} segments` : "Remove segment"}
          </Button>
          <div className="mt-2.5 text-[10.5px] leading-snug text-ink-4">ROW {s.rowSource === "measured" ? "from ASMP (measured)" : "estimated from class defaults"} · {s.source}</div>
        </div>
      </div>
    </>
  );
}

function NodePanel({ n, onClose }: { n: StreetNode; onClose: () => void }) {
  const R = rt();
  const inc = R.world.incident(n.id);
  return (
    <>
      <Header icon={<CircleDot size={15} />} kind="Junction" title={entityName(n)} onClose={onClose} />
      <div className="p-3">
        <Row k="Approaches" v={inc.length} />
        <Row k="Control" v={n.plaza ? "pedestrian plaza" : n.control} />
        {n.roundabout && <Row k="Roundabout" v={`R ${n.roundabout.radius.toFixed(0)} m · ${n.roundabout.lanes} lane`} />}
        {n.ramps && <Row k="Curb ramps" v={`${n.ramps.ok} ok · ${n.ramps.poor} poor · ${n.ramps.absent} absent`} prov="measured" />}
        {n.evp && <Row k="Signal preemption" v="fitted (emergency vehicles)" prov="proposed" />}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {(["signal", "stop", "none"] as const).map((c) => (
            <Button key={c} size="sm" tone={n.control === c && !n.plaza ? "primary" : "default"} onClick={() => applyOp(setNodeControl(R.world, n.id, c, {}, user))}>
              {c === "none" ? "Uncontrolled" : c[0].toUpperCase() + c.slice(1)}
            </Button>
          ))}
          <Button size="sm" tone={n.control === "roundabout" ? "primary" : "default"} onClick={() => applyOp(setNodeControl(R.world, n.id, "roundabout", {}, user))}>
            Roundabout
          </Button>
          <Button size="sm" tone={n.plaza ? "primary" : "default"} onClick={() => applyOp(setNodeControl(R.world, n.id, "plaza", {}, user))}>
            Plaza
          </Button>
        </div>
        <div className="mt-3 space-y-0.5">
          {inc.map((s) => (
            <button key={s.id} onClick={() => useApp.getState().setSelection([s.id])} className="flex w-full justify-between rounded-[4px] px-1 py-0.5 text-left text-[11.5px] text-ink-2 hover:bg-paper-3">
              <span className="truncate">{s.name ?? s.cls}</span>
              <span className="tabular text-ink-4">
                {laneCount(s.section, 1)}+{laneCount(s.section, -1)} · {sectionWidth(s.section).toFixed(0)} m
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

const AREA_TYPES: AreaType[] = ["park", "plaza", "grass", "wood", "water", "retention", "raingarden", "permeable", "parking"];
function AreaPanel({ a, onClose }: { a: Area; onClose: () => void }) {
  const R = rt();
  return (
    <>
      <Header icon={<Combine size={15} />} kind={a.type} title={a.name ?? a.type} onClose={onClose} onRename={rename([a.id])} badge={<Provenance kind={a.provenance} />} />
      <div className="p-3">
        <Row k="Area" v={fmt.m2(polyArea(a.poly))} />
        {a.type === "parking" && <Row k="Spaces (est.)" v={`≈${fmt.int(polyArea(a.poly) / 30)}`} prov="estimated" />}
        <div className="mt-3 flex items-center gap-2">
          <span className="text-[12px] text-ink-3">Convert to</span>
          <select defaultValue="" onChange={(e) => e.target.value && applyOp(convertAreas(R.world, [a.id], e.target.value as AreaType, user))} className="h-7 flex-1 rounded-[5px] border border-line-2 bg-paper px-1 text-[12px]">
            <option value="" disabled>
              choose…
            </option>
            {AREA_TYPES.filter((t) => t !== a.type).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <Button size="sm" tone="danger" className="mt-3" onClick={() => applyOp(removeEntities(R.world, [a.id], user))}>
          <Trash2 size={13} /> Remove
        </Button>
        <div className="mt-3 text-[10.5px] text-ink-4">{a.source}</div>
      </div>
    </>
  );
}

function ParcelPanel({ p, onClose }: { p: Parcel; onClose: () => void }) {
  return (
    <>
      <Header icon={<Combine size={15} />} kind="Parcel" title={p.id} onClose={onClose} />
      <div className="p-3">
        <Row k="Zoning" v={p.zoning} prov="measured" />
        <Row k="Lot area" v={fmt.m2(p.area)} />
        <Row k="Land use" v={p.landUse} />
        <Row k="Max FAR" v={p.maxFar ?? "—"} />
        <Row k="Max height" v={p.maxHeight != null ? `${p.maxHeight.toFixed(0)} m` : "—"} />
        {p.cvcCeiling != null && <Row k="Capitol View Corridor" v={`${(p.cvcCeiling / 0.3048).toFixed(0)} ft ASL`} />}
        {p.historic && <Row k="Historic" v="yes" />}
        {p.value && <Row k="Appraised land" v={`$${fmt.int(p.value.land)} ($${fmt.int(p.value.land / Math.max(1, p.area))}/m²)`} prov="measured" />}
        {p.value && <Row k="Improvements" v={`$${fmt.int(p.value.improvements)}${p.value.improvements < 0.5 * p.value.land ? " · underused" : ""}`} prov="measured" />}
        <Row k="Owner" v={p.owner ?? (p.value ? "private" : "—")} prov={p.owner || p.value ? "measured" : undefined} />
        {p.etod && <Row k="ETOD overlay" v={`subdistrict ${p.etod.subdistrict} · up to ${(p.etod.maxHeight / 0.3048).toFixed(0)} ft with affordability bonus`} prov="measured" />}
      </div>
    </>
  );
}

function RoutePanel({ r, onClose }: { r: TransitRoute; onClose: () => void }) {
  const R = rt();
  return (
    <>
      <Header icon={<TramFront size={15} />} kind={`${r.mode === "brt" ? "rapid bus" : r.mode} line`} title={r.name || r.ref || "Transit line"} onClose={onClose} onRename={rename([r.id])} badge={<Provenance kind={r.provenance} />} />
      <div className="p-3">
        <Row k="Length" v={`${(polyLength(r.path) / 1000).toFixed(2)} km`} />
        <Row k="Stops" v={r.stops.length} />
        <Row k="Every" v={`${r.headway} min`} />
        <Row k="Streets" v={r.streets.length} />
        <Button size="sm" tone="danger" className="mt-3" onClick={() => applyOp(removeEntities(R.world, [r.id, ...r.stops.filter((s) => R.world.get(s))], user)) && useApp.getState().setSelection([])}>
          <Trash2 size={13} /> Remove line
        </Button>
        <div className="mt-3 text-[10.5px] text-ink-4">{r.source}</div>
      </div>
    </>
  );
}

function TreePanel({ t, onClose }: { t: Tree; onClose: () => void }) {
  const R = rt();
  const sp = speciesOf(t.species);
  return (
    <>
      <Header icon={<Leaf size={15} />} kind={sp ? sp.name : "Tree"} title={t.createdBy ? `Proposed ${sp ? sp.name.toLowerCase() : "tree"}` : "Mapped tree"} onClose={onClose} badge={<Provenance kind={t.provenance} />} />
      <div className="p-3">
        <Row k="Crown" v={`${(t.r * 2).toFixed(1)} m across`} />
        <Row k="Height" v={`${t.h.toFixed(0)} m`} />
        <Row k="Shade footprint" v={`${Math.round(Math.PI * t.r * t.r)} m²`} />
        {t.createdBy && (
          <>
            <label className="mt-2.5 flex items-center justify-between gap-2 text-[12px]">
              <span className="text-ink-3">Species</span>
              <select value={t.species ?? ""} onChange={(e) => applyOp(updateTree(R.world, t.id, { species: e.target.value }, user))} className="h-7 w-40 rounded-[5px] border border-line-2 bg-paper px-1 text-[12px]">
                {!t.species && <option value="">Generic</option>}
                {SPECIES.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-2 flex items-center gap-2 text-[12px] text-ink-3">
              Crown
              <input type="range" min={1.5} max={10} step={0.5} defaultValue={t.r} key={t.r} onPointerUp={(e) => applyOp(updateTree(R.world, t.id, { r: +(e.target as HTMLInputElement).value }, user))} className="h-1 min-w-0 flex-1" />
            </label>
          </>
        )}
        {sp && <p className="mt-2 text-[11px] leading-snug text-ink-3">{sp.note}. Shade and cooling are modelled at mature size.</p>}
        <Button size="sm" tone="danger" className="mt-3" onClick={() => applyOp(removeEntities(R.world, [t.id], user))}>
          <Trash2 size={13} /> Remove
        </Button>
      </div>
    </>
  );
}

function Multi({ ents, onClose }: { ents: Entity[]; onClose: () => void }) {
  const R = rt();
  const blds = ents.filter((e): e is Building => e.kind === "building");
  const counts: Record<string, number> = {};
  for (const e of ents) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  const gfa = blds.reduce((s, b) => s + programmeOf(b).gfa, 0);
  return (
    <>
      <Header icon={<MousePointer2 size={15} />} kind="Selection" title={Object.entries(counts).map(([k, v]) => `${v} ${k}${v > 1 ? "s" : ""}`).join(", ")} onClose={onClose} />
      <div className="p-3">
        {blds.length > 0 && <Row k="Total GFA" v={fmt.m2(gfa)} />}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {blds.length >= 2 && (
            <Button size="sm" onClick={() => applyOp(mergeBuildings(R.world, blds.map((b) => b.id), {}, user))}>
              <Combine size={13} /> Merge into one development
            </Button>
          )}
          {blds.length > 0 && (
            <Button size="sm" onClick={() => applyOp(modifyBuildings(R.world, { ids: blds.map((b) => b.id), setbacks: { aboveFloor: 4, depth: 3 } }, user))}>
              <Layers3 size={13} /> Upper setbacks
            </Button>
          )}
          {blds.length > 0 && (
            <Button size="sm" tone="danger" onClick={() => applyOp(removeBuildings(R.world, blds.map((b) => b.id), user))}>
              <Trash2 size={13} /> Demolish
            </Button>
          )}
        </div>
        <div className="mt-3 max-h-40 space-y-0.5 overflow-y-auto">
          {ents.map((e) => (
            <button key={e.id} onClick={() => useApp.getState().setSelection([e.id])} className="block w-full truncate rounded-[4px] px-1 py-0.5 text-left text-[11.5px] text-ink-2 hover:bg-paper-3">
              {entityName(e)}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
