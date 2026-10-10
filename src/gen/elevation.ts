// Elevation: three warped continent shapes + scattered islands + wrapped fBm noise,
// sea level chosen to hit the target land fraction, then cleanup of specks and lakes.
import { createNoise3D } from 'simplex-noise';
import type { Rng } from './rng';
import { range } from './rng';
import type { Mesh } from './mesh';
import { dxWrap, wrapX } from './mesh';
import type { GenParams } from './types';

type Noise3 = (x: number, y: number, z: number) => number;

/** Noise sampler that tiles seamlessly in x by mapping x onto a circle. */
function wrappedFbm(noise: Noise3, W: number) {
  const R = W / (2 * Math.PI);
  return (x: number, y: number, freq: number, octaves: number, gain = 0.5) => {
    const th = (2 * Math.PI * x) / W;
    const cx = Math.cos(th) * R, cz = Math.sin(th) * R;
    let amp = 1, f = freq, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * noise(cx * f, y * f, cz * f);
      norm += amp;
      amp *= gain;
      f *= 2.03;
    }
    return sum / norm;
  };
}

interface Blob { x: number; y: number; rx: number; ry: number; rot: number; strength: number }

export interface ElevationResult {
  /** −1..0 water, 0..1 land. */
  elevation: Float64Array;
  land: Uint8Array;
  /** Which continent (0..2) or island (3+) generated each cell. */
  owner: Int32Array;
}

