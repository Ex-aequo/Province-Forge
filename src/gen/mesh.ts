// Cell mesh on a cylinder: Poisson-disc sites, Voronoi with ghost copies across the
// east–west seam, Lloyd relaxation, and per-cell edge lists with wrapped neighbours.
import { Delaunay } from 'd3-delaunay';
import type { Rng } from './rng';

export interface CellEdge {
  /** Neighbouring cell, or -1 for the top/bottom world edge. */
  n: number;
  ax: number; ay: number; bx: number; by: number;
}

export interface Mesh {
  W: number;
  H: number;
  n: number;
  x: Float64Array;
  y: Float64Array;
  /** Cell polygon in the cell's own frame (flat x,y, not closed). */
  polys: Float64Array[];
  edges: CellEdge[][];
  /** Unique neighbour lists (wrap-aware). */
  nbrs: Int32Array[];
  area: Float64Array;
  /** Average spacing between sites. */
  spacing: number;
  /** Delaunay triangles including seam ghosts: 6 coords + 3 (original) cell ids each. */
  triXY: Float64Array;
  triCell: Int32Array;
  findCell: (x: number, y: number) => number;
}

export const wrapX = (x: number, W: number) => ((x % W) + W) % W;
/** Signed shortest x-offset from a to b on the cylinder. */
export const dxWrap = (a: number, b: number, W: number) => {
  let d = b - a;
  if (d > W / 2) d -= W;
  else if (d < -W / 2) d += W;
  return d;
};

/** Bridson Poisson-disc sampling with x wrap. */
export function poissonCylinder(W: number, H: number, r: number, rng: Rng, k = 30): { x: number[]; y: number[] } {
  const cs0 = r / Math.SQRT2;
  const gw = Math.ceil(W / cs0);
  const csx = W / gw; // exact division so the grid wraps cleanly
  const gh = Math.ceil(H / cs0);
  const csy = H / gh;
  const grid = new Int32Array(gw * gh).fill(-1);
  const xs: number[] = [], ys: number[] = [];
  const active: number[] = [];
  const r2 = r * r;

  const fits = (x: number, y: number) => {
    const gx = Math.floor(x / csx), gy = Math.floor(y / csy);
    for (let oy = -2; oy <= 2; oy++) {
      const yy = gy + oy;
      if (yy < 0 || yy >= gh) continue;
      for (let ox = -2; ox <= 2; ox++) {
        const xx = (gx + ox + gw) % gw;
        const idx = grid[yy * gw + xx];
        if (idx < 0) continue;
        const dx = dxWrap(xs[idx], x, W), dy = ys[idx] - y;
        if (dx * dx + dy * dy < r2) return false;
      }
    }
    return true;
  };
  const add = (x: number, y: number) => {
    const i = xs.length;
    xs.push(x); ys.push(y); active.push(i);
    grid[Math.floor(y / csy) * gw + Math.floor(x / csx)] = i;
  };

  add(rng() * W, rng() * H);
  while (active.length) {
    const ai = Math.floor(rng() * active.length);
    const i = active[ai];
    let placed = false;
    for (let t = 0; t < k; t++) {
      const ang = rng() * Math.PI * 2;
      const rad = r * (1 + rng());
      const x = wrapX(xs[i] + Math.cos(ang) * rad, W);
      const y = ys[i] + Math.sin(ang) * rad;
      if (y < 0 || y >= H) continue;
      if (fits(x, y)) { add(x, y); placed = true; break; }
    }
    if (!placed) { active[ai] = active[active.length - 1]; active.pop(); }
  }
  return { x: xs, y: ys };
}

/** Numeric key for an edge, from its midpoint (shared edges have identical endpoints). */
const edgeKey = (ax: number, ay: number, bx: number, by: number) =>
  Math.round((ax + bx) * 50 + 1e6) * 4194304 + Math.round((ay + by) * 50 + 1e5);
const samePt = (ax: number, ay: number, bx: number, by: number) =>
  Math.abs(ax - bx) < 1e-6 && Math.abs(ay - by) < 1e-6;

