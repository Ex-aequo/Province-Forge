// Graph clustering of cells into compact, size-balanced regions.
// Multi-source weighted Dijkstra growth (a graph "power diagram") with iterative
// re-centering and per-region weights, followed by merge/split to enforce size limits.
// Growth from seeds guarantees every region is connected.
import { MinHeap } from './heap';
import type { Mesh } from './mesh';
import { dxWrap, wrapX } from './mesh';
import type { Rng } from './rng';

export interface ClusterOptions {
  k: number;
  /** Regions smaller than this many cells are merged away. */
  minCells: number;
  /** Extra edge cost multiplier between two cells (e.g. elevation change). Default 1. */
  edgeCost?: (a: number, b: number) => number;
  iterations?: number;
}

/** Euclidean distance between cell sites on the cylinder. */
function siteDist(mesh: Mesh, a: number, b: number) {
  const dx = dxWrap(mesh.x[a], mesh.x[b], mesh.W), dy = mesh.y[b] - mesh.y[a];
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Cluster one connected set of cells into ~k regions.
 * Returns local region index per cell of `cells` (same order).
 */
export function clusterCells(mesh: Mesh, cells: number[], opt: ClusterOptions, rng: Rng): Int32Array {
  const m = cells.length;
  const k = Math.max(1, Math.min(opt.k, m));
  const local = new Map<number, number>();
  cells.forEach((c, i) => local.set(c, i));
  const nb: Int32Array[] = cells.map((c) => Int32Array.from(Array.from(mesh.nbrs[c]).map((j) => local.get(j) ?? -1).filter((j) => j >= 0)));
  const cost: Float64Array[] = cells.map((c, i) =>
    Float64Array.from(nb[i], (j) => siteDist(mesh, c, cells[j]) * (opt.edgeCost ? opt.edgeCost(c, cells[j]) : 1)),
  );
  const assign = new Int32Array(m);
  if (k === 1) return assign;

  // --- seeds: k-means++ style (D² sampling on euclidean distance)
  const seeds: number[] = [Math.floor(rng() * m)];
  const d2 = new Float64Array(m).fill(Infinity);
  const updateD2 = (s: number) => {
    for (let i = 0; i < m; i++) {
      const d = siteDist(mesh, cells[s], cells[i]);
      if (d * d < d2[i]) d2[i] = d * d;
    }
  };
  updateD2(seeds[0]);
  while (seeds.length < k) {
    let total = 0;
    for (let i = 0; i < m; i++) total += d2[i];
    let r = rng() * total, pick = m - 1;
    for (let i = 0; i < m; i++) { r -= d2[i]; if (r <= 0) { pick = i; break; } }
    seeds.push(pick);
    updateD2(pick);
  }

  const weight = new Float64Array(k).fill(1);
  const dist = new Float64Array(m);
  const heap = new MinHeap();
  const target = m / k;

  const grow = (seedList: number[], w: Float64Array, out: Int32Array, allowed?: Uint8Array) => {
    dist.fill(Infinity);
    out.fill(-1);
    seedList.forEach((s, r) => { dist[s] = 0; out[s] = r; heap.push(0, s); });
    while (heap.size) {
      const i = heap.pop();
      const di = heap.lastKey;
      if (di > dist[i]) continue;
      const r = out[i];
      const ni = nb[i], ci = cost[i];
      for (let t = 0; t < ni.length; t++) {
        const j = ni[t];
        if (allowed && !allowed[j]) continue;
        const nd = di + ci[t] * w[r];
        if (nd < dist[j]) { dist[j] = nd; out[j] = r; heap.push(nd, j); }
      }
    }
  };

  const iterations = opt.iterations ?? 10;
  for (let it = 0; it < iterations; it++) {
    grow(seeds, weight, assign);
    // sizes + wrap-aware centroids (relative to the seed)
    const size = new Float64Array(k), sx = new Float64Array(k), sy = new Float64Array(k);
    for (let i = 0; i < m; i++) {
      const r = assign[i];
      if (r < 0) continue;
      const s = cells[seeds[r]];
      size[r]++;
      sx[r] += dxWrap(mesh.x[s], mesh.x[cells[i]], mesh.W);
      sy[r] += mesh.y[cells[i]];
    }
    // move each seed to the member cell closest to the centroid
    const best = new Float64Array(k).fill(Infinity);
    const newSeeds = seeds.slice();
    for (let i = 0; i < m; i++) {
      const r = assign[i];
      if (r < 0 || size[r] === 0) continue;
      const s = cells[seeds[r]];
      const cx = wrapX(mesh.x[s] + sx[r] / size[r], mesh.W), cy = sy[r] / size[r];
      const dx = dxWrap(cx, mesh.x[cells[i]], mesh.W), dy = mesh.y[cells[i]] - cy;
      const d = dx * dx + dy * dy;
      if (d < best[r]) { best[r] = d; newSeeds[r] = i; }
    }
    for (let r = 0; r < k; r++) {
      seeds[r] = newSeeds[r];
      // big regions get more expensive to grow into, small ones cheaper
      const ratio = Math.max(size[r], 1) / target;
      weight[r] = Math.min(4, Math.max(0.25, weight[r] * Math.pow(ratio, 0.35)));
    }
  }
  grow(seeds, weight, assign);
  for (let i = 0; i < m; i++) if (assign[i] < 0) assign[i] = 0; // unreachable safety

  enforceSizes(nb, cost, assign, k, opt.minCells, mesh, cells);
  return assign;
}

/** Merge regions below minCells into a neighbour, then split the largest to restore k. */
function enforceSizes(nb: Int32Array[], cost: Float64Array[], assign: Int32Array, k: number, minCells: number, mesh: Mesh, cells: number[]) {
  const m = assign.length;
  const members = (): number[][] => {
    const out: number[][] = Array.from({ length: k }, () => []);
    for (let i = 0; i < m; i++) out[assign[i]].push(i);
    return out;
  };
  for (let guard = 0; guard < k * 3; guard++) {
    const mem = members();
    let changed = false;
    // 1) merge the smallest undersized region
    let small = -1;
    for (let r = 0; r < k; r++) if (mem[r].length > 0 && mem[r].length < minCells && (small < 0 || mem[r].length < mem[small].length)) small = r;
    if (small >= 0) {
      const touch = new Map<number, number>();
      for (const i of mem[small]) for (const j of nb[i]) if (assign[j] !== small) touch.set(assign[j], (touch.get(assign[j]) ?? 0) + 1);
      let into = -1;
      for (const [r] of touch) if (into < 0 || mem[r].length < mem[into].length) into = r;
      if (into >= 0) { for (const i of mem[small]) assign[i] = into; changed = true; }
    }
    // 2) split the largest region into any empty slot
    const mem2 = changed ? members() : mem;
    const empty = mem2.findIndex((x) => x.length === 0);
    if (empty >= 0) {
      let big = 0;
      for (let r = 1; r < k; r++) if (mem2[r].length > mem2[big].length) big = r;
      if (mem2[big].length >= minCells * 2) {
        splitRegion(nb, cost, assign, mem2[big], big, empty, mesh, cells);
        changed = true;
      }
    }
    if (!changed) break;
  }
}

/** Split one region in two using its two mutually-far cells as seeds. */
function splitRegion(nb: Int32Array[], cost: Float64Array[], assign: Int32Array, mem: number[], from: number, to: number, mesh: Mesh, cells: number[]) {
  const inside = new Set(mem);
  const far = (src: number) => {
    let best = src, bd = -1;
    for (const i of mem) {
      const dx = dxWrap(mesh.x[cells[src]], mesh.x[cells[i]], mesh.W), dy = mesh.y[cells[i]] - mesh.y[cells[src]];
      const d = dx * dx + dy * dy;
      if (d > bd) { bd = d; best = i; }
    }
    return best;
  };
  const a = far(mem[0]);
  const b = far(a);
  const dist = new Map<number, number>();
  const heap = new MinHeap();
  dist.set(a, 0); dist.set(b, 0);
  assign[a] = from; assign[b] = to;
  heap.push(0, a); heap.push(0, b);
  while (heap.size) {
    const i = heap.pop();
    const di = heap.lastKey;
    if (di > (dist.get(i) ?? Infinity)) continue;
    for (let t = 0; t < nb[i].length; t++) {
      const j = nb[i][t];
      if (!inside.has(j)) continue;
      const nd = di + cost[i][t];
      if (nd < (dist.get(j) ?? Infinity)) { dist.set(j, nd); assign[j] = assign[i]; heap.push(nd, j); }
    }
  }
}
