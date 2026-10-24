"use client";

import { Building2, LayoutGrid, LoaderCircle, MousePointer2, Ruler, Spline, Square, TramFront, TreeDeciduous } from "lucide-react";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { TYPOLOGIES } from "@/geometry/massing";
import { MODEL } from "@/render/theme";
import { createDrawn, paletteStreetWidth } from "@/state/create";
import { draw, resetDraw } from "@/state/drawing";
import { useApp, type Palette, type Tool } from "@/state/store";
import { SPECIES } from "@/world/species";
import { viewBounds } from "@/agent/resolve";
import type { Vec2 } from "@/world/types";
import { Button, IconButton, Segmented, Tip, cx } from "./ui";

const TOOLS: { id: Tool; icon: typeof Building2; label: string; key: string; group: number }[] = [
  { id: "select", icon: MousePointer2, label: "Select", key: "V", group: 0 },
  { id: "street", icon: Spline, label: "Street", key: "S", group: 1 },
  { id: "building", icon: Building2, label: "Building", key: "B", group: 1 },
  { id: "area", icon: Square, label: "Park, plaza or water", key: "A", group: 1 },
  { id: "tree", icon: TreeDeciduous, label: "Trees", key: "T", group: 1 },
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
                active={tool === x.id}
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
      {draw.pending ? <ConfirmCard /> : tool === "tree" ? <PlantingPalette /> : tool === "street" ? <StreetPalette /> : tool === "building" ? <BuildingPalette /> : tool === "area" ? <AreaPalette /> : tool === "district" ? <DistrictPalette /> : tool === "transit" ? <TransitPalette /> : null}
    </div>
  );
}

function PlantingPalette() {
  const pl = useApp((s) => s.planting);
  const set = useApp((s) => s.setPlanting);
  const [busy, setBusy] = useState(false);
  const fillView = async () => {
    setBusy(true);
    try {
      const [x0, y0, x1, y1] = viewBounds();
      const { executeTool } = await import("@/agent/tools");
      const out = await executeTool("plant_trees", { within: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], count: pl.count, target: "heat", species: pl.species }, { requestApproval: async () => true, approvals: false });
      if (out.isError) useApp.getState().notify("No open sidewalk on screen to plant: draw streets first, or move the map", "warn");
      else {
        const { notifyReport } = await import("@/state/actions");
        notifyReport(out.content as { summary?: string[] }, `Plant ${pl.count} shade trees`);
        // show what they do: the heat map updates live
        if (!useApp.getState().overlay) useApp.getState().setOverlay("heat");
      }
      useApp.getState().bumpWorld();
      useApp.getState().bumpScenarios();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="chrome w-[280px] p-3">
      <div className="font-display text-[17px] leading-none font-semibold text-ink">Plant trees</div>
      <div className="mt-2.5 grid grid-cols-3 gap-1">
        {SPECIES.map((x) => (
          <button
            key={x.id}
            onClick={() => set({ species: x.id })}
            title={x.note}
            className={cx("flex flex-col items-center gap-1 rounded-[6px] border px-1 py-1.5 text-[10.5px] leading-tight transition-colors", x.id === pl.species ? "border-accent/70 bg-accent-2 text-ink" : "border-line text-ink-3 hover:border-line-2 hover:text-ink")}
          >
            <span className="block rounded-full" style={{ width: 6 + x.r * 2.4, height: 6 + x.r * 2.4, background: `rgb(${x.color.join(",")})` }} />
            {x.name}
          </button>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <span className="text-[11px] font-semibold tracking-[0.08em] text-ink-4 uppercase">By hand</span>
        <Segmented
          size="xs"
          value={pl.mode}
          onChange={(mode) => {
            resetDraw();
            set({ mode });
          }}
          options={[
            { value: "single", label: "Click", title: "One tree per click" },
            { value: "row", label: "Row", title: "Click along a sidewalk, Enter to plant" },
            { value: "area", label: "Area", title: "Outline a lot or park, Enter to fill it" },
          ]}
        />
      </div>
      {pl.mode !== "single" && (
        <label className="mt-2 flex items-center gap-2 text-[11.5px] text-ink-3">
          Spacing
          <input type="range" min={4} max={20} step={1} value={pl.spacing} onChange={(e) => set({ spacing: +e.target.value })} className="h-1 min-w-0 flex-1" />
          <span className="tabular w-9 text-right text-ink">{pl.spacing} m</span>
        </label>
      )}

      <div className="mt-3 border-t border-line pt-3">
        <div className="text-[11px] font-semibold tracking-[0.08em] text-ink-4 uppercase">Automatic</div>
        <p className="mt-1 text-[11.5px] leading-snug text-ink-3">Shade the hottest walks: trees go on open sidewalk where people on foot take the most heat, anywhere on screen.</p>
        <div className="mt-2 flex items-center gap-1.5">
          <select value={pl.count} onChange={(e) => set({ count: +e.target.value })} className="h-7 rounded-[5px] border border-line-2 bg-paper px-1 text-[12px]" aria-label="How many trees">
            {[50, 150, 300, 500, 1000].map((n) => (
              <option key={n} value={n}>
                {n} trees
              </option>
            ))}
          </select>
          <Button size="sm" tone="primary" disabled={busy} onClick={fillView} className="flex-1">
            {busy ? <LoaderCircle size={13} className="animate-spin" /> : <TreeDeciduous size={13} />} Shade hot spots
          </Button>
        </div>
      </div>
    </div>
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
      <label className="flex items-center gap-2 text-[12px] text-ink-3">
        <input type="checkbox" checked={p.trees} onChange={(e) => set("street", { trees: e.target.checked })} /> Street trees
      </label>
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
        <select value={p.typology} onChange={(e) => set("building", { typology: e.target.value })} className="h-7 w-36 rounded-[5px] border border-line-2 bg-paper px-1 text-[12px]">
          {TYPOLOGIES.map((t) => (
            <option key={t} value={t}>
              {t.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Floors">
        <input type="range" min={1} max={60} value={p.floors} onChange={(e) => set("building", { floors: +e.target.value })} className="h-1 min-w-0 flex-1" />
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
        <input type="number" min={0} step={100} value={p.homes || ""} placeholder="by style" onChange={(e) => set("district", { homes: Math.max(0, +e.target.value) })} className="tabular h-7 w-24 rounded-[5px] border border-line-2 bg-paper px-2 text-right text-[12px]" />
      </Field>
      <Field label="Max floors">
        <input type="range" min={2} max={40} value={p.maxFloors} onChange={(e) => set("district", { maxFloors: +e.target.value })} className="h-1 min-w-0 flex-1" />
        <span className="tabular w-6 text-right text-ink">{p.maxFloors}</span>
      </Field>
      <label className="flex items-center gap-2 text-[12px] text-ink-3">
        <input type="checkbox" checked={p.newStreets} onChange={(e) => set("district", { newStreets: e.target.checked })} /> Add local streets through big blocks
      </label>
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
        <select value={p.headway} onChange={(e) => set("transit", { headway: +e.target.value })} className="h-7 w-24 rounded-[5px] border border-line-2 bg-paper px-1 text-[12px]">
          {[5, 7.5, 10, 15, 20, 30].map((h) => (
            <option key={h} value={h}>
              {h} min
            </option>
          ))}
        </select>
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
