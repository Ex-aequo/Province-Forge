// Client map: everything a PLAYER's browser may know about the static world, in a
// compact, cacheable form. Built once per game by the server (CLI `create`) and also
// in the preview tool, so both render through exactly the same code path.
//
// Not included (server-only, or revealed per turn through the filtered view):
// resources, province values, start positions, Praga seeds, fairness, per-cell data.
//
// Geometry is stored as TOPOLOGY: border chains are simplified once (two levels of
// detail) and every region ring is a list of chain references, so neighbouring
// provinces always share exactly the same edge — no gaps at any zoom.
import { GENERATOR_VERSION } from '../gen/generate';
import type { BorderKind, Culture, GeneratedMap, LocalName, RegionKind, SeaKind, Terrain } from '../gen/types';

export const CLIENT_FORMAT = 'ex-aequo/client-map';
export const CLIENT_FORMAT_VERSION = 1;

/** Douglas–Peucker tolerances in map units: LOD 0 (world view) and LOD 1 (close-up). */
export const LOD_TOLERANCE: [number, number] = [1.6, 0.25];

export interface ClientRegion {
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
  /** Rings as chain references: [chain index, reversed 0/1, x shift in world widths]. */
  arcs: [number, number, number][][];
}

export interface ClientChain {
  a: number;
  b: number;
  kind: BorderKind;
  closed: boolean;
  /** Flat x,y at each level of detail, coordinates rounded to 0.1. */
  lod: [number[], number[]];
}

export interface ClientRiver {
  id: number;
  name?: LocalName;
  lod: [number[], number[]];
  /** Widths matching the points of each level of detail. */
  widths: [number[], number[]];
}

export interface TileSpec {
  tile: number;
  basePx: number;
  maxLevel: number;
  format: 'webp' | 'jpeg' | 'png';
  /** Relative to the client map's URL; {z} {x} {y} are replaced. */
  path: string;
}

export interface ClientMap {
  format: typeof CLIENT_FORMAT;
  formatVersion: number;
  generator: string;
  world: { width: number; height: number; wrapX: true };
  landmasses: { id: number; title?: LocalName; isContinent: boolean; culture?: Culture }[];
  regions: ClientRegion[];
  chains: ClientChain[];
  rivers: ClientRiver[];
  tiles?: TileSpec;
}

// ------------------------------------------------------------------ building

export function toClientMap(map: GeneratedMap, tiles?: TileSpec): ClientMap {
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const chains: ClientChain[] = map.borders.map((b) => ({
    a: b.a, b: b.b, kind: b.kind, closed: b.closed,
    lod: [simplify(b.pts, LOD_TOLERANCE[0], b.closed).map(r1), simplify(b.pts, LOD_TOLERANCE[1], b.closed).map(r1)],
  }));
  const rivers: ClientRiver[] = map.rivers.map((rv) => {
    const k0 = simplifyIdx(rv.pts, LOD_TOLERANCE[0], false), k1 = simplifyIdx(rv.pts, LOD_TOLERANCE[1], false);
    const pick = (keep: number[]) => keep.flatMap((i) => [r1(rv.pts[2 * i]), r1(rv.pts[2 * i + 1])]);
    const w = (keep: number[]) => keep.map((i) => Math.round(rv.widths[i] * 100) / 100);
    return { id: rv.id, name: rv.name, lod: [pick(k0), pick(k1)], widths: [w(k0), w(k1)] };
  });
  return {
    format: CLIENT_FORMAT,
    formatVersion: CLIENT_FORMAT_VERSION,
    generator: GENERATOR_VERSION,
    world: { width: map.width, height: map.height, wrapX: true },
    landmasses: map.landmasses.map((l) => ({ id: l.id, title: l.title, isContinent: l.isContinent, culture: l.culture })),
    regions: map.regions.map((r) => ({
      id: r.id, kind: r.kind, seaKind: r.seaKind, landmass: r.landmass, coastal: r.coastal,
      terrain: r.terrain, hasRiver: r.hasRiver, name: r.name,
      label: [r1(r.label[0]), r1(r.label[1])], area: Math.round(r.area),
      neighbors: r.neighbors, riverNeighbors: r.riverNeighbors,
      arcs: r.ringArcs ?? [],
    })),
    chains,
    rivers,
    tiles,
  };
}

/** Douglas–Peucker, returns flat points. Endpoints (junctions) are always kept. */
export function simplify(p: number[], tol: number, closed: boolean): number[] {
  const keep = simplifyIdx(p, tol, closed);
  const out: number[] = [];
  for (const i of keep) out.push(p[2 * i], p[2 * i + 1]);
  return out;
}

function simplifyIdx(p: number[], tol: number, closed: boolean): number[] {
  const n = p.length / 2;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[n - 1] = 1;
  // closed rings: also keep the farthest point from the start, so the ring stays a ring
  let mid = -1;
  if (closed) {
    let bd = -1;
    for (let i = 1; i < n - 1; i++) { const d = (p[2 * i] - p[0]) ** 2 + (p[2 * i + 1] - p[1]) ** 2; if (d > bd) { bd = d; mid = i; } }
    keep[mid] = 1;
  }
  const t2 = tol * tol;
  const stack: [number, number][] = mid > 0 ? [[0, mid], [mid, n - 1]] : [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const ax = p[2 * a], ay = p[2 * a + 1], bx = p[2 * b], by = p[2 * b + 1];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let bi = -1, bd = -1;
    for (let i = a + 1; i < b; i++) {
      const px = p[2 * i] - ax, py = p[2 * i + 1] - ay;
      let d: number;
      if (len2 === 0) d = px * px + py * py;
      else { const c = px * dy - py * dx; d = (c * c) / len2; }
      if (d > bd) { bd = d; bi = i; }
    }
    if (bd > t2) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}
