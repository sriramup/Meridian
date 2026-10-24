// Agent zones on the map: each session's zone as a dashed outline with a faint fill and a small
// label with the agent's title, in the session's own colour (the viewed session's zone drawn
// stronger), plus the live preview while a zone is being drawn.

import { COORDINATE_SYSTEM, type Layer, type Position } from "@deck.gl/core";
import { PathStyleExtension } from "@deck.gl/extensions";
import { PathLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer } from "@deck.gl/layers";
import type { Runtime } from "@/state/runtime";
import type { Polygon, Vec2 } from "@/world/types";

type RGB = [number, number, number];

export interface ZoneDatum {
  key: string;
  poly: Polygon;
  color: RGB;
  /** the agent's title */
  title: string;
  emphasis: boolean;
}

export interface ZonePreview {
  ring: Vec2[];
  /** corners to mark (polygon mode) */
  corners: Vec2[];
  closed: boolean;
  color: RGB;
  label: string | null;
}

const dashExt = new PathStyleExtension({ dash: true, highPrecisionDash: true });
const FLAT = { depthWriteEnabled: false, depthCompare: "always" } as const;

const short = (t: string, n = 30) => (t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t);

/** where a zone's label sits: its northernmost corner, so it doesn't cover what's inside */
function labelAt(poly: Polygon): Vec2 {
  let best = poly[0]?.[0] ?? [0, 0];
  for (const p of poly[0] ?? []) if (p[1] > best[1] || (p[1] === best[1] && p[0] < best[0])) best = p;
  return best as Vec2;
}

export function zoneLayers(R: Runtime, zones: ZoneDatum[], preview: ZonePreview | null): { ground: Layer[]; top: Layer[] } {
  const common = { coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS, coordinateOrigin: [R.meta.origin.lon, R.meta.origin.lat, 0] as [number, number, number] };
  const ground: Layer[] = [];
  const top: Layer[] = [];
  const closedPath = (ring: Vec2[]) => [...ring, ring[0]].map((p) => [p[0], p[1], 0.6] as Position);
  // emphasised last so it draws over overlapping zones
  const zs = zones.filter((z) => z.poly[0]?.length >= 3).sort((a, b) => Number(a.emphasis) - Number(b.emphasis));

  if (zs.length) {
    ground.push(
      new SolidPolygonLayer<ZoneDatum>({
        id: "agent-zones-fill",
        ...common,
        data: zs,
        getPolygon: (d) => d.poly as unknown as Position[][],
        getFillColor: (d) => [...d.color, d.emphasis ? 26 : 14],
        parameters: FLAT,
      }),
    );
    top.push(
      new PathLayer<ZoneDatum, { getDashArray: (d: ZoneDatum) => [number, number]; dashJustified: boolean }>({
        id: "agent-zones-outline",
        ...common,
        data: zs,
        getPath: (d) => closedPath(d.poly[0] as Vec2[]),
        getColor: (d) => [...d.color, d.emphasis ? 255 : 170],
        getWidth: (d) => (d.emphasis ? 2.5 : 1.6),
        widthUnits: "pixels",
        getDashArray: (d) => (d.emphasis ? [5, 3] : [4, 4]),
        dashJustified: true,
        capRounded: true,
        jointRounded: true,
        extensions: [dashExt],
        parameters: FLAT,
      }),
      new TextLayer<ZoneDatum>({
        id: "agent-zones-label",
        ...common,
        data: zs,
        getPosition: (d) => {
          const p = labelAt(d.poly);
          return [p[0], p[1], 1];
        },
        getText: (d) => short(d.title),
        getSize: (d) => (d.emphasis ? 12 : 11),
        getColor: [255, 250, 238, 255],
        background: true,
        getBackgroundColor: (d) => [...d.color, d.emphasis ? 240 : 200],
        backgroundPadding: [6, 3],
        getTextAnchor: "start",
        getAlignmentBaseline: "bottom",
        getPixelOffset: [0, -6],
        fontFamily: "Geist, system-ui, sans-serif",
        fontWeight: 600,
        characterSet: "auto",
        parameters: FLAT,
      }),
    );
  }

  if (preview && preview.ring.length >= 2) {
    const ring = preview.ring;
    if (preview.closed && ring.length >= 3)
      ground.push(new SolidPolygonLayer({ id: "agent-zone-draft-fill", ...common, data: [{ polygon: ring }], getPolygon: (d: { polygon: Position[] }) => d.polygon, getFillColor: [...preview.color, 40], parameters: FLAT }));
    top.push(
      new PathLayer<{ path: Position[] }, { getDashArray: () => [number, number]; dashJustified: boolean }>({
        id: "agent-zone-draft-outline",
        ...common,
        data: [{ path: preview.closed && ring.length >= 3 ? closedPath(ring) : ring.map((p) => [p[0], p[1], 0.6] as Position) }],
        getPath: (d) => d.path,
        getColor: [...preview.color, 255],
        getWidth: 2,
        widthUnits: "pixels",
        getDashArray: () => [5, 3],
        dashJustified: true,
        extensions: [dashExt],
        parameters: FLAT,
      }),
    );
  }
  if (preview && preview.corners.length)
    top.push(
      new ScatterplotLayer<Vec2>({
        id: "agent-zone-draft-corners",
        ...common,
        data: preview.corners,
        getPosition: (p) => [p[0], p[1], 0.8],
        getRadius: 4,
        radiusUnits: "pixels",
        getFillColor: [255, 250, 238, 255],
        getLineColor: [...preview.color, 255],
        stroked: true,
        lineWidthMinPixels: 2,
        parameters: FLAT,
      }),
    );
  if (preview?.label && preview.ring.length >= 3) {
    const p = labelAt([preview.ring]);
    top.push(
      new TextLayer({
        id: "agent-zone-draft-label",
        ...common,
        data: [{ p, t: preview.label }],
        getPosition: (d: { p: Vec2 }) => [d.p[0], d.p[1], 1],
        getText: (d: { t: string }) => d.t,
        getSize: 12,
        getColor: [255, 250, 238, 255],
        background: true,
        getBackgroundColor: [...preview.color, 240],
        backgroundPadding: [6, 3],
        getTextAnchor: "start",
        getAlignmentBaseline: "bottom",
        getPixelOffset: [0, -6],
        fontFamily: "Geist, system-ui, sans-serif",
        fontWeight: 600,
        characterSet: "auto",
        parameters: FLAT,
      }),
    );
  }
  return { ground, top };
}
