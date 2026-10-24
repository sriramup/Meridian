// Small procedural meshes (z-up, unit size) for instanced scene props.

export interface SimpleMesh {
  attributes: {
    POSITION: { value: Float32Array; size: 3 };
    NORMAL: { value: Float32Array; size: 3 };
  };
  indices: { value: Uint16Array; size: 1 };
}

/** unit sphere (radius 1) centred at origin */
export function sphereMesh(nlat = 7, nlong = 10): SimpleMesh {
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= nlat; i++) {
    const th = (i / nlat) * Math.PI;
    for (let j = 0; j <= nlong; j++) {
      const ph = (j / nlong) * Math.PI * 2;
      // slight irregularity so canopies don't look machined
      const wob = 1 + 0.06 * Math.sin(ph * 3 + i) * Math.sin(th * 2);
      const x = Math.sin(th) * Math.cos(ph);
      const y = Math.sin(th) * Math.sin(ph);
      const z = Math.cos(th);
      pos.push(x * wob, y * wob, z * wob);
      nrm.push(x, y, z);
    }
  }
  for (let i = 0; i < nlat; i++)
    for (let j = 0; j < nlong; j++) {
      const a = i * (nlong + 1) + j;
      const b = a + nlong + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  return { attributes: { POSITION: { value: new Float32Array(pos), size: 3 }, NORMAL: { value: new Float32Array(nrm), size: 3 } }, indices: { value: new Uint16Array(idx), size: 1 } };
}

/** unit cylinder from z=0 to z=1, radius 1 */
export function cylinderMesh(n = 8): SimpleMesh {
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= n; j++) {
    const a = (j / n) * Math.PI * 2;
    const x = Math.cos(a),
      y = Math.sin(a);
    pos.push(x, y, 0, x, y, 1);
    nrm.push(x, y, 0, x, y, 0);
  }
  for (let j = 0; j < n; j++) {
    const a = j * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  return { attributes: { POSITION: { value: new Float32Array(pos), size: 3 }, NORMAL: { value: new Float32Array(nrm), size: 3 } }, indices: { value: new Uint16Array(idx), size: 1 } };
}

function merge(parts: { pos: number[]; nrm: number[]; idx: number[] }[]): SimpleMesh {
  const pos: number[] = [],
    nrm: number[] = [],
    idx: number[] = [];
  for (const p of parts) {
    const base = pos.length / 3;
    pos.push(...p.pos);
    nrm.push(...p.nrm);
    for (const i of p.idx) idx.push(base + i);
  }
  return { attributes: { POSITION: { value: new Float32Array(pos), size: 3 }, NORMAL: { value: new Float32Array(nrm), size: 3 } }, indices: { value: new Uint16Array(idx), size: 1 } };
}

function lobe(cx: number, cy: number, cz: number, r: number, nlat: number, nlong: number, seed: number) {
  const pos: number[] = [],
    nrm: number[] = [],
    idx: number[] = [];
  for (let i = 0; i <= nlat; i++) {
    const th = (i / nlat) * Math.PI;
    for (let j = 0; j <= nlong; j++) {
      const ph = (j / nlong) * Math.PI * 2;
      const wob = 1 + 0.09 * Math.sin(ph * 4 + seed * 1.7 + i) * Math.sin(th * 3);
      const x = Math.sin(th) * Math.cos(ph),
        y = Math.sin(th) * Math.sin(ph),
        z = Math.cos(th);
      pos.push(cx + x * r * wob, cy + y * r * wob, cz + z * r * wob);
      nrm.push(x, y, z);
    }
  }
  for (let i = 0; i < nlat; i++)
    for (let j = 0; j < nlong; j++) {
      const a = i * (nlong + 1) + j,
        b = a + nlong + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  return { pos, nrm, idx };
}

/**
 * Clustered crown for close-up views: a central mass with leaf clumps around it, fitting the unit
 * sphere's footprint (radius ≈ 1, z −0.8…1) so it is a drop-in for sphereMesh at higher zoom.
 */
export function crownMesh(): SimpleMesh {
  const parts = [lobe(0, 0, 0.12, 0.72, 6, 9, 0)];
  const n = 6;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + 0.4;
    parts.push(lobe(Math.cos(a) * 0.52, Math.sin(a) * 0.52, -0.08 + (k % 2) * 0.22, 0.46, 5, 8, k + 1));
  }
  parts.push(lobe(0.1, -0.05, 0.6, 0.42, 5, 8, 9));
  return merge(parts);
}

/** unit cone, base radius 1 at z=0, apex at z=1 (conifers) */
export function coneMesh(n = 10): SimpleMesh {
  const pos: number[] = [],
    nrm: number[] = [],
    idx: number[] = [];
  const k = 1 / Math.SQRT2;
  for (let j = 0; j <= n; j++) {
    const a = (j / n) * Math.PI * 2;
    const x = Math.cos(a),
      y = Math.sin(a);
    pos.push(x, y, 0, 0, 0, 1);
    nrm.push(x * k, y * k, k, x * k, y * k, k);
  }
  for (let j = 0; j < n; j++) idx.push(j * 2, j * 2 + 2, j * 2 + 1);
  // base
  const c = pos.length / 3;
  pos.push(0, 0, 0);
  nrm.push(0, 0, -1);
  for (let j = 0; j < n; j++) idx.push(c, j * 2 + 2, j * 2);
  return { attributes: { POSITION: { value: new Float32Array(pos), size: 3 }, NORMAL: { value: new Float32Array(nrm), size: 3 } }, indices: { value: new Uint16Array(idx), size: 1 } };
}
