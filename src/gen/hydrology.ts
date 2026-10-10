// Hydrology: inland lakes, polar ice, and rivers.
//
// Rivers run along Voronoi EDGES (between two cells), from corner to corner, so a river
// can be a province border — the same way EU4 rivers often are. The corner graph is
// flooded from the sea with a priority queue ("priority-flood"), which fills every
// depression and gives each land corner a guaranteed downhill path to the sea.
import { createNoise3D } from 'simplex-noise';
import { MinHeap } from './heap';
import type { Mesh } from './mesh';
import { wrapX } from './mesh';
import { components, hopsToCoast } from './elevation';
import type { Rng } from './rng';
import { CT, type GenParams, type River } from './types';

export interface Corners {
  n: number;
  x: Float64Array; // canonical (wrapped) position
  y: Float64Array;
  /** Adjacent cells (usually 3). */
  cells: number[][];
  /** Adjacent corners, with the two cells on either side of each connecting edge. */
  links: { c: number; a: number; b: number }[][];
}

/** Build the Voronoi corner graph (wrap-aware, corners deduplicated across the seam). */
export function buildCorners(mesh: Mesh): Corners {
  const { W } = mesh;
  const KX = Math.round(W * 100);
  const key = (x: number, y: number) => (((Math.round(wrapX(x, W) * 100) % KX) + KX) % KX) * 4194304 + Math.round(y * 100);
  const index = new Map<number, number>();
  const xs: number[] = [], ys: number[] = [];
  const cells: number[][] = [];
  const links: { c: number; a: number; b: number }[][] = [];
  const id = (x: number, y: number) => {
    const k = key(x, y);
    let i = index.get(k);
    if (i === undefined) {
      i = xs.length;
      index.set(k, i);
      xs.push(wrapX(x, W)); ys.push(y);
      cells.push([]); links.push([]);
    }
    return i;
  };
  for (let i = 0; i < mesh.n; i++) {
    for (const e of mesh.edges[i]) {
      const ca = id(e.ax, e.ay), cb = id(e.bx, e.by);
      if (ca === cb) continue;
      if (!cells[ca].includes(i)) cells[ca].push(i);
      if (!cells[cb].includes(i)) cells[cb].push(i);
      // each shared edge is seen from both cells; record it once
      if (e.n >= 0 && e.n < i) continue;
      links[ca].push({ c: cb, a: i, b: e.n });
      links[cb].push({ c: ca, a: i, b: e.n });
    }
  }
  return { n: xs.length, x: Float64Array.from(xs), y: Float64Array.from(ys), cells, links };
}

export interface HydrologyResult {
  cellType: Uint8Array;
  corners: Corners;
  /** Set of river edges between cells, keyed min*n+max. */
  riverEdges: Set<number>;
  /** Accumulated flow per corner (for moisture). */
  flux: Float64Array;
  riverThreshold: number;
  rivers: River[];
  lakes: number;
}

export const edgeKey = (a: number, b: number, n: number) => (a < b ? a * n + b : b * n + a);

