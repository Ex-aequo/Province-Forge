// Terrain raster: painted biome colours, hillshaded relief, water depth and ice, rendered
// as 512 px tiles at several zoom levels. Pure computation + a 2D canvas for the
// land/lake/ice masks, so the same code runs in a Web Worker (browser), on the main
// thread (fallback) and in Node (CLI / future server-side tile baking).
//
// Colours are interpolated across Delaunay triangles (no Voronoi facets), while the
// land/water boundary comes from the SAME smoothed polygons the SVG draws, so the
// painted coast always matches the vector coastline.
import { createNoise3D } from 'simplex-noise';
import { createRng } from '../gen/rng';
import { BIOMES, CT, type Biome, type GeneratedMap } from '../gen/types';

export const TILE = 512;
/** Level-0 width of the whole world in pixels; each level doubles it. */
export const BASE_PX = 2048;
export const MAX_LEVEL = 4;

/** "Fake 3D" look (decided with Pedro: top-down map, everything with height stands up).
 *  Lengths are in WORLD units, so the effect scales with zoom like the terrain itself. */
export interface TerrainStyle {
  /** Height of the coastal cliff drawn below south-facing coasts (0 = flat). */
  coastHeight: number;
  /** Darkness of the shadow land casts on the water (0–1). */
  coastShadow: number;
  /** Hillshade contrast (1.4 = the M2–M5 look). */
  reliefContrast: number;
  /** Valley darkening / ridge lightening from local height differences (0 = off). */
  cavity: number;
}
export const DEFAULT_TERRAIN_STYLE: TerrainStyle = { coastHeight: 3.5, coastShadow: 0.55, reliefContrast: 1.9, cavity: 0.55 };
export const FLAT_TERRAIN_STYLE: TerrainStyle = { coastHeight: 0, coastShadow: 0, reliefContrast: 1.4, cavity: 0 };

export interface TerrainData {
  style: TerrainStyle;
  W: number;
  H: number;
  seed: string;
  triXY: Float64Array;
  triCell: Int32Array;
  /** Per cell: land colour (0–1), land height (0–1), water depth (0–1). */
  landR: Float32Array; landG: Float32Array; landB: Float32Array;
  hLand: Float32Array;
  depth: Float32Array;
  /** Per cell: neighbourhood height minus own height (+ valley, − ridge). */
  cav: Float32Array;
  /** Average distance between cell sites, in map units. */
  spacing: number;
  hillsAt: number;
  mountainAt: number;
  /** Polygon rings per kind, flattened: pts + start offsets (in numbers). */
  rings: Record<'land' | 'lake' | 'ice', { pts: Float64Array; offs: Int32Array }>;
}

const BIOME_RGB: Record<Biome, [number, number, number]> = {
  snow: [200, 206, 206], tundra: [150, 148, 124], taiga: [72, 98, 74], forest: [78, 112, 60],
  grassland: [118, 148, 72], steppe: [150, 148, 94], savanna: [168, 152, 86], desert: [212, 188, 134],
  jungle: [52, 98, 48], marsh: [92, 112, 86],
};

