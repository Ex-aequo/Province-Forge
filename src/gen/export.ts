// Static-map export: the contract consumed by the game server. Geometry is frozen
// at generation time — the game stores THIS, never the seed (generator code evolves).
import { GENERATOR_VERSION } from './generate';
import { BIOMES, RESOURCES, TERRAINS, type GeneratedMap } from './types';

const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function toExportJson(map: GeneratedMap) {
  return {
    format: 'ex-aequo/static-map',
    formatVersion: 4,
    generator: GENERATOR_VERSION,
    createdAt: new Date().toISOString(),
    params: map.params,
    world: { width: map.width, height: map.height, wrapX: true },
    landmasses: map.landmasses,
    regions: map.regions.map((r) => ({
      id: r.id,
      kind: r.kind,
      seaKind: r.seaKind ?? null,
      name: r.name ?? null,
      landmass: r.landmass,
      coastal: r.coastal,
      // gameplay: lakes and ice are impassable and have no neighbours
      passable: r.kind === 'land' || r.kind === 'sea',
      terrain: r.terrain ?? null,
      hasRiver: r.hasRiver ?? false,
      riverNeighbors: r.riverNeighbors,
      resource: r.resource ?? null,
      amount: r.amount ?? null,
      value: r.value ?? null,
      startSlot: r.startSlot ?? null,
      area: Math.round(r.area),
      cellCount: r.cells.length,
      label: r.label.map(r1),
      neighbors: r.neighbors,
      rings: r.rings,
    })),
    borders: map.borders.map((b) => ({ a: b.a, b: b.b, kind: b.kind, closed: b.closed, pts: b.pts })),
    rivers: map.rivers.map((r) => ({ id: r.id, name: r.name ?? null, pts: r.pts.map(r1), widths: r.widths.map((w) => Math.round(w * 100) / 100) })),
    // movement graph: every passable adjacency once, typed, with river crossings flagged
    links: map.regions.flatMap((r) => r.neighbors.filter((o) => o > r.id).map((o) => {
      const q = map.regions[o];
      const kind = r.kind === 'land' && q.kind === 'land' ? 'land' : r.kind === 'sea' && q.kind === 'sea' ? 'sea' : 'coast';
      return { a: r.id, b: o, kind, river: r.riverNeighbors.includes(o) };
    })),
    // start positions: slots 0..playerSlots-1 for players, then reserves (reserved: true).
    // The SERVER must keep reserved territories untouchable until a player is assigned.
    starts: map.starts,
    fairness: map.fairness,
    pragaSeeds: map.pragaSeeds,
    legend: { terrains: TERRAINS, biomes: BIOMES, resources: RESOURCES, cellTypes: ['land', 'sea', 'lake', 'ice'] },
    cells: {
      x: Array.from(map.cellX, r1),
      y: Array.from(map.cellY, r1),
      elevation: Array.from(map.elevation, r3),
      region: Array.from(map.cellRegion),
      type: Array.from(map.cellType),
      biome: Array.from(map.biome),
      terrain: Array.from(map.cellTerrain),
    },
    stats: map.stats,
    issues: map.issues,
  };
}
