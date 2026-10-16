// The full pipeline. Each stage gets its own random sub-stream so changing one
// stage's parameters does not reshuffle the others.
import { buildBorders } from './borders';
import { generateClimate } from './climate';
import { generateElevation } from './elevation';
import { generateHydrology } from './hydrology';
import { nameMap } from './names';
import { assignResources } from './resources';
import { placeStarts } from './starts';
import { nameStarts } from './countries';
import type { Mesh } from './mesh';
import { generateMesh } from './mesh';
import { buildRegions } from './regions';
import { subRng } from './rng';
import { CT, RESOURCES, resolveParams, TERRAINS, type GeneratedMap, type GenParams, type MapStats, type Region, type Terrain, type ValidationIssue } from './types';

export const GENERATOR_VERSION = '0.4.0';

export function generateMap(input: GenParams): GeneratedMap {
  const p = resolveParams(input);
  const timings: Record<string, number> = {};
  let t = performance.now();
  const lap = (name: string) => { const now = performance.now(); timings[name] = Math.round(now - t); t = now; };

  const mesh = generateMesh(p.width, p.height, p.cellCount, p.relaxIterations, subRng(p.seed, 'mesh'));
  lap('mesh');
  const { elevation, land, owner } = generateElevation(mesh, p, subRng(p.seed, 'elevation'));
  lap('elevation');
  const hydro = generateHydrology(mesh, land, elevation, p, subRng(p.seed, 'hydrology'));
  lap('hydrology');
  const climate = generateClimate(mesh, elevation, hydro, p, subRng(p.seed, 'climate'));
  lap('climate');
  const { cellRegion, regions, landmasses, minProvinceCells } = buildRegions(
    mesh, hydro.cellType, elevation, owner, hydro.riverEdges, climate.cellTerrain, p, subRng(p.seed, 'provinces'), subRng(p.seed, 'seazones'));
  lap('regions');
  const { borders, ringFailures } = buildBorders(mesh, cellRegion, regions, hydro.riverEdges, p, subRng(p.seed, 'borders'));
  lap('borders');

  nameMap({ regions, landmasses, rivers: hydro.rivers, width: p.width }, mesh.x, subRng(p.seed, 'names'));
  lap('names');
  assignResources(regions, climate.biome, p.rareShare, subRng(p.seed, 'resources'));
  const startsRes = placeStarts(regions, landmasses, p, subRng(p.seed, 'starts'));
  nameStarts(startsRes.starts, regions, landmasses, subRng(p.seed, 'countries'));
  lap('starts');

  const issues = validate(mesh, cellRegion, regions, landmasses.filter((l) => l.isContinent).length, minProvinceCells, ringFailures);
  if (hydro.lakes < p.lakeCount) issues.push({ level: 'warn', message: `só cabem ${hydro.lakes} de ${p.lakeCount} lagos pedidos (falta terreno interior baixo)` });
  for (const m of startsRes.issues) issues.push({ level: 'warn', message: m });
  if (!hydro.rivers.length) issues.push({ level: 'warn', message: 'nenhum rio foi gerado' });
  lap('validate');

  const landRegions = regions.filter((r) => r.kind === 'land');
  const seaRegions = regions.filter((r) => r.kind === 'sea');
  const sizes = landRegions.map((r) => r.cells.length);
  const areas = landRegions.map((r) => r.area);
  const meanA = areas.reduce((s, a) => s + a, 0) / Math.max(1, areas.length);
  const sdA = Math.sqrt(areas.reduce((s, a) => s + (a - meanA) ** 2, 0) / Math.max(1, areas.length));
  let smallest = landRegions[0]?.id ?? -1;
  for (const r of landRegions) if (r.cells.length < regions[smallest].cells.length) smallest = r.id;
  let landCells = 0;
  for (let i = 0; i < mesh.n; i++) if (hydro.cellType[i] === CT.Land) landCells++;
  const terrainCounts = Object.fromEntries(TERRAINS.map((t) => [t, 0])) as Record<Terrain, number>;
  for (const r of landRegions) if (r.terrain) terrainCounts[r.terrain]++;
  const riverCrossings = landRegions.reduce((s, r) => s + r.riverNeighbors.length, 0) / 2;
  const resourceCounts = Object.fromEntries(RESOURCES.map((t) => [t, 0])) as Record<(typeof RESOURCES)[number], number>;
  for (const r of landRegions) if (r.resource) resourceCounts[r.resource]++;

  const stats: MapStats = {
    cells: mesh.n,
    landCells,
    landPct: Math.round((1000 * landCells) / mesh.n) / 10,
    landProvinces: landRegions.length,
    seaZones: seaRegions.length,
    coastalZones: seaRegions.filter((r) => r.seaKind === 'coastal').length,
    oceanZones: seaRegions.filter((r) => r.seaKind === 'ocean').length,
    provinceCellsMin: Math.min(...sizes),
    provinceCellsMean: Math.round((10 * sizes.reduce((s, a) => s + a, 0)) / Math.max(1, sizes.length)) / 10,
    provinceCellsMax: Math.max(...sizes),
    provinceAreaCv: Math.round((100 * sdA) / meanA) / 100,
    smallestProvinceId: smallest,
    rivers: hydro.rivers.length,
    lakes: hydro.lakes,
    terrainCounts,
    riverCrossings,
    resourceCounts,
    timings,
  };

  return {
    params: { ...p, continentSizes: [...p.continentSizes] as [number, number, number] },
    width: p.width,
    height: p.height,
    cellX: mesh.x,
    cellY: mesh.y,
    elevation,
    cellRegion,
    cellType: hydro.cellType,
    biome: climate.biome,
    cellTerrain: climate.cellTerrain,
    temperature: climate.temperature,
    moisture: climate.moisture,
    rivers: hydro.rivers,
    triXY: mesh.triXY,
    triCell: mesh.triCell,
    cellPolys: mesh.polys,
    regions,
    starts: startsRes.starts,
    fairness: startsRes.fairness,
    pragaSeeds: startsRes.pragaSeeds,
    borders,
    landmasses,
    stats,
    issues,
    findCell: mesh.findCell,
  };
}