/** Build the wrapped Voronoi mesh for the given sites (x must be in [0, W)). */
export function buildMesh(xs: ArrayLike<number>, ys: ArrayLike<number>, W: number, H: number): Mesh {
  const n = xs.length;
  const spacing = Math.sqrt((W * H) / n);
  const margin = spacing * 5;

  // originals + ghost copies near the seam
  const px: number[] = [], py: number[] = [], orig: number[] = [];
  for (let i = 0; i < n; i++) { px.push(xs[i]); py.push(ys[i]); orig.push(i); }
  for (let i = 0; i < n; i++) {
    if (xs[i] < margin) { px.push(xs[i] + W); py.push(ys[i]); orig.push(i); }
    if (xs[i] > W - margin) { px.push(xs[i] - W); py.push(ys[i]); orig.push(i); }
  }
  const total = px.length;
  const coords = new Float64Array(total * 2);
  for (let i = 0; i < total; i++) { coords[2 * i] = px[i]; coords[2 * i + 1] = py[i]; }
  const delaunay = new Delaunay(coords);
  const vor = delaunay.voronoi([-margin - spacing, 0, W + margin + spacing, H]);

  // Edge ownership map over every polygon (originals and ghosts)
  const rawPolys: (Float64Array | null)[] = new Array(total);
  const owner1 = new Map<number, number>();
  const owner2 = new Map<number, number>();
  for (let k = 0; k < total; k++) {
    const ring = vor.cellPolygon(k);
    if (!ring) { rawPolys[k] = null; continue; }
    const m = ring.length - 1; // ring is closed
    const flat = new Float64Array(m * 2);
    for (let j = 0; j < m; j++) { flat[2 * j] = ring[j][0]; flat[2 * j + 1] = ring[j][1]; }
    rawPolys[k] = flat;
    for (let j = 0; j < m; j++) {
      const j2 = (j + 1) % m;
      const key = edgeKey(flat[2 * j], flat[2 * j + 1], flat[2 * j2], flat[2 * j2 + 1]);
      if (owner1.has(key)) owner2.set(key, k); else owner1.set(key, k);
    }
  }

  const polys: Float64Array[] = new Array(n);
  const edges: CellEdge[][] = new Array(n);
  const nbrs: Int32Array[] = new Array(n);
  const area = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const flat = rawPolys[i] ?? new Float64Array(0);
    polys[i] = flat;
    const m = flat.length / 2;
    const el: CellEdge[] = [];
    const ns = new Set<number>();
    let a2 = 0;
    for (let j = 0; j < m; j++) {
      const j2 = (j + 1) % m;
      const ax = flat[2 * j], ay = flat[2 * j + 1], bx = flat[2 * j2], by = flat[2 * j2 + 1];
      a2 += ax * by - bx * ay;
      if (samePt(ax, ay, bx, by)) continue; // degenerate zero-length edge
      const key = edgeKey(ax, ay, bx, by);
      const o1 = owner1.get(key), o2 = owner2.get(key);
      const other = o1 === i ? o2 : o1;
      let nb = other === undefined ? -1 : orig[other];
      if (nb === i) nb = -1; // would only happen on absurdly small worlds
      el.push({ n: nb, ax, ay, bx, by });
      if (nb >= 0) ns.add(nb);
    }
    edges[i] = el;
    nbrs[i] = Int32Array.from(ns);
    area[i] = Math.abs(a2) / 2;
  }

  const findCell = (x: number, y: number) => {
    const k = delaunay.find(wrapX(x, W), Math.min(H, Math.max(0, y)));
    return orig[k];
  };

  // triangles touching the world (originals or near-seam ghosts), for raster interpolation
  const T = delaunay.triangles;
  const tXY: number[] = [], tC: number[] = [];
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t], b = T[t + 1], c = T[t + 2];
    const cx = (px[a] + px[b] + px[c]) / 3;
    if (cx < -margin * 0.8 || cx > W + margin * 0.8) continue;
    tXY.push(px[a], py[a], px[b], py[b], px[c], py[c]);
    tC.push(orig[a], orig[b], orig[c]);
  }

  return { W, H, n, x: Float64Array.from(xs), y: Float64Array.from(ys), polys, edges, nbrs, area, spacing, triXY: Float64Array.from(tXY), triCell: Int32Array.from(tC), findCell };
}

/** Lloyd step without building the full mesh (cheap intermediate passes). */
function quickLloyd(xs: number[], ys: number[], W: number, H: number): { x: number[]; y: number[] } {
  const n = xs.length;
  const margin = Math.sqrt((W * H) / n) * 4;
  const coords: number[] = [];
  for (let i = 0; i < n; i++) coords.push(xs[i], ys[i]);
  for (let i = 0; i < n; i++) {
    if (xs[i] < margin) coords.push(xs[i] + W, ys[i]);
    if (xs[i] > W - margin) coords.push(xs[i] - W, ys[i]);
  }
  const vor = new Delaunay(Float64Array.from(coords)).voronoi([-margin * 2, 0, W + margin * 2, H]);
  const ox: number[] = new Array(n), oy: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const ring = vor.cellPolygon(i);
    if (!ring) { ox[i] = xs[i]; oy[i] = ys[i]; continue; }
    let a = 0, cx = 0, cy = 0;
    for (let j = 0; j < ring.length - 1; j++) {
      const [x0, y0] = ring[j], [x1, y1] = ring[j + 1];
      const c = x0 * y1 - x1 * y0;
      a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
    }
    if (Math.abs(a) < 1e-9) { ox[i] = xs[i]; oy[i] = ys[i]; continue; }
    ox[i] = wrapX(cx / (3 * a), W);
    oy[i] = Math.min(H - 1e-6, Math.max(1e-6, cy / (3 * a)));
  }
  return { x: ox, y: oy };
}

export function generateMesh(W: number, H: number, cellCount: number, relax: number, rng: Rng): Mesh {
  // Bridson (k=30) reaches ~0.63 points per r² of area in practice.
  const r = Math.sqrt((0.63 * W * H) / cellCount);
  let { x, y } = poissonCylinder(W, H, r, rng);
  for (let it = 0; it < relax; it++) ({ x, y } = quickLloyd(x, y, W, H));
  return buildMesh(x, y, W, H);
}
