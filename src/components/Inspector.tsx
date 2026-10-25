"use client";

import { AlertTriangle, Building2, ChevronDown, CircleDot, Combine, Layers3, Leaf, Minus, Plus, Route, Trash2, X, Bike, BusFront, Footprints, ArrowLeftRight, MousePointer2, TramFront } from "lucide-react";
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
import { M_PER_FT, fmtArea, fmtFt, fmtLen, fmtNum, fmtSqFt, toSqFt } from "@/lib/units";
import { removeEntities, convertAreas, renameEntities, updateTree } from "@/world/ops/landscape";
import { SPECIES, speciesOf } from "@/world/species";
import { editStreetSections, removeStreets, setNodeControl } from "@/world/ops/streets";
import type { SectionEdit } from "@/world/ops/sectionEdit";
import { checkBuilding } from "@/world/ops/validate";
import type { Area, AreaType, Building, Entity, Parcel, Street, StreetNode, Strip, StripType, TransitRoute, Tree } from "@/world/types";
import { NumberField, Segmented, SelectField, Slider, Switch } from "@/components/ui/kit";
import { Button, IconButton, Provenance, ProvenanceDot, Stat, cx } from "./ui";
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
    <div className="panel-in-right pointer-events-auto flex max-h-full w-[320px] flex-col overflow-hidden chrome">
      {ents.length === 1 ? (
        <Single key={ents[0].id} e={ents[0]} onClose={close} />
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
    <div className="flex items-center gap-3 border-b border-line px-4 py-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-[8px] border border-line bg-paper-2 text-ink-2">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-legend text-[11px] leading-4 text-ink-4 first-letter:uppercase">{kind}</span>
          {badge}
        </div>
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
            className="font-display -ml-1 h-6 w-full rounded-[5px] border border-line-2 bg-field px-1 text-[15px] leading-tight font-semibold text-ink outline-none focus:border-rose/60"
          />
        ) : (
          <div
            className={cx("font-display -ml-1 truncate rounded-[5px] px-1 text-[15px] leading-6 font-semibold text-ink", onRename && "cursor-text hover:bg-paper-3")}
            title={onRename ? "Click to rename" : undefined}
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
      <IconButton size="sm" onClick={onClose} aria-label="Close" className="-mr-1.5 self-start">
        <X size={14} />
      </IconButton>
    </div>
  );
}