function validate(mesh: Mesh, cellRegion: Int32Array, regions: Region[], continents: number, minProvinceCells: number, ringFailures: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let unassigned = 0;
  for (let i = 0; i < mesh.n; i++) if (cellRegion[i] < 0) unassigned++;
  if (unassigned) issues.push({ level: 'error', message: `${unassigned} células não pertencem a nenhuma região` });

  // every region must be one contiguous piece
  let split = 0;
  for (const r of regions) {
    if (!r.cells.length) continue;
    const seen = new Set<number>([r.cells[0]]);
    const q = [r.cells[0]];
    for (let h = 0; h < q.length; h++) for (const j of mesh.nbrs[q[h]]) if (cellRegion[j] === r.id && !seen.has(j)) { seen.add(j); q.push(j); }
    if (seen.size !== r.cells.length) split++;
  }
  if (split) issues.push({ level: 'error', message: `${split} regiões estão divididas em várias partes` });

  const empty = regions.filter((r) => r.cells.length === 0).length;
  if (empty) issues.push({ level: 'error', message: `${empty} regiões vazias` });

  const passable = regions.filter((r) => r.kind === 'land' || r.kind === 'sea');
  const orphans = passable.filter((r) => r.cells.length && r.neighbors.length === 0).length;
  if (orphans) issues.push({ level: 'error', message: `${orphans} regiões não têm vizinhos` });

  // coastal land must touch a sea zone (it is reachable by navies)
  let landlockedCoast = 0;
  for (const r of regions) {
    if (r.kind !== 'land') continue;
    const touchesWater = r.cells.some((c) => Array.from(mesh.nbrs[c]).some((j) => cellRegion[j] >= 0 && regions[cellRegion[j]].kind === 'sea'));
    if (touchesWater && !r.neighbors.some((o) => regions[o].kind === 'sea')) landlockedCoast++;
  }
  if (landlockedCoast) issues.push({ level: 'error', message: `${landlockedCoast} províncias costeiras não tocam em nenhuma zona marítima` });

  // whole world graph must be connected (every province reachable by land or sea)
  const seen = new Uint8Array(regions.length);
  const start = passable[0]?.id ?? 0;
  const q = [start];
  seen[start] = 1;
  for (let h = 0; h < q.length; h++) for (const o of regions[q[h]].neighbors) if (!seen[o]) { seen[o] = 1; q.push(o); }
  const reachable = passable.filter((r) => r.cells.length).length;
  if (q.length !== reachable) issues.push({ level: 'error', message: `o grafo de regiões está desligado (${reachable - q.length} inacessíveis)` });

  if (continents !== 3) issues.push({ level: 'warn', message: `formaram-se ${continents} continentes em vez de 3 (fundiram-se ou um é demasiado pequeno). Experimente outra semente ou quotas mais pequenas.` });

  const tiny = regions.filter((r) => r.kind === 'land' && r.cells.length < minProvinceCells).length;
  if (tiny) issues.push({ level: 'warn', message: `${tiny} províncias abaixo do tamanho mínimo (${minProvinceCells} células), normalmente ilhas pequenas` });

  if (ringFailures) issues.push({ level: 'warn', message: `${ringFailures} contornos de polígonos não fecharam` });

  const crossSeam = regions.filter((r) => r.neighbors.some((o) => Math.abs(r.label[0] - regions[o].label[0]) > mesh.W / 2)).length;
  if (crossSeam === 0) issues.push({ level: 'warn', message: 'nenhuma adjacência atravessa a junção leste–oeste (inesperado)' });
  return issues;
}
