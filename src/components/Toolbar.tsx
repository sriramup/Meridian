"use client";

import { Building2, LibraryBig, LayoutGrid, MousePointer2, Ruler, Spline, Square, TramFront, TreeDeciduous } from "lucide-react";
import { Fragment, useEffect, type ReactNode } from "react";
import { TYPOLOGIES } from "@/geometry/massing";
import { MODEL } from "@/render/theme";
import { createDrawn, paletteStreetWidth } from "@/state/create";
import { draw, resetDraw } from "@/state/drawing";
import { useApp, type Palette, type Tool } from "@/state/store";
import { SPECIES } from "@/world/species";
import type { Vec2 } from "@/world/types";
import { LibraryPanel } from "./library/LibraryPanel";
import { NumberField, Segmented, SelectField, Slider, Switch } from "@/components/ui/kit";
import { Button, IconButton, Tip, cx } from "./ui";

const TOOLS: { id: Tool; icon: typeof Building2; label: string; key: string; group: number }[] = [
  { id: "select", icon: MousePointer2, label: "Select", key: "V", group: 0 },
  { id: "library", icon: LibraryBig, label: "Library: buildings, homes, trees, furniture… (B buildings, T trees)", key: "L", group: 0 },
  { id: "street", icon: Spline, label: "Street", key: "S", group: 1 },
  { id: "area", icon: Square, label: "Park, plaza or water", key: "A", group: 1 },
  { id: "district", icon: LayoutGrid, label: "District", key: "D", group: 2 },
  { id: "transit", icon: TramFront, label: "Transit line", key: "R", group: 2 },
  { id: "measure", icon: Ruler, label: "Measure", key: "M", group: 3 },
];

export function Toolbar() {
  const tool = useApp((s) => s.tool);
  const setTool = useApp((s) => s.setTool);
  useApp((s) => s.toolVersion);
  return (
    <div className="pointer-events-auto flex items-start gap-2">
      <div className="flex flex-col gap-0.5 chrome p-1">
        {TOOLS.map((x, i) => {
          const Icon = x.icon;
          return (
            <Fragment key={x.id}>
            {i > 0 && TOOLS[i - 1].group !== x.group && <span className="mx-1.5 my-1 h-px bg-line" />}
            <Tip label={x.label} kbd={x.key} side="right">
              <IconButton
                aria-label={x.label}
                active={tool === x.id || (x.id === "library" && (tool === "building" || tool === "tree"))}
                onClick={() => {
                  resetDraw();
                  setTool(x.id);
                }}
              >
                <Icon size={16} strokeWidth={1.7} />
              </IconButton>
            </Tip>
            </Fragment>
          );
        })}
      </div>
      {draw.pending ? <ConfirmCard /> : tool === "library" ? <LibraryPanel /> : tool === "tree" ? <PlantingPalette /> : tool === "street" ? <StreetPalette /> : tool === "building" ? <BuildingPalette /> : tool === "area" ? <AreaPalette /> : tool === "district" ? <DistrictPalette /> : tool === "transit" ? <TransitPalette /> : null}
    </div>
  );
}

function PlantingPalette() {
  const pl = useApp((s) => s.planting);
  const set = useApp((s) => s.setPlanting);
  const sp = SPECIES.find((x) => x.id === pl.species);
  return (
    <Panel
      title="Plant trees"
      hint={`${pl.mode === "single" ? "Click to plant one tree." : "Click along a sidewalk, then Enter: trees go a crown apart."} A tree needs room for its leaves (${sp ? `${(sp.r * 2).toFixed(0)} m across` : "its crown"}): red means they'd hit a building or another tree.`}
    >
      <div className="grid grid-cols-2 gap-1">
        {SPECIES.map((x) => (
          <Choice key={x.id} on={x.id === pl.species} onClick={() => set({ species: x.id })} title={x.note}>
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="block shrink-0 rounded-full" style={{ width: 4 + x.r * 1.6, height: 4 + x.r * 1.6, background: `rgb(${x.color.join(",")})` }} />
              <span className="font-medium">{x.name}</span>
            </span>
          </Choice>
        ))}
      </div>
      <Field label="Place">
        <Segmented
          size="xs"
          value={pl.mode}
          onChange={(mode) => {
            resetDraw();
            set({ mode });
          }}
          options={[
            { value: "single", label: "One at a time", title: "One tree per click" },
            { value: "row", label: "Along a line", title: "Click along a sidewalk, Enter to plant" },
          ]}
        />
      </Field>
    </Panel>
  );
}

/** a palette: title, the element's options, and how to draw it */
function Panel({ title, children, hint }: { title: string; children: ReactNode; hint: string }) {
  return (
    <div className="chrome w-[272px] p-3">
      <div className="font-display text-[17px] leading-none font-semibold text-ink">{title}</div>
      <div className="mt-2.5 space-y-2.5">{children}</div>
      <p className="mt-3 border-t border-line pt-2 text-[11px] leading-snug text-ink-4">{hint}</p>
    </div>
  );
}

