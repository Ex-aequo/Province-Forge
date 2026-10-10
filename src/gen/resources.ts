// Province resources and economic value.
// Every land province has ONE main resource (amount 1–3) that follows its terrain.
// Rare resources (gold, spices) are placed separately and sparsely; start-position
// balancing later moves them out of the starts and onto contested free land.
import type { Rng } from './rng';
import { BIOMES, type Region, type Resource, type Terrain } from './types';

/** Weights for the main resource, by gameplay terrain (rares are placed separately). */
const BY_TERRAIN: Record<Terrain, Partial<Record<Resource, number>>> = {
  plains: { grain: 6, horses: 2 },
  forest: { wood: 7, grain: 1 },
  hills: { stone: 4, iron: 4, horses: 1 },
  mountains: { stone: 5, iron: 5 },
  desert: { salt: 4, horses: 3, stone: 1 },
  marsh: { salt: 2, wood: 2, grain: 2 },
  jungle: { wood: 6, grain: 1 },
  tundra: { wood: 3, stone: 2, iron: 2 },
};

/** Gameplay value of each terrain (food, room to grow, ease of holding). Tunable. */
export const TERRAIN_VALUE: Record<Terrain, number> = {
  plains: 6, forest: 5, hills: 5, mountains: 3, desert: 2, marsh: 3, jungle: 4, tundra: 2,
};
/** Value of one unit of each resource. Tunable. */
export const RESOURCE_VALUE: Record<Resource, number> = {
  grain: 2, wood: 1.5, stone: 1.5, iron: 2, horses: 2, salt: 1.5, gold: 4, spices: 4,
};
export const RIVER_VALUE = 1.5;
export const COAST_VALUE = 1;

/** Where each resource may appear (used when the balancer has to place or swap one). */
export const COMPATIBLE: Record<Resource, Terrain[]> = {
  grain: ['plains', 'forest', 'marsh', 'jungle'],
  wood: ['forest', 'jungle', 'marsh', 'tundra'],
  stone: ['hills', 'mountains', 'desert', 'tundra'],
  iron: ['hills', 'mountains', 'tundra'],
  horses: ['plains', 'desert', 'hills'],
  salt: ['desert', 'marsh'],
  gold: ['mountains', 'hills', 'desert'],
  spices: ['jungle', 'marsh', 'plains'],
};

export function provinceValue(r: Region): number {
  if (r.kind !== 'land') return 0;
  let v = TERRAIN_VALUE[r.terrain ?? 'plains'];
  if (r.hasRiver) v += RIVER_VALUE;
  if (r.coastal) v += COAST_VALUE;
  if (r.resource) v += RESOURCE_VALUE[r.resource] * (r.amount ?? 1);
  return Math.round(v * 10) / 10;
}

const pickWeighted = <T extends string>(w: Partial<Record<T, number>>, rng: Rng): T => {
  const e = Object.entries(w) as [T, number][];
  let t = 0;
  for (const [, v] of e) t += v;
  let r = rng() * t;
  for (const [k, v] of e) { r -= v; if (r <= 0) return k; }
  return e[e.length - 1][0];
};

const pickAmount = (rng: Rng) => { const r = rng(); return r < 0.45 ? 1 : r < 0.8 ? 2 : 3; };

/** The resource a province would most naturally have, ignoring rares. */
export function commonResourceFor(r: Region, rng: Rng): Resource {
  const w: Partial<Record<Resource, number>> = { ...BY_TERRAIN[r.terrain ?? 'plains'] };
  if (r.coastal) w.salt = (w.salt ?? 0) + 1.5;
  if (r.hasRiver) w.grain = (w.grain ?? 0) + 1.5;
  return pickWeighted(w, rng);
}

export function assignResources(regions: Region[], biome: Uint8Array, rareShare: number, rng: Rng) {
  const land = regions.filter((r) => r.kind === 'land');
  // steppe/savanna provinces lean towards horses
  const share = (r: Region, b: string) => r.cells.filter((c) => BIOMES[biome[c]] === b).length / r.cells.length;
  for (const r of land) {
    const w: Partial<Record<Resource, number>> = { ...BY_TERRAIN[r.terrain ?? 'plains'] };
    if (r.coastal) w.salt = (w.salt ?? 0) + 1.5;
    if (r.hasRiver) w.grain = (w.grain ?? 0) + 1.5;
    const steppe = share(r, 'steppe') + share(r, 'savanna');
    if (steppe > 0.4) w.horses = (w.horses ?? 0) + 4;
    r.resource = pickWeighted(w, rng);
    r.amount = pickAmount(rng);
  }

  // rares: sparse, never two adjacent, on compatible terrain
  const want = Math.round(land.length * rareShare);
  const cands = land.filter((r) => COMPATIBLE.gold.includes(r.terrain!) || COMPATIBLE.spices.includes(r.terrain!));
  for (let i = cands.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [cands[i], cands[j]] = [cands[j], cands[i]]; }
  let placed = 0;
  for (const r of cands) {
    if (placed >= want) break;
    if (r.neighbors.some((o) => regions[o].resource === 'gold' || regions[o].resource === 'spices')) continue;
    const hot = share(r, 'jungle') + share(r, 'savanna') + share(r, 'marsh');
    const canSpice = COMPATIBLE.spices.includes(r.terrain!) && hot > 0.3;
    const canGold = COMPATIBLE.gold.includes(r.terrain!);
    if (!canSpice && !canGold) continue;
    r.resource = canSpice && (!canGold || rng() < 0.5) ? 'spices' : 'gold';
    r.amount = 1 + (rng() < 0.3 ? 1 : 0);
    placed++;
  }
  for (const r of land) r.value = provinceValue(r);
}
