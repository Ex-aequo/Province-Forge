// Land provinces and sea zones built on top of the cell mesh.
import { provinceTerrain } from './climate';
import { clusterCells } from './cluster';
import { components, hopsToCoast } from './elevation';
import type { Mesh } from './mesh';
import { dxWrap } from './mesh';
import type { Rng } from './rng';
import { edgeKey } from './hydrology';
import { CT, type GenParams, type Landmass, type Region, type RegionKind } from './types';

export interface RegionsResult {
  cellRegion: Int32Array;
  regions: Region[];
  landmasses: Landmass[];
  minProvinceCells: number;
}

const NAMES = ['Continente A', 'Continente B', 'Continente C'];

export function buildRegions(
  mesh: Mesh, cellType: Uint8Array, elevation: Float64Array, owner: Int32Array,
  riverEdges: Set<number>, cellTerrain: Uint8Array, p: GenParams, rngLand: Rng, rngSea: Rng,
): RegionsResult {
  const n = mesh.n;
  const land = new Uint8Array(n);
  for (let i = 0; i < n; i++) land[i] = cellType[i] === CT.Land ? 1 : 0;
  const cellRegion = new Int32Array(n).fill(-1);
  const regions: Region[] = [];

  // ---------- landmasses: the three largest components are continents.
  // Each is matched to the continent it was generated as (majority owner), so
  // "Continent A" here is the same continent the A share slider controls.
  const lands = components(mesh, land, 1).sort((a, b) => b.length - a.length);
  const landCells = lands.reduce((s, c) => s + c.length, 0);
  const meanProv = landCells / p.landProvinces;
  const minProvinceCells = Math.max(3, Math.round(meanProv * p.minProvinceFraction));
  const contSlot = [-1, -1, -1]; // continent index → component index
  for (let li = 0; li < Math.min(3, lands.length); li++) {
    if (lands[li].length < landCells * 0.08) continue;
    const votes = [0, 0, 0];
    for (const c of lands[li]) if (owner[c] < 3) votes[owner[c]]++;
    let best = -1;
    for (let c = 0; c < 3; c++) if (contSlot[c] < 0 && (best < 0 || votes[c] > votes[best])) best = c;
    if (best >= 0) contSlot[best] = li;
  }
  const contIdx = contSlot.filter((li) => li >= 0);
  const contNames = contSlot.map((li, c) => ({ li, c })).filter((o) => o.li >= 0).map((o) => NAMES[o.c]);
  const contShare = contSlot.map((li, c) => ({ li, c })).filter((o) => o.li >= 0).map((o) => p.continentSizes[o.c]);
  const landOrder = [...contIdx, ...lands.map((_, i) => i).filter((i) => !contIdx.includes(i))];
  const nCont = contIdx.length;

  // ---------- provinces per landmass (largest remainder, at least 1 each).
  // Islands get provinces by size; the three continents split the rest by their
  // share sliders, so continents always get EQUAL province counts at equal shares
  // (provinces on a slightly smaller continent are slightly smaller).
  const apportion = (total: number, weights: number[]) => {
    const sum = weights.reduce((s, w) => s + w, 0) || 1;
    const q = weights.map((w) => (w / sum) * total);
    const out = q.map((x) => Math.max(1, Math.floor(x)));
    let left = total - out.reduce((s, x) => s + x, 0);
    const order = q.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r);
    for (let t = 0; left > 0 && t < order.length; t++, left--) out[order[t].i]++;
    return out;
  };
  const sizesAll = landOrder.map((li) => lands[li].length);
  let alloc: number[];
  if (nCont === 3) {
    const islandCells = sizesAll.slice(3).reduce((s, x) => s + x, 0);
    const islandTotal = Math.round((p.landProvinces * islandCells) / landCells);
    const islandAlloc = islandCells ? apportion(Math.max(sizesAll.length - 3, islandTotal), sizesAll.slice(3)) : [];
    alloc = [...apportion(p.landProvinces - islandAlloc.reduce((s, x) => s + x, 0), contShare), ...islandAlloc];
  } else {
    alloc = apportion(p.landProvinces, sizesAll);
  }
  // a landmass can't hold more provinces than its size allows
  landOrder.forEach((li, idx) => { alloc[idx] = Math.max(1, Math.min(alloc[idx], Math.floor(lands[li].length / minProvinceCells))); });

  const landmasses: Landmass[] = [];
  let islandNo = 0;
  // crossing a ridge, a river or a terrain change is expensive → borders settle there
  const riverMul = 1 + p.riverBorderWeight * 2.5;
  const elevCost = (a: number, b: number) =>
    (1 + p.ridgeBorderWeight * 12 * Math.abs(elevation[a] - elevation[b]) + (cellTerrain[a] !== cellTerrain[b] ? 0.5 : 0)) *
    (riverEdges.has(edgeKey(a, b, n)) ? riverMul : 1);
  landOrder.forEach((li, idx) => {
    const cells = lands[li];
    const isCont = idx < nCont;
    const lm: Landmass = { id: idx, name: isCont ? contNames[idx] : `Ilha ${++islandNo}`, isContinent: isCont, cells: cells.length, provinces: 0 };
    const assign = clusterCells(mesh, cells, { k: alloc[idx], minCells: minProvinceCells, edgeCost: elevCost }, rngLand);
    const base = regions.length;
    const localToGlobal = new Map<number, number>();
    for (let i = 0; i < cells.length; i++) {
      let g = localToGlobal.get(assign[i]);
      if (g === undefined) {
        g = regions.length;
        localToGlobal.set(assign[i], g);
        regions.push(newRegion(g, 'land', idx));
      }
      cellRegion[cells[i]] = g;
    }
    lm.provinces = regions.length - base;
    landmasses.push(lm);
  });

  // ---------- sea zones: a coastal band of small zones, open ocean of large ones
  const coastDist = hopsToCoast(mesh, land);
  const band = new Uint8Array(n); // 1 = coastal band, 0 = open ocean (sea only)
  for (let i = 0; i < n; i++) if (cellType[i] === CT.Sea && coastDist[i] < p.coastalBandHops) band[i] = 1;
  const isWater = (i: number) => cellType[i] === CT.Sea;

  const clusterWater = (pick: (i: number) => boolean, targetCells: number, kind: 'coastal' | 'ocean') => {
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = isWater(i) && pick(i) ? 1 : 0;
    for (const comp of components(mesh, mask, 1)) {
      // tiny open-ocean pockets get absorbed by the coastal zones later
      if (kind === 'ocean' && comp.length < targetCells * 0.3) continue;
      const k = Math.max(1, Math.round(comp.length / targetCells));
      const assign = clusterCells(mesh, comp, { k, minCells: Math.max(3, Math.round(targetCells * 0.35)) }, rngSea);
      const map = new Map<number, number>();
      for (let i = 0; i < comp.length; i++) {
        let g = map.get(assign[i]);
        if (g === undefined) {
          g = regions.length;
          map.set(assign[i], g);
          const r = newRegion(g, 'sea', -1);
          r.seaKind = kind;
          regions.push(r);
        }
        cellRegion[comp[i]] = g;
      }
    }
  };
  clusterWater((i) => band[i] === 1, p.coastalZoneCells, 'coastal');
  clusterWater((i) => band[i] === 0, p.oceanZoneCells, 'ocean');

  // absorb unassigned water pockets into the neighbouring zone they touch most
  for (let pass = 0; pass < 50; pass++) {
    let left = 0;
    for (let i = 0; i < n; i++) {
      if (cellRegion[i] >= 0 || cellType[i] !== CT.Sea) continue;
      const counts = new Map<number, number>();
      for (const j of mesh.nbrs[i]) if (cellRegion[j] >= 0 && regions[cellRegion[j]].kind === 'sea') counts.set(cellRegion[j], (counts.get(cellRegion[j]) ?? 0) + 1);
      let best = -1, bc = 0;
      for (const [r, c] of counts) if (c > bc) { bc = c; best = r; }
      if (best >= 0) cellRegion[i] = best; else left++;
    }
    if (!left) break;
  }

  // ---------- impassable regions: one per lake; ice split into longitude chunks
  // (so no single polygon wraps the whole world)
  const addComponents = (mask: Uint8Array, kind: RegionKind) => {
    for (const comp of components(mesh, mask, 1)) {
      const g = regions.length;
      regions.push(newRegion(g, kind, -1));
      for (const c of comp) cellRegion[c] = g;
    }
  };
  const lakeMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) lakeMask[i] = cellType[i] === CT.Lake ? 1 : 0;
  addComponents(lakeMask, 'lake');
  const CHUNKS = 8;
  for (let k = 0; k < CHUNKS; k++) {
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = cellType[i] === CT.Ice && Math.floor((mesh.x[i] / mesh.W) * CHUNKS) % CHUNKS === k ? 1 : 0;
    addComponents(m, 'ice');
  }

  // ---------- fill region data
  for (let i = 0; i < n; i++) {
    const r = cellRegion[i];
    if (r >= 0) { regions[r].cells.push(i); regions[r].area += mesh.area[i]; }
  }
  const passable = (k: RegionKind) => k === 'land' || k === 'sea';
  for (const r of regions) {
    const ns = new Set<number>(), rs = new Set<number>();
    let hasRiver = false;
    for (const c of r.cells) for (const j of mesh.nbrs[c]) {
      const o = cellRegion[j];
      const isRiver = riverEdges.has(edgeKey(c, j, n));
      if (isRiver) hasRiver = true;
      if (o < 0 || o === r.id || !passable(regions[o].kind)) continue;
      ns.add(o);
      if (isRiver && r.kind === 'land' && regions[o].kind === 'land') rs.add(o);
    }
    r.neighbors = passable(r.kind) ? Array.from(ns).sort((a, b) => a - b) : [];
    r.riverNeighbors = Array.from(rs).sort((a, b) => a - b);
    r.coastal = r.kind === 'land' ? r.neighbors.some((o) => regions[o].kind === 'sea') : r.kind === 'sea' && r.neighbors.some((o) => regions[o].kind === 'land');
    if (r.kind === 'land') { r.terrain = provinceTerrain(r.cells, cellTerrain); r.hasRiver = hasRiver; }
    r.label = labelPoint(mesh, r.cells);
  }
  return { cellRegion, regions, landmasses, minProvinceCells };
}

function newRegion(id: number, kind: RegionKind, landmass: number): Region {
  return { id, kind, landmass, cells: [], area: 0, label: [0, 0], neighbors: [], riverNeighbors: [], rings: [], coastal: false };
}

/** Centre of the member cell nearest the region centroid (always inside the region). */
function labelPoint(mesh: Mesh, cells: number[]): [number, number] {
  const ref = cells[0];
  let sx = 0, sy = 0;
  for (const c of cells) { sx += dxWrap(mesh.x[ref], mesh.x[c], mesh.W); sy += mesh.y[c]; }
  const cx = mesh.x[ref] + sx / cells.length, cy = sy / cells.length;
  let best = ref, bd = Infinity;
  for (const c of cells) {
    const dx = dxWrap(cx, mesh.x[c], mesh.W), dy = mesh.y[c] - cy;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = c; }
  }
  return [mesh.x[best], mesh.y[best]];
}