/** headline figures in a ruled grid; a trailing unit ("73 ft") is set smaller */
function Stats({ items, cols = 3 }: { items: { label: string; value: React.ReactNode }[]; cols?: number }) {
  return (
    <div className="mx-4 mt-3.5 grid gap-px overflow-hidden rounded-[8px] border border-line bg-line" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {items.map((x) => {
        const m = typeof x.value === "string" ? /^([−+\-]?[\d.,]+k?)\s+(.+)$/.exec(x.value) : null;
        return (
          <div key={x.label} className="min-w-0 bg-paper-2 px-2.5 py-2">
            <div className="truncate text-[10.5px] leading-4 text-ink-4">{x.label}</div>
            <div className="tabular mt-0.5 truncate text-[14px] leading-5 font-semibold text-ink">
              {m ? (
                <>
                  {m[1]}
                  <span className="ml-0.5 text-[11px] font-medium text-ink-3">{m[2]}</span>
                </>
              ) : (
                x.value
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** a titled block of the panel, ruled off from the one above */
function Section({ title, right, children, className }: { title?: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cx("border-t border-line px-4 py-3", className)}>
      {(title || right) && (
        <div className="mb-2 flex items-center justify-between gap-2">
          {title && <span className="font-legend text-[11px] leading-4 font-medium text-ink-3">{title}</span>}
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

/** checks that failed, folded to a count when there are several */
function Issues({ issues }: { issues: { message: string; severity: string }[] }) {
  const [open, setOpen] = useState(issues.length <= 1);
  if (!issues.length) return null;
  const errors = issues.some((i) => i.severity === "error");
  return (
    <div className={cx("mx-4 mt-3 overflow-hidden rounded-[8px] border", errors ? "border-bad/30 bg-bad-2/50" : "border-warn/30 bg-warn-2/50")}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-2.5 py-2 text-left">
        <AlertTriangle size={13} className={errors ? "text-bad" : "text-warn"} />
        <span className={cx("flex-1 text-[11.5px] font-medium", errors ? "text-bad" : "text-warn")}>
          {issues.length} {issues.length === 1 ? "issue" : "issues"} to resolve
        </span>
        <ChevronDown size={13} className={cx("text-ink-4 transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open && (
        <ul className="space-y-1.5 px-2.5 pb-2.5 pl-[30px]">
          {issues.map((i, k) => (
            <li key={k} className="list-disc text-[11.5px] leading-snug text-ink-2 marker:text-ink-4">
              {i.message}
            </li>
          ))}
        </ul>
      )}
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

function Row({ k, v, prov, hint }: { k: string; v: React.ReactNode; prov?: string; hint?: React.ReactNode }) {
  return (
    <div className="border-b border-line/70 py-[7px] last:border-b-0">
      <div className="flex items-center justify-between gap-4 text-[12px] leading-4">
        <span className="shrink-0 text-ink-3">{k}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-right text-ink">
          <span className="tabular truncate">{v}</span>
          {prov && <ProvenanceDot kind={prov} />}
        </span>
      </div>
      {hint && <div className="mt-1 text-right text-[10.5px] leading-snug text-ink-4">{hint}</div>}
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
      <Header icon={<Building2 size={15} />} kind={`${b.use} building`} title={b.name ?? b.address ?? "Unnamed building"} onClose={onClose} onRename={rename([b.id])} badge={b.createdBy ? <Provenance kind="proposed" /> : b.historic ? <span className="inline-flex h-[17px] items-center rounded-full bg-paper-3 px-1.5 text-[10px] font-medium text-ink-2">Historic</span> : undefined} />
      <div className="scroll-thin overflow-y-auto">
        <Stats
          items={[
            { label: "Height", value: fmtFt(b.height, 0) },
            { label: "Floors", value: String(b.floors) },
            { label: "Floor area", value: `${fmtNum(toSqFt(p.gfa) / 1000, toSqFt(p.gfa) >= 1e5 ? 0 : 1)}k sq ft` },
            { label: "Homes", value: p.units >= 1 ? fmt.int(p.units) : "—" },
            { label: "Residents", value: p.residents >= 1 ? fmt.int(p.residents) : "—" },
            { label: "Jobs", value: p.jobs >= 1 ? fmt.int(p.jobs) : "—" },
          ]}
        />
        <Issues issues={issues} />
        <Section title="Details" className="mt-3.5">
          <Row k="Height source" v={b.heightSource === "measured" ? "LiDAR 2023" : b.heightSource} prov={b.heightSource} />
          <Row k="Use" v={Object.entries(b.program).map(([u, s]) => `${u} ${Math.round((s ?? 0) * 100)}%`).join(", ")} prov={b.useSource} />
          {b.existing && <Row k="Occupancy" v="Census / LODES" prov="estimated" />}
          <Row k="Footprint" v={fmtSqFt(polyArea(b.footprint))} />
          <Row k="Volumes" v={b.masses.map((m) => m.role).filter((r, i, a) => a.indexOf(r) === i).join(" · ")} />
          {par && <Row k="Zoning" v={par.zoning} />}
          <Row k="Height limit" v={hl.limit != null ? fmtFt(hl.limit, 0) : "None (FAR-governed)"} hint={hl.source.length > 0 ? hl.source[hl.source.length - 1] : undefined} />
        </Section>
        <Section title="Edit">
          <div className="grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2">
            <span className="text-[12px] text-ink-3">Floors</span>
            <NumberField value={floors} onChange={setFloors} min={1} max={150} step={1} unit="floors" aria-label="Floors" />
            <Button size="sm" className="w-[76px] justify-center" disabled={floors === b.floors} onClick={() => applyOp(modifyBuildings(R.world, { ids: [b.id], floors }, user))}>
              Apply
            </Button>
            <span className="text-[12px] text-ink-3">Massing</span>
            <SelectField value={typo} onValueChange={(v) => setTypo(v as Typology)} options={TYPOLOGIES.map((t) => ({ value: t, label: (t.charAt(0).toUpperCase() + t.slice(1)).replace(/_/g, " ") }))} aria-label="Massing" className="min-w-0" />
            <Button size="sm" className="w-[76px] justify-center" onClick={() => applyOp(modifyBuildings(R.world, { ids: [b.id], massing: { typology: typo, keepGFA: true } }, user))} title="Regenerate the form on this footprint, holding floor area">
              Reshape
            </Button>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button size="sm" className="justify-center" onClick={() => applyOp(modifyBuildings(R.world, { ids: [b.id], setbacks: { aboveFloor: Math.max(3, Math.round(b.floors * 0.4)), depth: 3 } }, user))}>
              <Layers3 size={13} /> Upper setbacks
            </Button>
            <Button size="sm" className="justify-center" active={!!b.greenRoof} onClick={() => applyOp(modifyBuildings(R.world, { ids: [b.id], greenRoof: !b.greenRoof }, user))}>
              <Leaf size={13} /> Green roof
            </Button>
          </div>
          <Button size="sm" tone="ghost" className="mt-2 w-full justify-center text-bad hover:bg-bad-2 hover:text-bad" onClick={() => applyOp(removeBuildings(R.world, [b.id], user))}>
            <Trash2 size={13} /> Demolish building
          </Button>
        </Section>
        <div className="border-t border-line px-4 py-2.5 text-[10.5px] leading-snug text-ink-4">{b.source}</div>
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
  // widths step in half feet (stored in metres)
  const setW = (i: number, w: number) => setStrips(strips.map((x, k) => (k === i ? { ...x, width: Math.max(M_PER_FT * 1.5, (Math.round((w / M_PER_FT) * 2) / 2) * M_PER_FT) } : x)));
  return (
    <>
      <Header icon={<Route size={15} />} kind={`${s.cls} street${s.oneway ? " · one-way" : ""}`} title={s.name ?? "Unnamed street"} onClose={onClose} onRename={rename(sameStreet.map((x) => x.id))} badge={s.createdBy ? <Provenance kind="proposed" /> : undefined} />
      <div className="scroll-thin overflow-y-auto">
        <Stats
          cols={4}
          items={[
            { label: "ROW", value: fmtFt(W0, 0) },
            { label: "Curb–curb", value: fmtFt(carriagewayWidth(s.section), 0) },
            { label: "Lanes", value: `${laneCount(s.section, 1)}${s.oneway ? "" : `+${laneCount(s.section, -1)}`}` },
            { label: "Length", value: fmtLen(polyLength(s.path)) },
          ]}
        />
        <div className="flex items-center justify-between px-4 pt-4">
          <span className="font-legend text-[11px] leading-4 font-medium text-ink-3">Cross-section</span>
          <Provenance kind={s.sectionSource} />
        </div>
        {/* section diagram */}
        <div className="px-4 pt-2">
          <div className="flex h-12 w-full overflow-hidden rounded-[5px] ring-1 ring-line">
            {strips.map((x, i) => (
              <button
                key={i}
                onClick={() => setSel(sel === i ? null : i)}
                title={`${STRIP_LABEL[x.type]} ${fmtFt(x.width)}${x.dir ? (x.dir > 0 ? " →" : " ←") : ""}`}
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
              {fmtFt(W)}{Math.abs(W - W0) > 0.05 ? ` (${W - W0 > 0 ? "+" : "−"}${fmtFt(Math.abs(W - W0))})` : ""}
            </span>
            <span>right</span>
          </div>
        </div>
        {s.sidewalks && (
          <div className="px-4 pt-2">
            {(["left", "right"] as const).map((side) => (
              <Row key={side} k={`Sidewalk ${side}`} v={sidewalkLabel(s, side)} prov={s.sidewalks?.[side] ? "measured" : undefined} />
            ))}
          </div>
        )}
        {sel !== null && strips[sel] && (
          <div className="mx-4 mt-2 flex items-center gap-1.5 rounded-[8px] border border-line bg-paper-2 p-1.5">
            <SelectField value={strips[sel].type} onValueChange={(v) => setStrips(strips.map((x, k) => (k === sel ? { ...x, type: v as StripType, width: DEFAULT_WIDTH[v as StripType] } : x)))} options={(Object.keys(STRIP_LABEL) as StripType[]).map((t) => ({ value: t, label: STRIP_LABEL[t] }))} aria-label="Strip type" className="min-w-0 flex-1" />
            <IconButton size="sm" onClick={() => setW(sel, strips[sel].width - M_PER_FT / 2)}>
              <Minus size={12} />
            </IconButton>
            <span className="tabular w-12 text-center text-[12px]">{fmtFt(strips[sel].width)}</span>
            <IconButton size="sm" onClick={() => setW(sel, strips[sel].width + M_PER_FT / 2)}>
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
        <div className="flex items-center justify-between gap-2 px-4 pt-3">
          <Segmented
            size="xs"
            value={scope}
            onChange={setScope}
            options={[
              { value: "segment", label: "This segment" },
              { value: "corridor", label: `Corridor (${corridor.length})` },
            ]}
          />
          <label className="flex items-center gap-1.5 text-[11px] text-ink-3">
            <Switch size="sm" checked={keepRow} onCheckedChange={setKeepRow} aria-label="Hold right-of-way" /> Hold ROW
          </label>
        </div>
        <div className="flex gap-1.5 px-4 pt-2">
          <Button size="sm" tone="primary" disabled={!dirty} onClick={() => apply([{ op: "replace", strips }])}>
            Apply section
          </Button>
          <Button size="sm" disabled={!dirty} onClick={() => setStrips(s.section.strips.map((x) => ({ ...x })))}>
            Reset
          </Button>
        </div>
        <div className="mt-3.5 border-t border-line px-4 py-3">
          <div className="mb-2 font-legend text-[11px] leading-4 font-medium text-ink-3">Quick changes</div>
          <div className="grid grid-cols-2 gap-1.5 [&>button]:justify-start">
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
          <Button size="sm" tone="ghost" className="mt-2 w-full justify-center text-bad hover:bg-bad-2 hover:text-bad" onClick={() => applyOp(removeStreets(R.world, ids, { reclaim: "none" }, user)) && useApp.getState().setSelection([])}>
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
      <div className="px-4 py-3">
        <Row k="Approaches" v={inc.length} />
        <Row k="Control" v={n.plaza ? "pedestrian plaza" : n.control} />
        {n.roundabout && <Row k="Roundabout" v={`radius ${fmtFt(n.roundabout.radius, 0)} · ${n.roundabout.lanes} lane`} />}
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
                {laneCount(s.section, 1)}+{laneCount(s.section, -1)} · {fmtFt(sectionWidth(s.section), 0)}
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
      <div className="px-4 py-3">
        <Row k="Area" v={fmtArea(polyArea(a.poly))} />
        {a.type === "parking" && <Row k="Spaces (est.)" v={`≈${fmt.int(polyArea(a.poly) / 30)}`} prov="estimated" />}
        <div className="mt-3 flex items-center gap-2">
          <span className="text-[12px] text-ink-3">Convert to</span>
          <SelectField value={undefined} placeholder="choose…" onValueChange={(v) => applyOp(convertAreas(R.world, [a.id], v as AreaType, user))} options={AREA_TYPES.filter((t) => t !== a.type).map((t) => ({ value: t, label: t }))} aria-label="Convert to" className="flex-1" />
        </div>
        <Button size="sm" tone="ghost" className="mt-3 w-full justify-center text-bad hover:bg-bad-2 hover:text-bad" onClick={() => applyOp(removeEntities(R.world, [a.id], user))}>
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
      <div className="px-4 py-3">
        <Row k="Zoning" v={p.zoning} prov="measured" />
        <Row k="Lot area" v={fmtArea(p.area)} />
        <Row k="Land use" v={p.landUse} />
        <Row k="Max FAR" v={p.maxFar ?? "—"} />
        <Row k="Max height" v={p.maxHeight != null ? fmtFt(p.maxHeight, 0) : "—"} />
        {p.cvcCeiling != null && <Row k="Capitol View Corridor" v={`${(p.cvcCeiling / 0.3048).toFixed(0)} ft ASL`} />}
        {p.historic && <Row k="Historic" v="yes" />}
        {p.value && <Row k="Appraised land" v={`$${fmt.int(p.value.land)} ($${fmt.int(p.value.land / Math.max(1, toSqFt(p.area)))}/sq ft)`} prov="measured" />}
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
      <div className="px-4 py-3">
        <Row k="Length" v={fmtLen(polyLength(r.path))} />
        <Row k="Stops" v={r.stops.length} />
        <Row k="Every" v={`${r.headway} min`} />
        <Row k="Streets" v={r.streets.length} />
        <Button size="sm" tone="ghost" className="mt-3 w-full justify-center text-bad hover:bg-bad-2 hover:text-bad" onClick={() => applyOp(removeEntities(R.world, [r.id, ...r.stops.filter((s) => R.world.get(s))], user)) && useApp.getState().setSelection([])}>
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
      <div className="px-4 py-3">
        <Row k="Crown" v={`${fmtFt(t.r * 2, 0)} across`} />
        <Row k="Height" v={fmtFt(t.h, 0)} />
        <Row k="Shade footprint" v={fmtSqFt(Math.PI * t.r * t.r)} />
        {t.createdBy && (
          <>
            <label className="mt-2.5 flex items-center justify-between gap-2 text-[12px]">
              <span className="text-ink-3">Species</span>
              <SelectField value={t.species} placeholder="Generic" onValueChange={(v) => applyOp(updateTree(R.world, t.id, { species: v }, user))} options={SPECIES.map((x) => ({ value: x.id, label: x.name }))} aria-label="Species" className="w-40" />
            </label>
            <label className="mt-2 flex items-center gap-2 text-[12px] text-ink-3">
              Crown
              <Slider size="sm" min={1.5} max={10} step={0.5} defaultValue={[t.r]} key={t.r} onValueCommit={([r]) => applyOp(updateTree(R.world, t.id, { r }, user))} thumbLabels={["Crown radius"]} className="min-w-0 flex-1" />
            </label>
          </>
        )}
        {sp && <p className="mt-2 text-[11px] leading-snug text-ink-3">{sp.note}. Shade and cooling are modelled at mature size.</p>}
        <Button size="sm" tone="ghost" className="mt-3 w-full justify-center text-bad hover:bg-bad-2 hover:text-bad" onClick={() => applyOp(removeEntities(R.world, [t.id], user))}>
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
      <div className="px-4 py-3">
        {blds.length > 0 && <Row k="Total floor area" v={fmt.m2(gfa)} />}
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
