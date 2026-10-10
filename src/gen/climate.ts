// Climate → biomes → gameplay terrain.
// Temperature falls with latitude and altitude; moisture comes from noise, closeness to
// the sea, rivers, and latitude bands (wet tropics, dry subtropics). Because every
// continent spans most of the map's height, each one gets every climate band.
import { createNoise3D } from 'simplex-noise';
import type { Mesh } from './mesh';
import { hopsToCoast } from './elevation';
import type { HydrologyResult } from './hydrology';
import type { Rng } from './rng';
import { BIOMES, CT, TERRAINS, type Biome, type GenParams, type Terrain } from './types';

export interface ClimateResult {
  temperature: Float32Array;
  moisture: Float32Array;
  biome: Uint8Array;      // index into BIOMES, 255 = not land
  cellTerrain: Uint8Array; // index into TERRAINS, 255 = not land
}

const bump = (x: number, c: number, w: number) => Math.exp(-((x - c) * (x - c)) / (2 * w * w));

export function generateClimate(mesh: Mesh, elevation: Float64Array, hydro: HydrologyResult, p: GenParams, rng: Rng): ClimateResult {
  const { n, W, H } = mesh;
  const { cellType } = hydro;
  const R = W / (2 * Math.PI);
  const nT = createNoise3D(rng), nM = createNoise3D(rng);
  const fbm = (nz: typeof nT, x: number, y: number, f: number, oct: number) => {
    const th = (2 * Math.PI * x) / W;
    let a = 1, s = 0, norm = 0, ff = f;
    for (let o = 0; o < oct; o++) {
      s += a * nz(Math.cos(th) * R * ff, y * ff, Math.sin(th) * R * ff);
      norm += a; a *= 0.5; ff *= 2.1;
    }
    return s / norm;
  };

  // distance to the sea (lakes count as land here — they don't bring maritime climate)
  const landish = new Uint8Array(n);
  for (let i = 0; i < n; i++) landish[i] = cellType[i] === CT.Land || cellType[i] === CT.Lake ? 1 : 0;
  const seaDist = hopsToCoast(mesh, landish);

  // river influence per cell: max flux of its corners, relative to the river threshold
  const riverWet = new Float32Array(n);
  const { corners, flux, riverThreshold } = hydro;
  for (let c = 0; c < corners.n; c++) {
    const r = flux[c] / riverThreshold;
    if (r < 0.5) continue;
    const v = Math.min(1, 0.35 + 0.25 * Math.log2(r + 1));
    for (const i of corners.cells[c]) if (v > riverWet[i]) riverWet[i] = v;
  }
  // lakes moisten their shores
  for (let i = 0; i < n; i++) if (cellType[i] === CT.Lake) for (const j of mesh.nbrs[i]) riverWet[j] = Math.max(riverWet[j], 0.6);

  const temperature = new Float32Array(n);
  const moisture = new Float32Array(n);
  const biome = new Uint8Array(n).fill(255);
  const cellTerrain = new Uint8Array(n).fill(255);
  // relief by quantile of land elevation: the top ~8% are mountains, the next ~13% hills
  const landElev: number[] = [];
  for (let i = 0; i < n; i++) if (cellType[i] === CT.Land) landElev.push(elevation[i]);
  landElev.sort((a, b) => a - b);
  const q = (f: number) => landElev[Math.min(landElev.length - 1, Math.floor(f * landElev.length))] ?? 1;
  const mountainAt = q(0.92), hillsAt = q(0.79);
  const B = (b: Biome) => BIOMES.indexOf(b);
  const T = (t: Terrain) => TERRAINS.indexOf(t);

  for (let i = 0; i < n; i++) {
    const x = mesh.x[i], y = mesh.y[i];
    const lat = Math.abs(y - H / 2) / (H / 2); // 0 equator … 1 pole
    const e = Math.max(0, elevation[i]);
    const t = 1.05 - lat * 1.25 - e * 0.32 + 0.09 * fbm(nT, x, y, 3 / H, 3) + p.temperatureBias;
    let m = 0.55 + 0.32 * fbm(nM, x, y, 2.5 / H, 4)
      + 0.28 * Math.exp(-seaDist[i] / 4)
      - 0.12 * Math.min(1, seaDist[i] / 14)      // continental interiors dry out
      + 0.3 * riverWet[i]
      + 0.16 * bump(lat, 0, 0.16)               // wet tropics
      - 0.36 * bump(lat, 0.34, 0.11)            // subtropical desert belt
      + p.moistureBias;
    m = Math.max(0, Math.min(1, m));
    temperature[i] = t;
    moisture[i] = m;
    if (cellType[i] !== CT.Land) continue;

    let b: Biome;
    if (t < 0.05) b = 'snow';
    else if (t < 0.25) b = m < 0.4 ? 'tundra' : 'taiga';
    else if (m > 0.76 && e < hillsAt * 0.55 && (seaDist[i] <= 2 || riverWet[i] > 0.45)) b = 'marsh';
    else if (t > 0.72) b = m < 0.3 ? 'desert' : m < 0.56 ? 'savanna' : 'jungle';
    else if (t > 0.48) b = m < 0.3 ? 'desert' : m < 0.42 ? 'steppe' : m < 0.56 ? 'grassland' : 'forest';
    else b = m < 0.28 ? 'steppe' : m < 0.49 ? 'grassland' : 'forest';
    biome[i] = B(b);

    let ter: Terrain;
    if (e >= mountainAt) ter = 'mountains';
    else if (e >= hillsAt) ter = 'hills';
    else if (b === 'snow' || b === 'tundra') ter = 'tundra';
    else if (b === 'taiga' || b === 'forest') ter = 'forest';
    else if (b === 'desert') ter = 'desert';
    else if (b === 'jungle') ter = 'jungle';
    else if (b === 'marsh') ter = 'marsh';
    else ter = 'plains';
    cellTerrain[i] = T(ter);
  }
  return { temperature, moisture, biome, cellTerrain };
}

/** Province terrain: weighted majority of its cells (relief counts a bit more). */
export function provinceTerrain(cells: number[], cellTerrain: Uint8Array): Terrain {
  const w = new Float64Array(TERRAINS.length);
  const weight: Record<Terrain, number> = { plains: 1, forest: 1, hills: 1.25, mountains: 1.5, desert: 1, marsh: 1.1, jungle: 1, tundra: 1 };
  for (const c of cells) {
    const t = cellTerrain[c];
    if (t !== 255) w[t] += weight[TERRAINS[t]];
  }
  let best = 0;
  for (let t = 1; t < w.length; t++) if (w[t] > w[best]) best = t;
  return TERRAINS[best];
}
