export type BBox = [number, number, number, number];

/** Uniform-grid spatial hash supporting incremental insert/remove. */
export class GridIndex {
  private cells = new Map<number, Set<string>>();
  private boxes = new Map<string, BBox>();
  constructor(readonly cell = 64) {}

  private key(ix: number, iy: number) {
    return (ix + 32768) * 65536 + (iy + 32768);
  }

  private range(b: BBox) {
    const c = this.cell;
    return [Math.floor(b[0] / c), Math.floor(b[1] / c), Math.floor(b[2] / c), Math.floor(b[3] / c)];
  }

  insert(id: string, b: BBox) {
    if (this.boxes.has(id)) this.remove(id);
    this.boxes.set(id, b);
    const [x0, y0, x1, y1] = this.range(b);
    for (let ix = x0; ix <= x1; ix++)
      for (let iy = y0; iy <= y1; iy++) {
        const k = this.key(ix, iy);
        let s = this.cells.get(k);
        if (!s) this.cells.set(k, (s = new Set()));
        s.add(id);
      }
  }

  remove(id: string) {
    const b = this.boxes.get(id);
    if (!b) return;
    this.boxes.delete(id);
    const [x0, y0, x1, y1] = this.range(b);
    for (let ix = x0; ix <= x1; ix++)
      for (let iy = y0; iy <= y1; iy++) this.cells.get(this.key(ix, iy))?.delete(id);
  }

  bbox(id: string) {
    return this.boxes.get(id);
  }

  query(b: BBox, out: Set<string> = new Set()): Set<string> {
    const [x0, y0, x1, y1] = this.range(b);
    for (let ix = x0; ix <= x1; ix++)
      for (let iy = y0; iy <= y1; iy++) {
        const s = this.cells.get(this.key(ix, iy));
        if (!s) continue;
        for (const id of s) {
          const bb = this.boxes.get(id)!;
          if (bb[2] >= b[0] && bb[0] <= b[2] && bb[3] >= b[1] && bb[1] <= b[3]) out.add(id);
        }
      }
    return out;
  }

  get size() {
    return this.boxes.size;
  }
}