/** Extract everything the raster needs from a generated map (all transferable arrays). */
export function buildTerrainData(map: GeneratedMap, style: TerrainStyle = DEFAULT_TERRAIN_STYLE): TerrainData {
  const n = map.cellX.length;
  const landR = new Float32Array(n), landG = new Float32Array(n), landB = new Float32Array(n);
  const hLand = new Float32Array(n), depth = new Float32Array(n);
  const isLand = (i: number) => map.cellType[i] === CT.Land;
  for (let i = 0; i < n; i++) {
    if (isLand(i)) {
      const [r, g, b] = BIOME_RGB[BIOMES[map.biome[i]]] ?? BIOME_RGB.grassland;
      // moisture nudges the hue a little: drier → yellower, wetter → greener
      const m = map.moisture[i] - 0.5;
      landR[i] = (r - m * 14) / 255; landG[i] = (g + m * 10) / 255; landB[i] = (b - m * 4) / 255;
      hLand[i] = Math.max(0, map.elevation[i]);
    } else {
      depth[i] = map.cellType[i] === CT.Sea ? Math.min(1, -map.elevation[i]) : 0.15;
    }
  }
  // water cells borrow the colour of neighbouring land, so blends at the coast stay clean
  const nb = neighbourLists(map);
  for (let i = 0; i < n; i++) {
    if (isLand(i)) continue;
    let r = 0, g = 0, b = 0, k = 0;
    for (const j of nb[i]) if (isLand(j)) { r += landR[j]; g += landG[j]; b += landB[j]; k++; }
    if (k) { landR[i] = r / k; landG[i] = g / k; landB[i] = b / k; }
    else { landR[i] = 200 / 255; landG[i] = 186 / 255; landB[i] = 140 / 255; }
  }
  // cavity: mean land height over the 2-ring neighbourhood minus own height
  const cav = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!isLand(i)) continue;
    const ring = new Set<number>();
    for (const j of nb[i]) { ring.add(j); for (const k of nb[j]) ring.add(k); }
    ring.delete(i);
    let s = 0, c = 0;
    for (const j of ring) { s += isLand(j) ? hLand[j] : 0; c++; }
    if (c) cav[i] = s / c - hLand[i];
  }
  const landE: number[] = [];
  for (let i = 0; i < n; i++) if (isLand(i)) landE.push(hLand[i]);
  landE.sort((a, b) => a - b);
  const q = (f: number) => landE[Math.min(landE.length - 1, Math.floor(f * landE.length))] ?? 1;

  const pack = (kind: 'land' | 'lake' | 'ice') => {
    const pts: number[] = [], offs: number[] = [];
    for (const r of map.regions) {
      if (r.kind !== kind) continue;
      for (const ring of r.rings) { offs.push(pts.length); for (const v of ring) pts.push(v); }
    }
    offs.push(pts.length);
    return { pts: Float64Array.from(pts), offs: Int32Array.from(offs) };
  };
  return {
    style, W: map.width, H: map.height, seed: map.params.seed,
    triXY: map.triXY, triCell: map.triCell,
    landR, landG, landB, hLand, depth, cav,
    spacing: Math.sqrt((map.width * map.height) / n),
    hillsAt: q(0.79), mountainAt: q(0.92),
    rings: { land: pack('land'), lake: pack('lake'), ice: pack('ice') },
  };
}

function neighbourLists(map: GeneratedMap): number[][] {
  // neighbours via shared Delaunay triangles (cheap and good enough here)
  const n = map.cellX.length;
  const sets: Set<number>[] = Array.from({ length: n }, () => new Set());
  const T = map.triCell;
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t], b = T[t + 1], c = T[t + 2];
    sets[a].add(b); sets[a].add(c); sets[b].add(a); sets[b].add(c); sets[c].add(a); sets[c].add(b);
  }
  return sets.map((s) => Array.from(s));
}

// ---------------------------------------------------------------------------------

/** Minimal canvas API we need (browser canvas, OffscreenCanvas or @napi-rs/canvas). */
export interface Ctx2D {
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  fillStyle: unknown;
  globalCompositeOperation: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(rule?: 'evenodd' | 'nonzero'): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}
export type MakeCtx = (w: number, h: number) => Ctx2D;

