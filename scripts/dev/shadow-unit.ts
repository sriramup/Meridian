import { shadeMask, sunAt } from "@/sim/heat";
const nx = 200, ny = 200, cell = 4;
const grid = { x0: -400, y0: -400, cell, nx, ny };
const height = new Float32Array(nx * ny);
// 40 m tower, 20×20 m, centred at origin
for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
  const x = grid.x0 + (i + 0.5) * cell, y = grid.y0 + (j + 0.5) * cell;
  if (Math.abs(x) < 10 && Math.abs(y) < 10) height[j * nx + i] = 40;
}
const lc: any = { grid, height, cls: new Uint8Array(nx * ny), ground: new Uint8Array(nx * ny), canopy: new Float32Array(nx * ny) };
const at = (x: number, y: number) => Math.floor((y - grid.y0) / cell) * nx + Math.floor((x - grid.x0) / cell);
for (const [label, alt, az] of [["sun due south, 45°", Math.PI / 4, 0], ["sun due west, 30°", Math.PI / 6, Math.PI / 2], ["sun south-east, 60°", Math.PI / 3, -Math.PI / 4]] as const) {
  const m = shadeMask(lc, [], [], alt, az);
  const L = 40 / Math.tan(alt);
  const dir = [Math.sin(az), Math.cos(az)];
  const probe = (d: number) => m[at(dir[0] * (10 + d), dir[1] * (10 + d))];
  console.log(label, `expected length ${L.toFixed(0)} m:`, "shaded at +5 m", probe(5), "| at L−8", probe(L - 18), "| at L+8", probe(L), "| opposite side", m[at(-dir[0] * 20, -dir[1] * 20)]);
}
const s = sunAt("2026-12-21", 12.5, 30.27, -97.74, -6);
console.log("Austin noon Dec 21: alt", (s.alt * 180 / Math.PI).toFixed(1), "az", (s.az * 180 / Math.PI).toFixed(1), "(0 = south)");