export function generateElevation(mesh: Mesh, p: GenParams, rng: Rng): ElevationResult {
  const { n, W, H } = mesh;
  const fbm = wrappedFbm(createNoise3D(rng), W);
  const warpX = wrappedFbm(createNoise3D(rng), W);
  const warpY = wrappedFbm(createNoise3D(rng), W);
  const ridgeN = wrappedFbm(createNoise3D(rng), W);
  const A = W * H;

  // --- continents: evenly spread in longitude, jittered latitude.
  // Each continent is a main body plus 2–4 lobes (peninsulas, gulfs). Lobes are stored
  // relative to the continent centre so the whole continent can be scaled for balance.
  const sizes = p.continentSizes;
  const sizeSum = sizes[0] + sizes[1] + sizes[2];
  const continentLand = A * p.landFraction * 0.86; // remainder goes to islands / noise
  const offset = rng() * W;
  const maxRy = H * (0.5 - p.polarMargin) * 0.8;
  interface Part { c: number; ox: number; oy: number; rx: number; ry: number; rot: number; strength: number }
  const parts: Part[] = [];
  const centres: { x: number; y: number; r: number }[] = [];
  for (let c = 0; c < 3; c++) {
    const r = Math.sqrt((continentLand * sizes[c]) / sizeSum / Math.PI);
    const cx = wrapX(offset + (c * W) / 3 + range(rng, -0.05, 0.05) * W, W);
    const cy = H * (0.5 + range(rng, -0.07, 0.07));
    centres.push({ x: cx, y: cy, r });
    const aspect = range(rng, 0.7, 1.45);
    const main = r * 0.7;
    parts.push({ c, ox: 0, oy: 0, rx: main * Math.sqrt(aspect), ry: main / Math.sqrt(aspect), rot: range(rng, -0.6, 0.6), strength: 1 });
    const lobes = 2 + Math.floor(rng() * 3);
    for (let l = 0; l < lobes; l++) {
      const ang = rng() * Math.PI * 2;
      const dist = main * range(rng, 0.75, 1.15);
      const lr = r * range(rng, 0.3, 0.5);
      const la = range(rng, 0.5, 2);
      parts.push({ c, ox: Math.cos(ang) * dist, oy: Math.sin(ang) * dist * 0.8, rx: lr * Math.sqrt(la), ry: lr / Math.sqrt(la), rot: ang + range(rng, -0.4, 0.4), strength: 0.95 });
    }
  }
  const nContinents = 3;
  // --- islands: small blobs placed away from continent cores
  const islandR = mesh.spacing * 2.6;
  const islands: Blob[] = [];
  for (let i = 0, tries = 0; i < p.islandCount && tries < p.islandCount * 40; tries++) {
    const x = rng() * W;
    const y = range(rng, H * (p.polarMargin + 0.06), H * (1 - p.polarMargin - 0.06));
    let ok = true;
    for (const c of centres) {
      const dx = dxWrap(c.x, x, W), dy = y - c.y;
      if (dx * dx + dy * dy < (c.r * 1.35) ** 2) { ok = false; break; }
    }
    if (!ok) continue;
    const s = range(rng, 0.7, 1.6);
    islands.push({ x, y, rx: islandR * s * range(rng, 0.8, 1.3), ry: islandR * s * range(rng, 0.8, 1.3), rot: rng() * Math.PI, strength: 0.75 });
    i++;
  }

  // --- per-cell terms that do not depend on continent scale (computed once)
  const rough = p.coastRoughness;
  const fWarp = 1 / (H * 0.2);
  const contWarp = H * 0.11 * rough;
  const islWarp = islandR * 0.6 * rough;
  const w1x = new Float64Array(n), w1y = new Float64Array(n), w2x = new Float64Array(n), w2y = new Float64Array(n);
  const detail = new Float64Array(n);
  const pm = p.polarMargin * H;
  for (let i = 0; i < n; i++) {
    const x = mesh.x[i], y = mesh.y[i];
    w1x[i] = warpX(x, y, fWarp, 4) * contWarp; w1y[i] = warpY(x, y, fWarp, 4) * contWarp;
    w2x[i] = warpX(x, y, fWarp * 6, 2) * islWarp; w2y[i] = warpY(x, y, fWarp * 6, 2) * islWarp;
    let d = 0.3 * rough * fbm(x, y, 1 / (H * 0.06), 5, 0.55); // bays, capes, inlets
    const edge = Math.min(y, H - y);
    if (edge < pm * 2) d -= 1.2 * Math.pow(1 - edge / (pm * 2), 2); // polar oceans
    detail[i] = d;
  }

  const raw = new Float64Array(n);
  const owner = new Int32Array(n); // 0..2 continent, 3+ island
  const evalBlob = (i: number, bx: number, by: number, rx: number, ry: number, rot: number, strength: number, wx: number, wy: number) => {
    const dx = dxWrap(bx, mesh.x[i] + wx, W), dy = mesh.y[i] + wy - by;
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const u = (dx * cs + dy * sn) / rx, v = (-dx * sn + dy * cs) / ry;
    return (1 - Math.sqrt(u * u + v * v)) * strength;
  };
  const computeRaw = (scale: number[]) => {
    const yLo = H * p.polarMargin * 2.2, yHi = H * (1 - p.polarMargin * 2.2);
    const placed = parts.map((pt) => {
      const s = scale[pt.c], c = centres[pt.c];
      return { c: pt.c, x: wrapX(c.x + pt.ox * s, W), y: Math.min(yHi, Math.max(yLo, c.y + pt.oy * s)), rx: pt.rx * s, ry: Math.min(pt.ry * s, maxRy), rot: pt.rot, strength: pt.strength };
    });
    for (let i = 0; i < n; i++) {
      let base = -1, own = 0;
      for (const b of placed) {
        const h = evalBlob(i, b.x, b.y, b.rx, b.ry, b.rot, b.strength, w1x[i], w1y[i]);
        if (h > base) { base = h; own = b.c; }
      }
      for (let k = 0; k < islands.length; k++) {
        const b = islands[k];
        const h = evalBlob(i, b.x, b.y, b.rx, b.ry, b.rot, b.strength, w2x[i], w2y[i]);
        if (h > base) { base = h; own = nContinents + k; }
      }
      raw[i] = base + detail[i];
      owner[i] = own;
    }
  };

  // --- sea level (area-weighted quantile) with some cells forced to water
  const target = A * (1 - p.landFraction);
  const land = new Uint8Array(n);
  const forced = new Uint8Array(n);
  let sea = 0;
  const threshold = () => {
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (forced[a] ? -Infinity : raw[a]) - (forced[b] ? -Infinity : raw[b]));
    let acc = 0;
    sea = raw[order[0]];
    for (const i of order) { acc += mesh.area[i]; if (acc >= target) { sea = forced[i] ? sea : raw[i]; break; } }
    for (let i = 0; i < n; i++) land[i] = !forced[i] && raw[i] > sea ? 1 : 0;
  };

  // --- straits: no continent's land may come within `minStraitCells` of another's.
  // Distances come from one snapshot and both sides are cut at once, so after the
  // final pass every remaining cell is guaranteed to be further than the minimum.
  // Islands within reach of two continents are cut too, or they would bridge them.
  const half = Math.max(1, p.minStraitCells);
  // 0–3 extra cells of strait, varying along the coast, so carved coasts aren't ruler-straight
  const jitter = new Int32Array(n);
  for (let i = 0; i < n; i++) jitter[i] = Math.max(0, Math.min(3, Math.round(1.5 + 2.2 * warpY(mesh.x[i], mesh.y[i], fWarp * 7, 2))));
  const eff = new Int32Array(n);
  const carveStraits = () => {
    // effective owner: island land that touches a continent is part of that continent
    eff.fill(-1);
    const q0: number[] = [];
    for (let i = 0; i < n; i++) if (land[i] && owner[i] < nContinents) { eff[i] = owner[i]; q0.push(i); }
    for (let h = 0; h < q0.length; h++) {
      const i = q0[h];
      for (const j of mesh.nbrs[i]) if (land[j] && eff[j] < 0) { eff[j] = eff[i]; q0.push(j); }
    }
    const dist: Int32Array[] = [];
    for (let c = 0; c < nContinents; c++) {
      const d = new Int32Array(n).fill(1 << 20);
      const q: number[] = [];
      for (let i = 0; i < n; i++) if (eff[i] === c) { d[i] = 0; q.push(i); }
      for (let h = 0; h < q.length; h++) {
        const i = q[h];
        if (d[i] >= half + 3) continue;
        for (const j of mesh.nbrs[i]) if (d[j] > d[i] + 1) { d[j] = d[i] + 1; q.push(j); }
      }
      dist.push(d);
    }
    let changed = 0;
    for (let i = 0; i < n; i++) {
      if (!land[i]) continue;
      const o = eff[i];
      let near = 0;
      for (let c = 0; c < nContinents; c++) if (c !== o && dist[c][i] <= half + jitter[i]) near++;
      if ((o >= 0 && near > 0) || (o < 0 && near > 1)) { forced[i] = 1; land[i] = 0; changed++; }
    }
    return changed;
  };
  const shapeLand = () => {
    forced.fill(0);
    for (let pass = 0; pass < 3; pass++) {
      threshold();
      if (!carveStraits()) break;
    }
    threshold(); // re-hit the land target after carving
    carveStraits();
  };

  // --- balance: scale each continent until its land matches its share (size sliders
  // are deliberate offsets from an equal split)
  const scale = [1, 1, 1];
  const shareTarget = sizes.map((s) => s / sizeSum);
  for (let it = 0; it < 6; it++) {
    computeRaw(scale);
    shapeLand();
    const cnt = [0, 0, 0];
    for (let i = 0; i < n; i++) if (land[i] && owner[i] < nContinents) cnt[owner[i]]++;
    const tot = cnt[0] + cnt[1] + cnt[2];
    let worst = 0;
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(cnt[c] / tot / shareTarget[c] - 1));
    if (worst < 0.03 || it === 5) break;
    for (let c = 0; c < 3; c++) {
      const ratio = (shareTarget[c] * tot) / Math.max(1, cnt[c]);
      scale[c] *= Math.min(1.25, Math.max(0.8, Math.pow(ratio, 0.6)));
    }
  }

  cleanup(mesh, land, p);

  // --- distance to coast (hops), used for shaping elevation and later stages
  const coastDist = hopsToCoast(mesh, land);

  // --- final elevation: land 0..1 (rises inland + ridged mountains), water −1..0
  let maxLand = 1e-9, minWater = -1e-9;
  const elev = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = mesh.x[i], y = mesh.y[i];
    if (land[i]) {
      const inland = Math.min(1, coastDist[i] / 6);
      const ridge = 1 - Math.abs(ridgeN(x, y, 7 / W * 2, 4));
      const e = Math.max(0.02, (raw[i] - sea) * 0.8 + inland * 0.25 + Math.pow(ridge, 3) * 0.55 * inland);
      elev[i] = e;
      if (e > maxLand) maxLand = e;
    } else {
      const e = Math.min(-0.02, raw[i] - sea - coastDist[i] * 0.03);
      elev[i] = e;
      if (e < minWater) minWater = e;
    }
  }
  for (let i = 0; i < n; i++) elev[i] = land[i] ? elev[i] / maxLand : -elev[i] / minWater;
  return { elevation: elev, land, owner };
}

