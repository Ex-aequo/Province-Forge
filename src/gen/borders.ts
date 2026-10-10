// Topological border extraction: every boundary between two regions becomes exactly
// one chain (junction to junction), which is displaced + smoothed ONCE and then shared
// by both neighbours' polygons. This is what guarantees no gaps or overlaps between
// provinces however much the borders are smoothed.
import type { Mesh } from './mesh';
import { wrapX } from './mesh';
import type { Rng } from './rng';
import { edgeKey } from './hydrology';
import type { BorderChain, BorderKind, GenParams, Region } from './types';

interface Edge { ra: number; rb: number; ka: number; kb: number; ax: number; ay: number; bx: number; by: number; river: boolean }

export interface BorderResult {
  borders: BorderChain[];
  ringFailures: number;
}

export function buildBorders(mesh: Mesh, cellRegion: Int32Array, regions: Region[], riverEdges: Set<number>, p: GenParams, rng: Rng): BorderResult {
  const { W, n } = mesh;
  const KX = Math.round(W * 100);
  const vkey = (x: number, y: number) => {
    const kx = ((Math.round(wrapX(x, W) * 100) % KX) + KX) % KX;
    return kx * 4194304 + Math.round(y * 100);
  };

  // ---- 1. unique boundary edges in a canonical frame (midpoint x in [0, W))
  const edges: Edge[] = [];
  for (let i = 0; i < n; i++) {
    const ri = cellRegion[i];
    for (const e of mesh.edges[i]) {
      const rj = e.n >= 0 ? cellRegion[e.n] : -1;
      if (e.n >= 0 && (rj === ri || e.n < i)) continue;
      const shift = Math.floor((e.ax + e.bx) / 2 / W) * W;
      const ax = e.ax - shift, bx = e.bx - shift;
      const ka = vkey(ax, e.ay), kb = vkey(bx, e.by);
      if (ka === kb) continue; // sub-0.01 edge: its two vertices collapse to one key
      edges.push({ ra: ri, rb: rj, ka, kb, ax, ay: e.ay, bx, by: e.by, river: e.n >= 0 && riverEdges.has(edgeKey(i, e.n, n)) });
    }
  }

  // ---- 2. vertex incidence
  const inc = new Map<number, number[]>();
  edges.forEach((e, idx) => {
    (inc.get(e.ka) ?? inc.set(e.ka, []).get(e.ka)!).push(idx);
    (inc.get(e.kb) ?? inc.set(e.kb, []).get(e.kb)!).push(idx);
  });
  const isJunction = (k: number) => inc.get(k)!.length !== 2;

  // ---- 3. walk chains
  const used = new Uint8Array(edges.length);
  interface RawChain { ra: number; rb: number; start: number; end: number; closed: boolean; pts: number[]; river: boolean[] }
  const raw: RawChain[] = [];
  const walk = (startKey: number, firstEdge: number, closedLoop: boolean) => {
    const e0 = edges[firstEdge];
    const fromA = e0.ka === startKey;
    const pts = fromA ? [e0.ax, e0.ay] : [e0.bx, e0.by];
    const river: boolean[] = [];
    let cur = startKey, ei = firstEdge;
    while (true) {
      used[ei] = 1;
      const e = edges[ei];
      river.push(e.river);
      const forward = e.ka === cur;
      const nx = forward ? e.bx : e.ax, ny = forward ? e.by : e.ay;
      const sx = forward ? e.ax : e.bx; // start of this edge in its own frame
      const lastX = pts[pts.length - 2];
      // unwrap: shift the edge so it continues from the previous point
      const shift = Math.round((lastX - sx) / W) * W;
      pts.push(nx + shift, ny);
      cur = forward ? e.kb : e.ka;
      if (cur === startKey && closedLoop) break;
      if (!closedLoop && isJunction(cur)) break;
      const nextEdges = inc.get(cur)!;
      const ne = nextEdges.find((x) => !used[x]);
      if (ne === undefined) break;
      ei = ne;
    }
    raw.push({ ra: e0.ra, rb: e0.rb, start: startKey, end: cur, closed: closedLoop, pts, river });
  };
  for (const [k, list] of inc) {
    if (list.length === 2) continue;
    for (const ei of list) if (!used[ei]) walk(k, ei, false);
  }
  for (let ei = 0; ei < edges.length; ei++) if (!used[ei]) walk(edges[ei].ka, ei, true);

  // ---- 4. displace + smooth each chain once
  const borders: BorderChain[] = raw.map((c) => {
    const a = c.ra, b = c.rb;
    const ka = regions[a].kind, kb = b < 0 ? null : regions[b].kind;
    const kind: BorderKind = kb === null ? 'edge'
      : ka === 'ice' && kb === 'ice' ? 'iceInner'
      : ka === 'ice' || kb === 'ice' ? 'ice'
      : ka === 'lake' || kb === 'lake' ? 'lakeshore'
      : ka !== kb ? 'coast'
      : ka === 'land' ? 'land' : 'sea';
    const amp = p.borderDetail * ({ coast: 1, lakeshore: 0.8, ice: 0.8, land: 0.7, sea: 0.4, iceInner: 0, edge: 0 } as Record<BorderKind, number>)[kind];
    let pts = c.pts;
    // river segments stay undisplaced so the drawn river and the border coincide
    if (amp > 0) pts = displace(pts, c.river, amp, rng);
    for (let s = 0; s < p.borderSmoothing; s++) pts = chaikin(pts, c.closed);
    return { a: b < 0 ? a : Math.min(a, b), b: b < 0 ? -1 : Math.max(a, b), kind, closed: c.closed, pts: roundPts(pts), _start: c.start, _end: c.end } as BorderChain & { _start: number; _end: number };
  });

  // ---- 5. assemble region rings from the shared chains
  const perRegion = new Map<number, number[]>();
  borders.forEach((b, i) => {
    for (const r of [b.a, b.b]) if (r >= 0) (perRegion.get(r) ?? perRegion.set(r, []).get(r)!).push(i);
  });
  let ringFailures = 0;
  for (const region of regions) {
    region.rings = [];
    const list = perRegion.get(region.id) ?? [];
    const byKey = new Map<number, number[]>();
    for (const ci of list) {
      const c = borders[ci] as BorderChain & { _start: number; _end: number };
      if (c.closed) { region.rings.push(c.pts.slice()); continue; }
      (byKey.get(c._start) ?? byKey.set(c._start, []).get(c._start)!).push(ci);
      (byKey.get(c._end) ?? byKey.set(c._end, []).get(c._end)!).push(ci);
    }
    const done = new Set<number>();
    for (const ci of list) {
      const c0 = borders[ci] as BorderChain & { _start: number; _end: number };
      if (c0.closed || done.has(ci)) continue;
      done.add(ci);
      const ring = c0.pts.slice();
      const startKey = c0._start;
      let cur = c0._end;
      let guard = 0;
      while (cur !== startKey && guard++ < 10000) {
        const next = (byKey.get(cur) ?? []).find((x) => !done.has(x));
        if (next === undefined) { ringFailures++; break; }
        done.add(next);
        const c = borders[next] as BorderChain & { _start: number; _end: number };
        const fwd = c._start === cur;
        const src = fwd ? c.pts : reversePts(c.pts);
        const shift = Math.round((ring[ring.length - 2] - src[0]) / W) * W;
        for (let t = 2; t < src.length; t += 2) ring.push(src[t] + shift, src[t + 1]);
        cur = fwd ? c._end : c._start;
      }
      region.rings.push(ring);
    }
  }
  for (const b of borders) { delete (b as any)._start; delete (b as any)._end; }
  return { borders, ringFailures };
}

