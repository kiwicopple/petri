// Uniform grid for fast circle queries over many points (pellets, cells). DOM-free.

export interface Point {
  x: number;
  y: number;
}

export class SpatialGrid<T extends Point> {
  private buckets = new Map<number, Map<number | string, T>>();
  private where = new Map<number | string, number>();

  constructor(readonly cellSize = 128) {}

  get size(): number {
    return this.where.size;
  }

  private key(cx: number, cy: number): number {
    // Supports coordinates in roughly ±(2^15 * cellSize) without collisions.
    return (cx + 32768) * 65536 + (cy + 32768);
  }

  private keyFor(x: number, y: number): number {
    return this.key(Math.floor(x / this.cellSize), Math.floor(y / this.cellSize));
  }

  /** Insert or move an item. */
  set(id: number | string, item: T): void {
    const k = this.keyFor(item.x, item.y);
    const prev = this.where.get(id);
    if (prev !== undefined && prev !== k) this.buckets.get(prev)?.delete(id);
    let b = this.buckets.get(k);
    if (!b) this.buckets.set(k, (b = new Map()));
    b.set(id, item);
    this.where.set(id, k);
  }

  delete(id: number | string): boolean {
    const k = this.where.get(id);
    if (k === undefined) return false;
    const b = this.buckets.get(k);
    b?.delete(id);
    if (b && b.size === 0) this.buckets.delete(k);
    this.where.delete(id);
    return true;
  }

  has(id: number | string): boolean {
    return this.where.has(id);
  }

  clear(): void {
    this.buckets.clear();
    this.where.clear();
  }

  /** Visit every item whose point lies within distance r of (x, y). */
  queryCircle(x: number, y: number, r: number, visit: (item: T, id: number | string) => void): void {
    const r2 = r * r;
    this.queryRect(x - r, y - r, x + r, y + r, (item, id) => {
      const dx = item.x - x;
      const dy = item.y - y;
      if (dx * dx + dy * dy <= r2) visit(item, id);
    });
  }

  /** Visit every item in the axis-aligned rect (inclusive bucket coverage, exact point test). */
  queryRect(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    visit: (item: T, id: number | string) => void,
  ): void {
    const cs = this.cellSize;
    const cx0 = Math.floor(x0 / cs);
    const cy0 = Math.floor(y0 / cs);
    const cx1 = Math.floor(x1 / cs);
    const cy1 = Math.floor(y1 / cs);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const b = this.buckets.get(this.key(cx, cy));
        if (!b) continue;
        for (const [id, item] of b) {
          if (item.x >= x0 && item.x <= x1 && item.y >= y0 && item.y <= y1) visit(item, id);
        }
      }
    }
  }
}
