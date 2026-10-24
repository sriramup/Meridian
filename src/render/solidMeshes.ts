// Unit meshes for library solids (src/world/types.ts Solid). Every shape fills the unit box
// x, y ∈ [-0.5, 0.5], z ∈ [0, 1] with its base centre at the origin, so a solid is the mesh
// scaled by `size` (full extents), turned and moved to `at`:
//
//   box         a cuboid filling the unit box
//   cylinder    an upright (elliptic) cylinder, capped
//   cone        base ellipse at z = 0, apex at the top centre
//   sphere      an ellipsoid filling the box (centre at z = 0.5)
//   hemisphere  the upper half of an ellipsoid: flat base at z = 0, dome to z = 1
//   wedge       a gable prism: rectangular base, ridge along x at the top (y = 0, z = 1),
//               the two slopes face ±y (roofs, ramps of two halves, tent shapes)
//   pyramid     rectangular base, apex at the top centre (hip roofs, spires, obelisk tips)
//   torus       a ring lying flat: tube centre-line radius 0.4, tube 0.1 thick across and the
//               full height (z 0…1) tall — size z sets how thick the ring is vertically
//
// Normals are per face (flat) for faceted shapes and per vertex for curved ones; the layer
// transforms them with the inverse-transpose so non-uniform sizes still light correctly.

import type { SolidShape } from "@/world/types";

export interface UnitMesh {
  attributes: {
    POSITION: { value: Float32Array; size: 3 };
    NORMAL: { value: Float32Array; size: 3 };
  };
  indices: { value: Uint16Array | Uint32Array; size: 1 };
}

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  idx: number[] = [];
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
    const l = Math.hypot(nx, ny, nz) || 1;
    this.pos.push(x, y, z);
    this.nrm.push(nx / l, ny / l, nz / l);
    return this.pos.length / 3 - 1;
  }
  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }
  /** a flat polygon (counter-clockwise seen from the side its normal faces), fan-triangulated */
  face(pts: [number, number, number][]) {
    const [a, b, c] = pts;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const n: [number, number, number] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const ids = pts.map((p) => this.v(p[0], p[1], p[2], ...n));
    for (let i = 1; i + 1 < ids.length; i++) this.tri(ids[0], ids[i], ids[i + 1]);
  }
  mesh(): UnitMesh {
    const n = this.pos.length / 3;
    return {
      attributes: { POSITION: { value: new Float32Array(this.pos), size: 3 }, NORMAL: { value: new Float32Array(this.nrm), size: 3 } },
      indices: { value: n > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), size: 1 },
    };
  }
}

const H = 0.5;

function box(): UnitMesh {
  const b = new Builder();
  const P = (x: number, y: number, z: number): [number, number, number] => [x * H, y * H, z];
  b.face([P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)]); // top
  b.face([P(-1, 1, 0), P(1, 1, 0), P(1, -1, 0), P(-1, -1, 0)]); // bottom
  b.face([P(-1, -1, 0), P(1, -1, 0), P(1, -1, 1), P(-1, -1, 1)]); // -y
  b.face([P(1, 1, 0), P(-1, 1, 0), P(-1, 1, 1), P(1, 1, 1)]); // +y
  b.face([P(1, -1, 0), P(1, 1, 0), P(1, 1, 1), P(1, -1, 1)]); // +x
  b.face([P(-1, 1, 0), P(-1, -1, 0), P(-1, -1, 1), P(-1, 1, 1)]); // -x
  return b.mesh();
}

function disc(b: Builder, n: number, z: number, up: boolean) {
  const c = b.v(0, 0, z, 0, 0, up ? 1 : -1);
  const ring: number[] = [];
  for (let j = 0; j < n; j++) {
    const a = (j / n) * Math.PI * 2;
    ring.push(b.v(Math.cos(a) * H, Math.sin(a) * H, z, 0, 0, up ? 1 : -1));
  }
  for (let j = 0; j < n; j++) up ? b.tri(c, ring[j], ring[(j + 1) % n]) : b.tri(c, ring[(j + 1) % n], ring[j]);
}

function cylinder(n = 18): UnitMesh {
  const b = new Builder();
  for (let j = 0; j <= n; j++) {
    const a = (j / n) * Math.PI * 2;
    const x = Math.cos(a), y = Math.sin(a);
    b.v(x * H, y * H, 0, x, y, 0);
    b.v(x * H, y * H, 1, x, y, 0);
  }
  for (let j = 0; j < n; j++) {
    const a = j * 2;
    b.tri(a, a + 2, a + 1);
    b.tri(a + 1, a + 2, a + 3);
  }
  disc(b, n, 1, true);
  disc(b, n, 0, false);
  return b.mesh();
}