export function generateHydrology(mesh: Mesh, land: Uint8Array, elevation: Float64Array, p: GenParams, rng: Rng): HydrologyResult {
  const n = mesh.n, W = mesh.W, H = mesh.H;
  const cellType = new Uint8Array(n);
  for (let i = 0; i < n; i++) cellType[i] = land[i] ? CT.Land : CT.Sea;

  // ---------------- polar ice: sea cells near the poles, with a ragged edge
  const noise = createNoise3D(rng);
  const R = W / (2 * Math.PI);
  const iceH = p.polarIce * H;
  if (iceH > 0) {
    for (let i = 0; i < n; i++) {
      if (cellType[i] !== CT.Sea) continue;
      const th = (2 * Math.PI * mesh.x[i]) / W;
      const f = 3 / H;
      const wob = noise(Math.cos(th) * R * f, mesh.y[i] * f, Math.sin(th) * R * f);
      const edge = Math.min(mesh.y[i], H - mesh.y[i]);
      if (edge < iceH * (1 + 0.45 * wob)) cellType[i] = CT.Ice;
    }
    // sea pockets cut off by the ice become ice too (they would be unreachable)
    const seaMask = new Uint8Array(n);
    for (let i = 0; i < n; i++) seaMask[i] = cellType[i] === CT.Sea ? 1 : 0;
    const seas = components(mesh, seaMask, 1).sort((a, b) => b.length - a.length);
    for (let s = 1; s < seas.length; s++) {
      const touchesLand = seas[s].some((c) => Array.from(mesh.nbrs[c]).some((j) => cellType[j] === CT.Land));
      if (!touchesLand) for (const c of seas[s]) cellType[c] = CT.Ice;
    }
  }

  // ---------------- lakes: grown from low inland seeds, never splitting a landmass
  const coastDist = hopsToCoast(mesh, land);
  let lakes = 0;
  const avgLake = Math.max(4, Math.round((mesh.n / 24000) * 9));
  const candidates: number[] = [];
  for (let i = 0; i < n; i++) if (land[i] && coastDist[i] >= 4 && elevation[i] < 0.55) candidates.push(i);
  // shuffle deterministically
  for (let i = candidates.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [candidates[i], candidates[j]] = [candidates[j], candidates[i]]; }
  const nearLake = (i: number) => Array.from(mesh.nbrs[i]).some((j) => cellType[j] === CT.Lake || Array.from(mesh.nbrs[j]).some((k) => cellType[k] === CT.Lake));
  for (const seed of candidates) {
    if (lakes >= p.lakeCount) break;
    if (cellType[seed] !== CT.Land || nearLake(seed)) continue;
    const target = Math.max(3, Math.round(avgLake * (0.55 + rng() * 0.9)));
    const lake: number[] = [];
    const heap = new MinHeap();
    const seen = new Set<number>([seed]);
    heap.push(elevation[seed], seed);
    while (heap.size && lake.length < target) {
      const c = heap.pop();
      if (cellType[c] !== CT.Land || coastDist[c] < 3 || nearLake(c)) continue;
      lake.push(c);
      for (const j of mesh.nbrs[c]) if (!seen.has(j)) { seen.add(j); heap.push(elevation[j] + rng() * 0.02, j); }
    }
    if (lake.length < 3) continue;
    // reject lakes that would split their landmass
    const before = landComponentsAround(mesh, cellType, lake);
    for (const c of lake) cellType[c] = CT.Lake;
    const after = landComponentsAround(mesh, cellType, lake);
    if (after > before) { for (const c of lake) cellType[c] = CT.Land; continue; }
    lakes++;
  }

  // ---------------- rivers
  const corners = buildCorners(mesh);
  const nc = corners.n;
  const cElev = new Float64Array(nc);
  const isMouth = new Uint8Array(nc); // touches sea or ice → rivers end here
  const isLand = new Uint8Array(nc);  // every adjacent cell is land or lake
  for (let c = 0; c < nc; c++) {
    let s = 0, mouth = false, allLand = true;
    for (const i of corners.cells[c]) {
      s += cellType[i] === CT.Lake ? Math.min(elevation[i], 0.05) : elevation[i];
      if (cellType[i] === CT.Sea || cellType[i] === CT.Ice) mouth = true;
      if (cellType[i] !== CT.Land && cellType[i] !== CT.Lake) allLand = false;
    }
    cElev[c] = s / Math.max(1, corners.cells[c].length);
    isMouth[c] = mouth ? 1 : 0;
    isLand[c] = allLand ? 1 : 0;
  }

  // priority-flood from every mouth: assigns each land corner a downstream corner
  const down = new Int32Array(nc).fill(-1);
  const filled = new Float64Array(nc).fill(Infinity);
  const order: number[] = [];
  const heap = new MinHeap();
  for (let c = 0; c < nc; c++) if (isMouth[c]) { filled[c] = cElev[c]; heap.push(cElev[c], c); }
  const done = new Uint8Array(nc);
  while (heap.size) {
    const c = heap.pop();
    if (done[c]) continue;
    done[c] = 1;
    order.push(c);
    for (const l of corners.links[c]) {
      const d = l.c;
      if (done[d] || isMouth[d] || !isLand[d]) continue;
      // tiny random tie-break avoids parallel straight channels on flat ground
      const e = Math.max(cElev[d], filled[c] + 1e-5 + rng() * 1e-5);
      if (e < filled[d]) { filled[d] = e; down[d] = c; heap.push(e, d); }
    }
  }

  // rainfall → flux, accumulated from the top of each basin down
  const rainNoise = createNoise3D(rng);
  const flux = new Float64Array(nc);
  for (let c = 0; c < nc; c++) {
    if (!isLand[c]) continue;
    const th = (2 * Math.PI * corners.x[c]) / W, f = 4 / H;
    const wet = 0.5 + 0.5 * rainNoise(Math.cos(th) * R * f, corners.y[c] * f, Math.sin(th) * R * f);
    const lat = Math.abs(corners.y[c] - H / 2) / (H / 2);
    flux[c] = 0.4 + wet + 0.3 * (1 - lat); // wetter tropics
  }
  for (let k = order.length - 1; k >= 0; k--) {
    const c = order[k];
    if (down[c] >= 0) flux[down[c]] += flux[c];
  }

  // threshold so that ~riverDensity of land cells border a river
  let landCells = 0;
  for (let i = 0; i < n; i++) if (cellType[i] === CT.Land) landCells++;
  const landFlux: number[] = [];
  for (let c = 0; c < nc; c++) if (isLand[c] && down[c] >= 0) landFlux.push(flux[c]);
  landFlux.sort((a, b) => b - a);
  const wantEdges = Math.max(1, Math.round(landCells * p.riverDensity));
  const threshold = landFlux[Math.min(landFlux.length - 1, wantEdges)] ?? Infinity;

  const riverEdges = new Set<number>();
  const cellPair = (c: number, d: number) => corners.links[c].find((l) => l.c === d)!;
  const isRiverCorner = (c: number) => isLand[c] === 1 && down[c] >= 0 && flux[c] >= threshold;
  for (let c = 0; c < nc; c++) {
    if (!isRiverCorner(c)) continue;
    const l = cellPair(c, down[c]);
    if (l.b < 0) continue;
    const lakeInside = cellType[l.a] === CT.Lake && cellType[l.b] === CT.Lake;
    if (!lakeInside) riverEdges.add(edgeKey(l.a, l.b, n));
  }

  const rivers = traceRivers(corners, down, flux, threshold, isRiverCorner, cellType, cellPair, W, p);
  return { cellType, corners, riverEdges, flux, riverThreshold: threshold, rivers, lakes };
}