function Choice({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button onClick={onClick} title={title} className={cx("flex min-w-0 flex-col items-start rounded-[6px] border px-2 py-1.5 text-left text-[11.5px] leading-tight transition-colors", on ? "border-accent/70 bg-accent-2 text-ink" : "border-line text-ink-3 hover:border-line-2 hover:text-ink")}>
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[12px]">
      <span className="text-ink-3">{label}</span>
      {children}
    </div>
  );
}

const STREETS: { cls: Palette["street"]["cls"]; name: string; note: string }[] = [
  { cls: "residential", name: "Local street", note: "2 lanes, parking" },
  { cls: "tertiary", name: "Collector", note: "2 lanes" },
  { cls: "secondary", name: "Avenue", note: "4 lanes" },
  { cls: "primary", name: "Boulevard", note: "4–6 lanes" },
  { cls: "living", name: "Living street", note: "shared, 10 km/h" },
  { cls: "pedestrian", name: "Pedestrian", note: "no traffic" },
];

function StreetPalette() {
  const p = useApp((s) => s.palette.street);
  const set = useApp((s) => s.setPalette);
  return (
    <Panel title="Street" hint={`≈ ${paletteStreetWidth(p).toFixed(0)} m right-of-way. Click to place points, then click the last point or press Enter. Crossings become junctions.`}>
      <div className="grid grid-cols-2 gap-1">
        {STREETS.map((x) => (
          <Choice key={x.cls} on={p.cls === x.cls} onClick={() => set("street", { cls: x.cls })}>
            <span className="font-medium">{x.name}</span>
            <span className="text-[10.5px] text-ink-4">{x.note}</span>
          </Choice>
        ))}
      </div>
      {p.cls !== "pedestrian" && p.cls !== "living" && (
        <Field label="Bike lanes">
          <Segmented
            size="xs"
            value={p.bike}
            onChange={(bike) => set("street", { bike })}
            options={[
              { value: "none", label: "None" },
              { value: "lane", label: "Painted" },
              { value: "track", label: "Protected" },
            ]}
          />
        </Field>
      )}
      <Field label="Street trees">
        <Switch size="sm" checked={p.trees} onCheckedChange={(trees) => set("street", { trees })} aria-label="Street trees" />
      </Field>
    </Panel>
  );
}

const USES: { use: Palette["building"]["use"]; name: string }[] = [
  { use: "mixed", name: "Mixed use" },
  { use: "residential", name: "Homes" },
  { use: "office", name: "Offices" },
  { use: "retail", name: "Shops" },
  { use: "hotel", name: "Hotel" },
  { use: "education", name: "School" },
  { use: "health", name: "Clinic" },
  { use: "civic", name: "Civic" },
  { use: "fire_station", name: "Fire station" },
];

function BuildingPalette() {
  const p = useApp((s) => s.palette.building);
  const set = useApp((s) => s.setPalette);
  return (
    <Panel title="Building" hint="Outline the footprint; click the first corner to finish. Floors, form and roof can be changed afterwards.">
      <div className="grid grid-cols-3 gap-1">
        {USES.map((x) => (
          <Choice key={x.use} on={p.use === x.use} onClick={() => set("building", { use: x.use, ...(x.use === "fire_station" ? { floors: 2, typology: "block" } : {}) })}>
            {x.name}
          </Choice>
        ))}
      </div>
      <Field label="Form">
        <SelectField value={p.typology} onValueChange={(typology) => set("building", { typology })} options={TYPOLOGIES.map((t) => ({ value: t, label: t.replace(/_/g, " ") }))} aria-label="Form" className="w-36" />
      </Field>
      <Field label="Floors">
        <Slider size="sm" min={1} max={60} step={1} value={[p.floors]} onValueChange={([floors]) => set("building", { floors })} thumbLabels={["Floors"]} className="min-w-0 flex-1" />
        <span className="tabular w-6 text-right text-ink">{p.floors}</span>
      </Field>
    </Panel>
  );
}

const AREAS: { type: Palette["area"]["type"]; name: string }[] = [
  { type: "park", name: "Park" },
  { type: "plaza", name: "Plaza" },
  { type: "water", name: "Water" },
  { type: "wood", name: "Woodland" },
  { type: "grass", name: "Lawn" },
  { type: "raingarden", name: "Rain garden" },
  { type: "permeable", name: "Permeable paving" },
  { type: "retention", name: "Retention pond" },
  { type: "parking", name: "Parking lot" },
];