function cone(n = 18): UnitMesh {
  const b = new Builder();
  // slant normal for radius 0.5, height 1: (cos a, sin a, 0.5) normalised
  for (let j = 0; j <= n; j++) {
    const a = (j / n) * Math.PI * 2;
    const am = ((j + 0.5) / n) * Math.PI * 2;
    const x = Math.cos(a), y = Math.sin(a);
    b.v(x * H, y * H, 0, x, y, 0.5);
    b.v(0, 0, 1, Math.cos(am), Math.sin(am), 0.5);
  }
  for (let j = 0; j < n; j++) b.tri(j * 2, j * 2 + 2, j * 2 + 1);
  disc(b, n, 0, false);
  return b.mesh();
}

function ellipsoid(nlat: number, nlong: number, upper: boolean): UnitMesh {
  const b = new Builder();
  const th0 = 0;
  const th1 = upper ? Math.PI / 2 : Math.PI;
  for (let i = 0; i <= nlat; i++) {
    const th = th0 + ((th1 - th0) * i) / nlat;
    for (let j = 0; j <= nlong; j++) {
      const ph = (j / nlong) * Math.PI * 2;
      const x = Math.sin(th) * Math.cos(ph), y = Math.sin(th) * Math.sin(ph), z = Math.cos(th);
      // sphere: centre z = 0.5, radius 0.5; hemisphere: centre z = 0, x/y radius 0.5, height 1
      if (upper) b.v(x * H, y * H, z, x * 2, y * 2, z);
      else b.v(x * H, y * H, 0.5 + z * H, x, y, z);
    }
  }
  for (let i = 0; i < nlat; i++)
    for (let j = 0; j < nlong; j++) {
      const a = i * (nlong + 1) + j, c = a + nlong + 1;
      b.tri(a, c, a + 1);
      b.tri(c, c + 1, a + 1);
    }
  if (upper) disc(b, nlong, 0, false);
  return b.mesh();
}

function wedge(): UnitMesh {
  const b = new Builder();
  b.face([[-H, -H, 0], [H, -H, 0], [H, 0, 1], [-H, 0, 1]]); // -y slope
  b.face([[H, H, 0], [-H, H, 0], [-H, 0, 1], [H, 0, 1]]); // +y slope
  b.face([[H, -H, 0], [H, H, 0], [H, 0, 1]]); // +x gable
  b.face([[-H, H, 0], [-H, -H, 0], [-H, 0, 1]]); // -x gable
  b.face([[-H, H, 0], [H, H, 0], [H, -H, 0], [-H, -H, 0]]); // bottom
  return b.mesh();
}

function pyramid(): UnitMesh {
  const b = new Builder();
  const top: [number, number, number] = [0, 0, 1];
  b.face([[-H, -H, 0], [H, -H, 0], top]);
  b.face([[H, -H, 0], [H, H, 0], top]);
  b.face([[H, H, 0], [-H, H, 0], top]);
  b.face([[-H, H, 0], [-H, -H, 0], top]);
  b.face([[-H, H, 0], [H, H, 0], [H, -H, 0], [-H, -H, 0]]);
  return b.mesh();
}

function torus(nu = 24, nv = 12): UnitMesh {
  const b = new Builder();
  const R = 0.4, rx = 0.1;
  for (let i = 0; i <= nu; i++) {
    const u = (i / nu) * Math.PI * 2;
    const cu = Math.cos(u), su = Math.sin(u);
    for (let j = 0; j <= nv; j++) {
      const v = (j / nv) * Math.PI * 2;
      const cv = Math.cos(v), sv = Math.sin(v);
      const r = R + rx * cv;
      // tube cross-section is an ellipse: rx across, 0.5 tall; normal of that ellipse
      b.v(r * cu, r * su, 0.5 + 0.5 * sv, (cv / rx) * cu, (cv / rx) * su, sv / 0.5);
    }
  }
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const a = i * (nv + 1) + j, c = a + nv + 1;
      b.tri(a, c, a + 1);
      b.tri(c, c + 1, a + 1);
    }
  return b.mesh();
}

/** mesh detail: 0 far, 1 middle distance, 2 close (flat-sided shapes are the same at every level) */
export type MeshLod = 0 | 1 | 2;

const cache = new Map<string, UnitMesh>();
const MAKE: Record<SolidShape, (lod: MeshLod) => UnitMesh> = {
  box,
  cylinder: (l) => cylinder([6, 10, 18][l]),
  cone: (l) => cone([6, 10, 18][l]),
  sphere: (l) => ellipsoid([4, 6, 10][l], [6, 10, 16][l], false),
  hemisphere: (l) => ellipsoid([2, 4, 6][l], [6, 10, 16][l], true),
  wedge,
  pyramid,
  torus: (l) => torus([12, 18, 24][l], [8, 8, 12][l]),
};

export const SOLID_SHAPES = Object.keys(MAKE) as SolidShape[];

/** the shared unit mesh for a shape at a detail level (built once) */
export function unitMesh(shape: SolidShape, lod: MeshLod = 2): UnitMesh {
  const k = `${shape}:${lod}`;
  let m = cache.get(k);
  if (!m) cache.set(k, (m = MAKE[shape](lod)));
  return m;
}