/** BFS hop distance to the nearest cell of the opposite type (land↔water). */
export function hopsToCoast(mesh: Mesh, land: Uint8Array): Int32Array {
  const dist = new Int32Array(mesh.n).fill(-1);
  const q: number[] = [];
  for (let i = 0; i < mesh.n; i++) {
    for (const j of mesh.nbrs[i]) if (land[j] !== land[i]) { dist[i] = 0; q.push(i); break; }
  }
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    for (const j of mesh.nbrs[i]) if (dist[j] < 0 && land[j] === land[i]) { dist[j] = dist[i] + 1; q.push(j); }
  }
  for (let i = 0; i < mesh.n; i++) if (dist[i] < 0) dist[i] = 999;
  return dist;
}

/** Connected components of cells with land[i] === value. */
export function components(mesh: Mesh, land: Uint8Array, value: number): number[][] {
  const seen = new Uint8Array(mesh.n);
  const out: number[][] = [];
  for (let s = 0; s < mesh.n; s++) {
    if (seen[s] || land[s] !== value) continue;
    const comp = [s];
    seen[s] = 1;
    for (let h = 0; h < comp.length; h++) {
      for (const j of mesh.nbrs[comp[h]]) if (!seen[j] && land[j] === value) { seen[j] = 1; comp.push(j); }
    }
    out.push(comp);
  }
  return out;
}

/**
 * Remove land specks too small to hold a province, fill small enclosed lakes
 * (lakes/rivers arrive in M2), keep big inland seas as sea.
 */
function cleanup(mesh: Mesh, land: Uint8Array, p: GenParams) {
  let landCells = 0;
  for (let i = 0; i < mesh.n; i++) landCells += land[i];
  const meanProv = landCells / p.landProvinces;
  const minIsland = Math.max(4, Math.round(meanProv * p.minProvinceFraction));
  for (const comp of components(mesh, land, 1)) if (comp.length < minIsland) for (const c of comp) land[c] = 0;

  const waters = components(mesh, land, 0).sort((a, b) => b.length - a.length);
  const maxLake = Math.max(p.coastalZoneCells * 1.5, 40);
  for (let w = 1; w < waters.length; w++) if (waters[w].length < maxLake) for (const c of waters[w]) land[c] = 1;
}