function landComponentsAround(mesh: Mesh, cellType: Uint8Array, cells: number[]) {
  // count land components among the land cells adjacent to `cells` (local check)
  const ring = new Set<number>();
  for (const c of cells) for (const j of mesh.nbrs[c]) if (cellType[j] === CT.Land) ring.add(j);
  const seen = new Set<number>();
  let comps = 0;
  for (const s of ring) {
    if (seen.has(s)) continue;
    comps++;
    // flood through land, limited radius, to see whether ring cells reconnect
    const q = [s];
    seen.add(s);
    const local = new Set<number>([s]);
    for (let h = 0; h < q.length && local.size < 4000; h++) {
      for (const j of mesh.nbrs[q[h]]) if (cellType[j] === CT.Land && !local.has(j)) { local.add(j); q.push(j); if (ring.has(j)) seen.add(j); }
    }
  }
  return comps;
}

/** Turn river corners into smoothed, tapered polylines. Tributaries end ON their main stem. */
function traceRivers(
  corners: Corners, down: Int32Array, flux: Float64Array, threshold: number,
  isRiverCorner: (c: number) => boolean, cellType: Uint8Array,
  cellPair: (c: number, d: number) => { a: number; b: number },
  W: number, p: GenParams,
): River[] {
  const nc = corners.n;
  const hasUp = new Uint8Array(nc);
  for (let c = 0; c < nc; c++) if (isRiverCorner(c)) hasUp[down[c]] = 1;
  const heads: number[] = [];
  for (let c = 0; c < nc; c++) if (isRiverCorner(c) && !hasUp[c]) heads.push(c);
  // long rivers first so tributaries can attach to an existing stem
  const pathLen = (c: number) => { let k = 0; while (c >= 0 && k < 100000) { c = down[c]; k++; } return k; };
  heads.sort((a, b) => pathLen(b) - pathLen(a));

  const owner = new Int32Array(nc).fill(-1); // corner → polyline index
  const raw: { cs: number[] }[] = [];
  for (const h of heads) {
    const cs = [h];
    let c = h;
    while (true) {
      const d = down[c];
      if (d < 0) break;
      cs.push(d);
      if (owner[d] >= 0 || !isRiverCorner(d)) break; // confluence or mouth
      c = d;
    }
    const idx = raw.length;
    for (const c2 of cs) if (owner[c2] < 0) owner[c2] = idx;
    raw.push({ cs });
  }

  let maxFlux = 0;
  for (let c = 0; c < nc; c++) if (isRiverCorner(c)) maxFlux = Math.max(maxFlux, flux[c]);
  const width = (f: number) => 0.9 + 3.6 * Math.sqrt(Math.max(0, f - threshold) / Math.max(1e-9, maxFlux - threshold));

  // build unwrapped points, split where the river runs inside a lake
  const out: River[] = [];
  const stem: number[][] = new Array(raw.length);      // all smoothed points of each polyline
  const lastPiece = new Int32Array(raw.length).fill(-1);
  raw.forEach((r, ri) => {
    const segs: { pts: number[]; ws: number[] }[] = [];
    let cur: { pts: number[]; ws: number[] } | null = null;
    let lastX = NaN;
    for (let k = 0; k < r.cs.length; k++) {
      const c = r.cs[k];
      let x = corners.x[c];
      if (!Number.isNaN(lastX)) x += Math.round((lastX - x) / W) * W;
      lastX = x;
      if (k > 0) {
        const l = cellPair(r.cs[k - 1], c);
        if (cellType[l.a] === CT.Lake && cellType[l.b] === CT.Lake) { cur = null; continue; }
      }
      if (!cur) {
        cur = { pts: [], ws: [] };
        segs.push(cur);
        // a piece resuming after a lake starts at the lake's outflow corner
        if (k > 0) { cur.pts.push(lastX, corners.y[c]); cur.ws.push(width(flux[r.cs[k - 1]])); continue; }
      }
      cur.pts.push(x, corners.y[c]);
      cur.ws.push(width(flux[r.cs[Math.max(0, k - 1)]]));
    }
    const all: number[] = [];
    for (const sg of segs) {
      if (sg.pts.length < 4) continue;
      let pts = sg.pts, ws = sg.ws;
      for (let it = 0; it < p.borderSmoothing; it++) ({ pts, ws } = chaikinW(pts, ws));
      out.push({ id: ri, pts, widths: ws });
      lastPiece[ri] = out.length - 1;
      for (const v of pts) all.push(v);
    }
    stem[ri] = all;
  });

  // snap each tributary's mouth onto the smoothed stem it flows into
  raw.forEach((r, ri) => {
    const into = owner[r.cs[r.cs.length - 1]];
    if (into < 0 || into === ri || lastPiece[ri] < 0) return;
    const sp = stem[into];
    if (!sp || !sp.length) return;
    const rv = out[lastPiece[ri]];
    const lx = rv.pts[rv.pts.length - 2], ly = rv.pts[rv.pts.length - 1];
    let best = -1, bd = Infinity;
    for (let i = 0; i < sp.length; i += 2) {
      const sx = sp[i] + Math.round((lx - sp[i]) / W) * W;
      const d = (sx - lx) ** 2 + (sp[i + 1] - ly) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0 && bd < 900) {
      rv.pts[rv.pts.length - 2] = sp[best] + Math.round((lx - sp[best]) / W) * W;
      rv.pts[rv.pts.length - 1] = sp[best + 1];
    }
  });
  return out.filter((r) => r.pts.length >= 4);
}

function chaikinW(p: number[], w: number[]): { pts: number[]; ws: number[] } {
  const m = p.length / 2;
  if (m < 3) return { pts: p, ws: w };
  const pts: number[] = [p[0], p[1]], ws: number[] = [w[0]];
  for (let s = 0; s < m - 1; s++) {
    const ax = p[2 * s], ay = p[2 * s + 1], bx = p[2 * s + 2], by = p[2 * s + 3];
    pts.push(0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by, 0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by);
    ws.push(0.75 * w[s] + 0.25 * w[s + 1], 0.25 * w[s] + 0.75 * w[s + 1]);
  }
  pts.push(p[2 * m - 2], p[2 * m - 1]);
  ws.push(w[m - 1]);
  return { pts, ws };
}
