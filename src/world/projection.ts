import type { Vec2 } from "./types";

/** Local tangent-plane projection (equirectangular about an origin). Error < 0.05% within 10 km. */
export class LocalProjection {
  readonly lon0: number;
  readonly lat0: number;
  readonly mx: number;
  readonly my: number;
  constructor(lon0: number, lat0: number) {
    this.lon0 = lon0;
    this.lat0 = lat0;
    const phi = (lat0 * Math.PI) / 180;
    this.my = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
    this.mx = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
  }
  toLocal(lon: number, lat: number): Vec2 {
    return [(lon - this.lon0) * this.mx, (lat - this.lat0) * this.my];
  }
  toLonLat(p: Vec2): [number, number] {
    return [this.lon0 + p[0] / this.mx, this.lat0 + p[1] / this.my];
  }
}
