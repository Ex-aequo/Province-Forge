// RenderMap: the view-side model every renderer draws from. Built from a ClientMap
// (game client) — the preview tool builds a ClientMap first, so both share one path.
import type { BorderKind, LocalName, RegionKind, SeaKind, Terrain } from '../gen/types';
import type { ClientMap, ClientRegion } from './clientMap';

export type Lod = 0 | 1;

export interface RenderRegion {
  id: number;
  kind: RegionKind;
  seaKind?: SeaKind;
  landmass: number;
  coastal: boolean;
  terrain?: Terrain;
  hasRiver?: boolean;
  name?: LocalName;
  label: [number, number];
  area: number;
  neighbors: number[];
  riverNeighbors: number[];
}

export interface RenderBorder { a: number; b: number; kind: BorderKind; closed: boolean; pts: number[] }
export interface RenderRiver { id: number; name?: LocalName; pts: number[]; widths: number[] }

export class RenderMap {
  readonly width: number;
  readonly height: number;
  readonly regions: RenderRegion[];
  readonly landmasses: ClientMap['landmasses'];
  /** Typical province size in map units (used to size labels). */
  readonly spacing: number;
  lod: Lod = 1;

  private ringCache: [Map<number, number[][]>, Map<number, number[][]>] = [new Map(), new Map()];
  private borderCache: [RenderBorder[] | null, RenderBorder[] | null] = [null, null];
  private riverCache: [RenderRiver[] | null, RenderRiver[] | null] = [null, null];
  private grid = new Map<number, number[]>();
  private cell: number;
  private bbox: Float64Array;

  constructor(private cm: ClientMap) {
    this.width = cm.world.width;
    this.height = cm.world.height;
    this.landmasses = cm.landmasses;
    this.regions = cm.regions.map((r: ClientRegion) => ({
      id: r.id, kind: r.kind, seaKind: r.seaKind, landmass: r.landmass, coastal: r.coastal,
      terrain: r.terrain, hasRiver: r.hasRiver, name: r.name, label: r.label, area: r.area,
      neighbors: r.neighbors, riverNeighbors: r.riverNeighbors,
    }));
    const land = this.regions.filter((r) => r.kind === 'land');
    this.spacing = Math.sqrt(land.reduce((s, r) => s + r.area, 0) / Math.max(1, land.length)) / 5;

    // spatial index for picking (bounding boxes of LOD-1 rings, x in [0, W))
    this.cell = this.width / 64;
    this.bbox = new Float64Array(this.regions.length * 4);
    for (const r of this.regions) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const ring of this.rings(r.id, 1)) for (let i = 0; i < ring.length; i += 2) {
        x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]); y0 = Math.min(y0, ring[i + 1]); y1 = Math.max(y1, ring[i + 1]);
      }
      this.bbox.set([x0, y0, x1, y1], r.id * 4);
      if (!Number.isFinite(x0)) continue;
      for (let gx = Math.floor(x0 / this.cell); gx <= Math.floor(x1 / this.cell); gx++) {
        for (let gy = Math.floor(y0 / this.cell); gy <= Math.floor(y1 / this.cell); gy++) {
          const k = this.key(gx, gy);
          (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(r.id);
        }
      }
    }
  }

  private key(gx: number, gy: number) {
    const n = Math.round(this.width / this.cell);
    return (((gx % n) + n) % n) * 4096 + gy;
  }

  /** Rings of a region at a level of detail (current one by default). */
  rings(id: number, lod: Lod = this.lod): number[][] {
    const cache = this.ringCache[lod];
    let out = cache.get(id);
    if (out) return out;
    out = [];
    const W = this.width;
    for (const arcs of this.cm.regions[id].arcs) {
      const ring: number[] = [];
      arcs.forEach(([ci, rev, k], i) => {
        const src = this.cm.chains[ci].lod[lod];
        const m = src.length / 2;
        for (let j = i === 0 ? 0 : 1; j < m; j++) {
          const t = rev ? m - 1 - j : j;
          ring.push(src[2 * t] + k * W, src[2 * t + 1]);
        }
      });
      out.push(ring);
    }
    cache.set(id, out);
    return out;
  }

  get borders(): RenderBorder[] {
    const l = this.lod;
    return (this.borderCache[l] ??= this.cm.chains.map((c) => ({ a: c.a, b: c.b, kind: c.kind, closed: c.closed, pts: c.lod[l] })));
  }

  get rivers(): RenderRiver[] {
    const l = this.lod;
    return (this.riverCache[l] ??= this.cm.rivers.map((r) => ({ id: r.id, name: r.name, pts: r.lod[l], widths: r.widths[l] })));
  }

  /** Region under a world point (wrap-aware), or -1. */
  pick(x: number, y: number): number {
    if (y < 0 || y > this.height) return -1;
    const W = this.width;
    const xw = ((x % W) + W) % W;
    const list = this.grid.get(this.key(Math.floor(xw / this.cell), Math.floor(y / this.cell))) ?? [];
    for (const id of list) {
      for (const sx of [xw, xw - W, xw + W]) {
        const b = id * 4;
        if (sx < this.bbox[b] || sx > this.bbox[b + 2] || y < this.bbox[b + 1] || y > this.bbox[b + 3]) continue;
        if (inside(this.rings(id, 1), sx, y)) return id;
      }
    }
    return -1;
  }
}

function inside(rings: number[][], x: number, y: number) {
  let c = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}