function AreaPalette() {
  const p = useApp((s) => s.palette.area);
  const set = useApp((s) => s.setPalette);
  return (
    <Panel title="Open space & surfaces" hint="Outline the area; click the first corner to finish. Parks get shade trees; street right-of-way is left out.">
      <div className="grid grid-cols-3 gap-1">
        {AREAS.map((x) => (
          <Choice key={x.type} on={p.type === x.type} onClick={() => set("area", { type: x.type })}>
            <span className="mb-1 block h-2.5 w-full rounded-[2px]" style={{ background: `rgb(${(MODEL.area[x.type] ?? [200, 200, 200]).join(",")})` }} />
            {x.name}
          </Choice>
        ))}
      </div>
    </Panel>
  );
}

const STYLES: { style: Palette["district"]["style"]; name: string; note: string }[] = [
  { style: "european", name: "European", note: "courtyard blocks" },
  { style: "grid", name: "Grid", note: "regular blocks" },
  { style: "midrise", name: "Mid-rise", note: "5–8 floors" },
  { style: "towers", name: "Towers", note: "on podiums" },
  { style: "tod", name: "Transit-oriented", note: "tall at the centre" },
  { style: "civic", name: "Civic centre", note: "around a square" },
  { style: "infill", name: "Infill", note: "rowhouses" },
];

function DistrictPalette() {
  const p = useApp((s) => s.palette.district);
  const set = useApp((s) => s.setPalette);
  return (
    <Panel title="District" hint="Outline an area; streets, blocks, open space and buildings are generated to the target. Buildings already inside are kept.">
      <div className="grid grid-cols-2 gap-1">
        {STYLES.map((x) => (
          <Choice key={x.style} on={p.style === x.style} onClick={() => set("district", { style: x.style })}>
            <span className="font-medium">{x.name}</span>
            <span className="text-[10.5px] text-ink-4">{x.note}</span>
          </Choice>
        ))}
      </div>
      <Field label="Homes">
        <div className="w-28">
          <NumberField value={p.homes} onChange={(homes) => set("district", { homes })} min={0} max={100000} step={100} format={(v) => (v ? v.toLocaleString("en-US") : "by style")} aria-label="Homes" />
        </div>
      </Field>
      <Field label="Max floors">
        <Slider size="sm" min={2} max={40} step={1} value={[p.maxFloors]} onValueChange={([maxFloors]) => set("district", { maxFloors })} thumbLabels={["Max floors"]} className="min-w-0 flex-1" />
        <span className="tabular w-6 text-right text-ink">{p.maxFloors}</span>
      </Field>
      <Field label="Local streets through big blocks">
        <Switch size="sm" checked={p.newStreets} onCheckedChange={(newStreets) => set("district", { newStreets })} aria-label="Add local streets through big blocks" />
      </Field>
    </Panel>
  );
}

function TransitPalette() {
  const p = useApp((s) => s.palette.transit);
  const set = useApp((s) => s.setPalette);
  return (
    <Panel title="Transit line" hint="Click along existing streets from one end to the other, then click the last point or press Enter. The line follows the streets; stops are spaced 350–550 m. Rapid bus and tram get their own lanes.">
      <Segmented
        size="xs"
        value={p.mode}
        onChange={(mode) => set("transit", { mode })}
        options={[
          { value: "bus", label: "Bus" },
          { value: "brt", label: "Rapid bus" },
          { value: "tram", label: "Tram" },
        ]}
      />
      <Field label="Every">
        <SelectField value={String(p.headway)} onValueChange={(h) => set("transit", { headway: +h })} options={[5, 7.5, 10, 15, 20, 30].map((h) => ({ value: String(h), label: `${h} min` }))} aria-label="Headway" className="w-24" />
      </Field>
    </Panel>
  );
}

/** a finished shape that runs into something: say what would happen, then do it or drop it */
function ConfirmCard() {
  const p = draw.pending!;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && resetDraw();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const go = () => {
    const ok = createDrawn(p.tool, p.points as Vec2[], { replace: p.tool === "building" });
    if (ok) resetDraw();
  };
  return (
    <div className="chrome w-[272px] p-3">
      <div className="text-[12.5px] font-semibold text-ink">{p.tool === "street" ? "New street" : p.tool === "building" ? "New building" : "New area"}</div>
      <div className="mt-2 rounded-[5px] bg-bad-2 px-2 py-1.5 text-[11.5px] leading-snug text-bad">{p.conflict}</div>
      <div className="mt-3 flex justify-end gap-1.5">
        <Button size="sm" tone="ghost" onClick={resetDraw}>
          Cancel
        </Button>
        <Button size="sm" tone="primary" onClick={go}>
          {p.tool === "building" ? "Replace them" : p.tool === "area" ? "Create around them" : "Build it"}
        </Button>
      </div>
    </div>
  );
}