const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class TerrainRenderer {
  private buckets: Map<number, number[]> = new Map();
  private bucketSize: number;
  private noiseA: (x: number, y: number, z: number) => number;
  private noiseB: (x: number, y: number, z: number) => number;
  private ringBoxes: Record<'land' | 'lake' | 'ice', Float64Array>;

  constructor(private d: TerrainData, private makeCtx: MakeCtx) {
    this.bucketSize = d.W / 64;
    const T = d.triXY;
    for (let t = 0; t < T.length / 6; t++) {
      const xs = [T[6 * t], T[6 * t + 2], T[6 * t + 4]], ys = [T[6 * t + 1], T[6 * t + 3], T[6 * t + 5]];
      const bx0 = Math.floor(Math.min(...xs) / this.bucketSize), bx1 = Math.floor(Math.max(...xs) / this.bucketSize);
      const by0 = Math.floor(Math.min(...ys) / this.bucketSize), by1 = Math.floor(Math.max(...ys) / this.bucketSize);
      for (let bx = bx0; bx <= bx1; bx++) for (let by = by0; by <= by1; by++) {
        const k = (bx + 1000) * 4096 + (by + 1000);
        (this.buckets.get(k) ?? this.buckets.set(k, []).get(k)!).push(t);
      }
    }
    const rng = createRng(`${d.seed}::terrain-raster`);
    this.noiseA = createNoise3D(rng);
    this.noiseB = createNoise3D(rng);
    const boxes = (r: { pts: Float64Array; offs: Int32Array }) => {
      const out = new Float64Array((r.offs.length - 1) * 4);
      for (let k = 0; k < r.offs.length - 1; k++) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let i = r.offs[k]; i < r.offs[k + 1]; i += 2) {
          const x = r.pts[i], y = r.pts[i + 1];
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        out.set([x0, y0, x1, y1], k * 4);
      }
      return out;
    };
    this.ringBoxes = { land: boxes(d.rings.land), lake: boxes(d.rings.lake), ice: boxes(d.rings.ice) };
  }

  static tilesAt(level: number, d: { W: number; H: number }) {
    const px = BASE_PX * 2 ** level;
    const upx = d.W / px;
    return { upx, nx: Math.ceil(px / TILE), ny: Math.ceil(d.H / upx / TILE), tileW: TILE * upx };
  }

  /** Wrapped fBm (x on a circle so the noise tiles around the world). */
  private fbm(nz: (x: number, y: number, z: number) => number, x: number, y: number, f: number, oct: number, ridged = false) {
    const W = this.d.W, R = W / (2 * Math.PI);
    const th = (2 * Math.PI * x) / W, cx = Math.cos(th) * R, cz = Math.sin(th) * R;
    let a = 1, s = 0, norm = 0, ff = f;
    for (let o = 0; o < oct; o++) {
      let v = nz(cx * ff, y * ff, cz * ff);
      if (ridged) { v = 1 - Math.abs(v); v *= v; }
      s += a * v; norm += a; a *= 0.5; ff *= 2.03;
    }
    return s / norm;
  }

  /** RGBA pixels of one tile (TILE×TILE). */
  renderTile(level: number, tx: number, ty: number): Uint8ClampedArray {
    const d = this.d;
    const { upx } = TerrainRenderer.tilesAt(level, d);
    // the buffer has a border P: one pixel for hillshade plus the blur radius
    const blurR = Math.max(1, Math.round((d.spacing * 0.45) / upx));
    const st = d.style;
    const coastPx = (st.coastHeight * 2.4) / upx; // cliff + shadow reach, in pixels
    const P = Math.max(blurR * 2 + 2, Math.ceil(coastPx) + 4);
    const S = TILE, B = S + 2 * P;
    const x0 = tx * S * upx - P * upx, y0 = ty * S * upx - P * upx; // world coords of buffer pixel (0,0) corner

    // ---- 1. barycentric rasterisation of triangles: colour, land height, depth
    const R = new Float32Array(B * B), G = new Float32Array(B * B), Bl = new Float32Array(B * B);
    const HL = new Float32Array(B * B), DP = new Float32Array(B * B), CV = new Float32Array(B * B);
    const set = new Uint8Array(B * B);
    const wx0 = x0, wx1 = x0 + B * upx, wy0 = y0, wy1 = y0 + B * upx;
    const seen = new Set<number>();
    const bs = this.bucketSize;
    for (let bx = Math.floor(wx0 / bs); bx <= Math.floor(wx1 / bs); bx++) {
      for (let by = Math.floor(wy0 / bs); by <= Math.floor(wy1 / bs); by++) {
        const list = this.buckets.get((bx + 1000) * 4096 + (by + 1000));
        if (!list) continue;
        for (const t of list) {
          if (seen.has(t)) continue;
          seen.add(t);
          this.rasterTri(t, x0, y0, upx, B, R, G, Bl, HL, DP, CV, set);
        }
      }
    }
    // pixels outside the triangulation (thin strips at the poles): copy vertically
    for (let x = 0; x < B; x++) {
      let last = -1;
      for (let y = 0; y < B; y++) if (set[y * B + x]) { last = y; break; }
      if (last < 0) continue;
      for (let y = 0; y < last; y++) this.copyPx(y * B + x, last * B + x, R, G, Bl, HL, DP, CV);
      for (let y = last; y < B; y++) { if (set[y * B + x]) last = y; else this.copyPx(y * B + x, last * B + x, R, G, Bl, HL, DP, CV); }
    }

    // smooth away the linear-per-triangle facets (they show up badly in hillshade)
    for (const arr of [HL, R, G, Bl, DP, CV]) { boxBlur(arr, B, blurR); boxBlur(arr, B, blurR); }

    // ---- 2. coverage masks from the vector polygons (antialiased, 3 copies for the wrap)
    const ctx = this.makeCtx(B, B);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillRect(0, 0, B, B);
    ctx.globalCompositeOperation = 'lighter';
    const kinds: ['land' | 'lake' | 'ice', string][] = [['land', '#ff0000'], ['lake', '#00ff00'], ['ice', '#0000ff']];
    for (const [kind, col] of kinds) {
      const r = d.rings[kind], boxes = this.ringBoxes[kind];
      ctx.fillStyle = col;
      ctx.beginPath();
      let any = false;
      for (const shift of [-d.W, 0, d.W]) {
        for (let k = 0; k < r.offs.length - 1; k++) {
          if (boxes[4 * k + 2] + shift < wx0 || boxes[4 * k] + shift > wx1 || boxes[4 * k + 3] < wy0 || boxes[4 * k + 1] > wy1) continue;
          any = true;
          for (let i = r.offs[k]; i < r.offs[k + 1]; i += 2) {
            const px = (r.pts[i] + shift - x0) / upx, py = (r.pts[i + 1] - y0) / upx;
            if (i === r.offs[k]) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.closePath();
        }
      }
      if (any) ctx.fill('evenodd');
    }
    const mask = ctx.getImageData(0, 0, B, B).data;

    // ---- 3. relief detail + hillshade + colour
    const H2 = new Float32Array(B * B);
    const fDetail = 1 / 55, fMicro = 1 / 14;
    for (let y = 0; y < B; y++) {
      for (let x = 0; x < B; x++) {
        const i = y * B + x;
        const hl = HL[i];
        if (mask[i * 4] === 0) { H2[i] = 0; continue; }
        const wxp = x0 + (x + 0.5) * upx, wyp = y0 + (y + 0.5) * upx;
        const mtn = smooth(d.hillsAt * 0.8, d.mountainAt * 1.05, hl);
        const ridge = mtn > 0.01 ? this.fbm(this.noiseA, wxp, wyp, fDetail, 4, true) : 0;
        const hilly = smooth(d.hillsAt * 0.6, d.hillsAt, hl);
        const micro = this.fbm(this.noiseB, wxp, wyp, fMicro, hilly > 0.05 ? 2 : 1);
        H2[i] = hl + mtn * 0.3 * ridge + 0.005 * micro + 0.03 * hilly * micro;
      }
    }

    // ---- 4. "fake 3D" coast fields: raised land (and ice) as a plateau
    // E = raised coverage (land + ice), K = lake coverage
    const E = new Float32Array(B * B), K = new Float32Array(B * B);
    for (let i = 0; i < B * B; i++) { E[i] = Math.min(1, (mask[i * 4] + mask[i * 4 + 2]) / 255); K[i] = mask[i * 4 + 1] / 255; }
    const chPx = st.coastHeight / upx;
    const nK = Math.ceil(chPx);
    // distance (px) up to the nearest raised pixel: lets open sea skip the cliff search
    const upDist = new Uint16Array(B * B);
    for (let x = 0; x < B; x++) {
      let last = -10000;
      for (let y = 0; y < B; y++) { const i = y * B + x; if (E[i] > 0.004) last = y; upDist[i] = Math.min(65535, y - last); }
    }
    // cast shadow: coverage shifted along the light, then softened
    const shLen = (st.coastHeight * 1.6) / upx;
    const sdx = Math.round(0.66 * shLen), sdy = Math.round(0.75 * shLen);
    const SH = new Float32Array(B * B), SK = new Float32Array(B * B);
    if (st.coastShadow > 0 && chPx > 0.15) {
      for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) {
        const xs = Math.max(0, Math.min(B - 1, x - sdx)), ys = Math.max(0, Math.min(B - 1, y - sdy));
        const j = ys * B + xs;
        SH[y * B + x] = E[j];
        SK[y * B + x] = 1 - K[j];
      }
      const rb = Math.max(1, Math.round((st.coastHeight * 0.7) / upx));
      boxBlur(SH, B, rb); boxBlur(SH, B, rb); boxBlur(SK, B, rb); boxBlur(SK, B, rb);
    }

    const out = new Uint8ClampedArray(S * S * 4);
    const relief = 48; // world units of height per 1.0 of elevation (exaggerated for shading)
    const lx = -0.55, ly = -0.62, lz = 0.56;
    const ln = Math.hypot(lx, ly, lz);
    const flat = lz / ln;
    for (let y = P; y < P + S; y++) {
      for (let x = P; x < P + S; x++) {
        const i = y * B + x;
        const aL = mask[i * 4] / 255, aK = mask[i * 4 + 1] / 255, aI = mask[i * 4 + 2] / 255;
        const aS = Math.max(0, 1 - aL - aK - aI);
        const wxp = x0 + (x + 0.5) * upx, wyp = y0 + (y + 0.5) * upx;
        const grain = this.fbm(this.noiseA, wxp, wyp, 1 / 70, 2);

        let r = 0, g = 0, b = 0;
        if (aL > 0) {
          // hillshade from the detailed height field
          const sx = (H2[i + 1] - H2[i - 1]) * relief / (2 * upx);
          const sy = (H2[i + B] - H2[i - B]) * relief / (2 * upx);
          const nl = Math.hypot(sx, sy, 1);
          const shade = (-sx * lx - sy * ly + lz) / (nl * ln);
          let light = Math.max(0.45, Math.min(1.5, 1 + (shade - flat) * st.reliefContrast));
          // valleys a little darker, ridges a little brighter
          if (st.cavity > 0) light *= 1 - st.cavity * Math.max(-0.25, Math.min(0.45, CV[i] * 7));
          // bevel: the coastal rim facing the light catches it, the far rim darkens
          if (chPx > 0.15) {
            const o1 = Math.max(1, Math.round(0.35 * chPx));
            const up = E[i - o1 * B - o1], dn = E[i + o1 * B + o1];
            light *= 1 + 0.12 * (1 - up) - 0.1 * (1 - dn);
          }
          const h = H2[i];
          const rock = smooth(d.mountainAt * 0.9, d.mountainAt * 1.08, HL[i]) * 0.7;
          let cr = R[i], cg = G[i], cb = Bl[i];
          // bare rock on mountains, snow only on the highest peaks
          cr += (0.5 - cr) * rock; cg += (0.47 - cg) * rock; cb += (0.43 - cb) * rock;
          const snow = smooth(d.mountainAt + 0.2, d.mountainAt + 0.34, h);
          cr += (0.95 - cr) * snow; cg += (0.96 - cg) * snow; cb += (0.97 - cb) * snow;
          const tex = 1 + grain * 0.07;
          r += aL * cr * light * tex; g += aL * cg * light * tex; b += aL * cb * light * tex;
        }
        // cliff face: water pixel just south of raised ground shows the ground's side
        let face = 0, faceT = 0, faceIce = 0;
        if (chPx > 0.15 && E[i] < 0.999 && upDist[i - B] <= nK) {
          for (let k = 1; k <= nK; k++) {
            const w = k <= chPx ? 1 : chPx - (k - 1);
            const j = i - k * B;
            const v = E[j] * w;
            if (v > face) { face = v; faceT = k / chPx; faceIce = mask[j * 4 + 2] / 255; }
          }
          face *= 1 - E[i];
        }
        // lake walls: the far (north) shore of a lake shows a short earthen bank
        let wall = 0, wallT = 0;
        if (chPx > 0.15 && aK > 0) {
          const nW = Math.max(1, Math.round(chPx * 0.6));
          for (let k = 1; k <= nW; k++) { const v = 1 - K[i - k * B]; if (v > wall) { wall = v; wallT = k / nW; } }
          wall *= aK;
        }
        const shade2 = 1 - st.coastShadow * SH[i];
        if (aS > 0) {
          const dd = smooth(0, 0.7, DP[i]);
          const shallow = [0.42, 0.62, 0.7], deep = [0.15, 0.29, 0.42];
          const wv = 1 + grain * 0.035;
          r += aS * (shallow[0] + (deep[0] - shallow[0]) * dd) * wv * shade2;
          g += aS * (shallow[1] + (deep[1] - shallow[1]) * dd) * wv * shade2;
          b += aS * (shallow[2] + (deep[2] - shallow[2]) * dd) * wv * shade2;
        }
        if (aK > 0) {
          const wv = 1 + grain * 0.03, sk = 1 - st.coastShadow * 0.8 * SK[i] * aK;
          r += aK * 0.36 * wv * sk; g += aK * 0.56 * wv * sk; b += aK * 0.67 * wv * sk;
        }
        if (face > 0.003 || wall > 0.003) {
          // earth / rock face, lighter at the top edge; ice cliffs pale blue
          const f = Math.max(face, wall), t = face >= wall ? faceT : wallT;
          const strata = 1 + 0.06 * this.fbm(this.noiseB, wxp * 0.2, wyp * 3, 1 / 6, 1);
          const lum = (0.92 - 0.38 * t) * strata;
          let fr = 0.3 * R[i] + 0.7 * 0.5, fg = 0.3 * G[i] + 0.7 * 0.42, fb = 0.3 * Bl[i] + 0.7 * 0.33;
          fr += (0.74 - fr) * faceIce; fg += (0.83 - fg) * faceIce; fb += (0.9 - fb) * faceIce;
          r = r * (1 - f) + fr * lum * f; g = g * (1 - f) + fg * lum * f; b = b * (1 - f) + fb * lum * f;
          // dark line where the face meets the water
          if (t > 0.85) { const k = (t - 0.85) / 0.15 * f * 0.35; r *= 1 - k; g *= 1 - k; b *= 1 - k; }
        }
        if (aI > 0) {
          const ice = 0.93 + grain * 0.05;
          r += aI * 0.88 * ice; g += aI * 0.92 * ice; b += aI * 0.95 * ice;
        }
        const o = ((y - P) * S + (x - P)) * 4;
        out[o] = r * 255; out[o + 1] = g * 255; out[o + 2] = b * 255; out[o + 3] = 255;
      }
    }
    return out;
  }

  private copyPx(to: number, from: number, R: Float32Array, G: Float32Array, B: Float32Array, HL: Float32Array, DP: Float32Array, CV: Float32Array) {
    R[to] = R[from]; G[to] = G[from]; B[to] = B[from]; HL[to] = HL[from]; DP[to] = DP[from]; CV[to] = CV[from];
  }

  private rasterTri(t: number, x0: number, y0: number, upx: number, Bsz: number,
    R: Float32Array, G: Float32Array, B: Float32Array, HL: Float32Array, DP: Float32Array, CV: Float32Array, set: Uint8Array) {
    const d = this.d, T = d.triXY, C = d.triCell;
    // pixel-space vertices (pixel centres at integer + 0.5)
    const ax = (T[6 * t] - x0) / upx, ay = (T[6 * t + 1] - y0) / upx;
    const bx = (T[6 * t + 2] - x0) / upx, by = (T[6 * t + 3] - y0) / upx;
    const cx = (T[6 * t + 4] - x0) / upx, cy = (T[6 * t + 5] - y0) / upx;
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-12) return;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx) - 0.5)), maxX = Math.min(Bsz - 1, Math.ceil(Math.max(ax, bx, cx) - 0.5));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy) - 0.5)), maxY = Math.min(Bsz - 1, Math.ceil(Math.max(ay, by, cy) - 0.5));
    if (minX > maxX || minY > maxY) return;
    const ca = C[3 * t], cb = C[3 * t + 1], cc = C[3 * t + 2];
    const eps = -1e-6;
    for (let py = minY; py <= maxY; py++) {
      const yc = py + 0.5;
      for (let px = minX; px <= maxX; px++) {
        const xc = px + 0.5;
        const l1 = ((by - cy) * (xc - cx) + (cx - bx) * (yc - cy)) / det;
        if (l1 < eps) continue;
        const l2 = ((cy - ay) * (xc - cx) + (ax - cx) * (yc - cy)) / det;
        if (l2 < eps) continue;
        const l3 = 1 - l1 - l2;
        if (l3 < eps) continue;
        const i = py * Bsz + px;
        R[i] = l1 * d.landR[ca] + l2 * d.landR[cb] + l3 * d.landR[cc];
        G[i] = l1 * d.landG[ca] + l2 * d.landG[cb] + l3 * d.landG[cc];
        B[i] = l1 * d.landB[ca] + l2 * d.landB[cb] + l3 * d.landB[cc];
        HL[i] = l1 * d.hLand[ca] + l2 * d.hLand[cb] + l3 * d.hLand[cc];
        DP[i] = l1 * d.depth[ca] + l2 * d.depth[cb] + l3 * d.depth[cc];
        CV[i] = l1 * d.cav[ca] + l2 * d.cav[cb] + l3 * d.cav[cc];
        set[i] = 1;
      }
    }
  }
}

/** In-place separable box blur (running sums, O(n) regardless of radius). */
function boxBlur(a: Float32Array, B: number, r: number) {
  const tmp = new Float32Array(B);
  const win = 2 * r + 1;
  for (let y = 0; y < B; y++) {
    const row = y * B;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += a[row + Math.min(B - 1, Math.max(0, k))];
    for (let x = 0; x < B; x++) {
      tmp[x] = acc / win;
      acc += a[row + Math.min(B - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
    }
    a.set(tmp, row);
  }
  for (let x = 0; x < B; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += a[Math.min(B - 1, Math.max(0, k)) * B + x];
    for (let y = 0; y < B; y++) {
      tmp[y] = acc / win;
      acc += a[Math.min(B - 1, y + r + 1) * B + x] - a[Math.max(0, y - r) * B + x];
    }
    for (let y = 0; y < B; y++) a[y * B + x] = tmp[y];
  }
}