function reversePts(p: number[]): number[] {
  const out: number[] = new Array(p.length);
  for (let i = 0, j = p.length - 2; j >= 0; i += 2, j -= 2) { out[i] = p[j]; out[i + 1] = p[j + 1]; }
  return out;
}

function roundPts(p: number[]): number[] {
  return p.map((v) => Math.round(v * 10) / 10);
}

/** Midpoint displacement (one level) perpendicular to each segment — "noisy edges". */
function displace(p: number[], river: boolean[], amp: number, rng: Rng): number[] {
  const out: number[] = [p[0], p[1]];
  const segs = p.length / 2 - 1;
  for (let s = 0; s < segs; s++) {
    const ax = p[2 * s], ay = p[2 * s + 1], bx = p[2 * s + 2], by = p[2 * s + 3];
    const dx = bx - ax, dy = by - ay;
    const r = rng(); // always draw, so the random stream doesn't depend on rivers
    const off = river[s] ? 0 : (r - 0.5) * amp * 0.5; // fraction of segment length
    out.push((ax + bx) / 2 - dy * off, (ay + by) / 2 + dx * off, bx, by);
  }
  return out;
}

/** Chaikin corner cutting. Open chains keep their endpoints fixed (junctions). */
function chaikin(p: number[], closed: boolean): number[] {
  const m = p.length / 2;
  if (m < 3) return p;
  const out: number[] = [];
  if (!closed) out.push(p[0], p[1]);
  const segs = closed ? m - 1 : m - 1; // closed chains repeat the first point at the end
  for (let s = 0; s < segs; s++) {
    const ax = p[2 * s], ay = p[2 * s + 1], bx = p[2 * s + 2], by = p[2 * s + 3];
    out.push(0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by, 0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by);
  }
  if (closed) out.push(out[0], out[1]);
  else out.push(p[2 * m - 2], p[2 * m - 1]);
  return out;
}
