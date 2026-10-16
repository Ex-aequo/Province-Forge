// FAKE turn states for previewing the political map. Not game logic: it only has to
// look like a plausible game at a given stage (start → mid → late).
import { NameGen, countryName } from '../gen/names';
import { colourDistance, hslHex, makePalette } from '../gen/countries';
import { createRng, type Rng } from '../gen/rng';
import type { Culture, GeneratedMap } from '../gen/types';
import type { Country, PragaLevel, ProvinceState, TurnState } from './state';

export interface TestStateOptions {
  seed: string;
  /** 0 = first turn, 1 = late game. */
  progress: number;
  /** 0 = no Praga, 1 = rampant. */
  praga: number;
  countries: number;
}

export function makeTestState(map: GeneratedMap, o: TestStateOptions): TurnState {
  const rng = createRng(`${o.seed}::test-state`);
  const land = map.regions.filter((r) => r.kind === 'land');
  const N = land.length;
  const isLand = (id: number) => map.regions[id].kind === 'land';
  const landNb = (id: number) => map.regions[id].neighbors.filter(isLand);
  // overseas neighbours: land provinces that share a sea zone
  const overseas = (id: number) => {
    const out = new Set<number>();
    for (const s of map.regions[id].neighbors) if (map.regions[s].kind === 'sea') for (const l of map.regions[s].neighbors) if (isLand(l) && l !== id) out.add(l);
    return [...out];
  };

  // ---- players start on the generator's fair start positions (reserves stay empty)
  const playerStarts = map.starts.filter((st) => !st.reserved).slice(0, o.countries);
  const reservedSet = new Set(map.starts.filter((st) => st.reserved).flatMap((st) => st.provinces));
  const seeds = playerStarts.map((st) => st.capital);

  // ---- countries: names from the culture of their seed's continent, distinct colours
  const gen = new NameGen(createRng(`${o.seed}::country-names`));
  const countries: Country[] = seeds.map((s, i) => {
    const culture: Culture = map.landmasses[map.regions[s].landmass].culture ?? 'iberian';
    const nm = countryName(gen, culture, rng);
    return { id: `c${i + 1}`, name: nm.short, fullName: nm.full, color: '#888' };
  });
  const owner = new Map<number, number>(); // province → country index
  playerStarts.forEach((st, i) => st.provinces.forEach((p) => owner.set(p, i)));

  // ---- expansion: weighted round-robin into neighbouring free land
  // Everyone starts equal; differences only appear as the game advances (that is what
  // conquest does). Growth always goes to the country furthest below its share.
  const strength = countries.map(() => Math.exp(gaussian(rng) * 0.45 * o.progress));
  const startTotal = owner.size;
  const target = Math.min(N - reservedSet.size, Math.round(startTotal + (N - reservedSet.size - startTotal) * 0.88 * o.progress));
  const ownedCount = playerStarts.map((st) => st.provinces.length);
  const frontier = countries.map((_, i) => new Set<number>(playerStarts[i].provinces.flatMap(landNb).filter((q) => !reservedSet.has(q))));
  const overseasOk = o.progress > 0.45;
  let guard = 0;
  while (owner.size < target && guard++ < N * 50) {
    // pick a country by strength among those that can still grow
    let total = 0;
    const can = countries.map((_, i) => {
      for (const f of frontier[i]) if (owner.has(f) || reservedSet.has(f)) frontier[i].delete(f);
      return frontier[i].size > 0 ? strength[i] : 0;
    });
    for (const v of can) total += v;
    if (total === 0) {
      if (!overseasOk) break;
      // jump the sea: give a random country a foothold overseas
      const i = Math.floor(rng() * countries.length);
      const mine = [...owner].filter(([, c]) => c === i).map(([p]) => p);
      const free = mine.flatMap(overseas).filter((p) => !owner.has(p) && !reservedSet.has(p));
      if (!free.length) continue;
      const p = free[Math.floor(rng() * free.length)];
      owner.set(p, i);
      ownedCount[i]++;
      for (const q of landNb(p)) frontier[i].add(q);
      continue;
    }
    let ci = -1, bestRatio = Infinity;
    for (let i = 0; i < can.length; i++) {
      if (!can[i]) continue;
      const ratio = ownedCount[i] / strength[i] + rng() * 0.01;
      if (ratio < bestRatio) { bestRatio = ratio; ci = i; }
    }
    ownedCount[ci]++;
    const opts = [...frontier[ci]];
    const p = opts[Math.floor(rng() * opts.length)];
    owner.set(p, ci);
    frontier[ci].delete(p);
    for (const q of landNb(p)) if (!owner.has(q) && !reservedSet.has(q)) frontier[ci].add(q);
    if (overseasOk && rng() < 0.02) for (const q of overseas(p)) if (!owner.has(q) && !reservedSet.has(q)) frontier[ci].add(q);
  }

  // ---- colours: well-separated palette, neighbours get the most different hues
  const palette = makePalette(countries.length, rng);
  const touching = countries.map(() => new Set<number>());
  for (const [p, c] of owner) for (const q of map.regions[p].neighbors) { const d = owner.get(q); if (d !== undefined && d !== c) touching[c].add(d); }
  const order = countries.map((_, i) => i).sort((a, b) => touching[b].size - touching[a].size);
  const used = new Map<number, [number, number, number]>();
  for (const c of order) {
    let best = 0, bestScore = -1;
    palette.forEach((col, k) => {
      if ([...used.values()].includes(col)) return;
      let score = Infinity;
      for (const n of touching[c]) { const u = used.get(n); if (u) score = Math.min(score, colourDistance(col, u)); }
      if (score > bestScore) { bestScore = score; best = k; }
    });
    used.set(c, palette[best]);
    countries[c].color = hslHex(palette[best]);
  }

  // ---- provinces: owner, occupation from wars, Praga
  const provinces: Record<number, ProvinceState> = {};
  for (const r of land) {
    const c = owner.get(r.id);
    const id = c === undefined ? null : countries[c].id;
    provinces[r.id] = { owner: id, controller: id, praga: 0 };
  }
  const wars = Math.round(o.progress * 9);
  for (let w = 0; w < wars; w++) {
    const a = Math.floor(rng() * countries.length);
    const enemies = [...touching[a]];
    if (!enemies.length) continue;
    const b = enemies[Math.floor(rng() * enemies.length)];
    const border = land.filter((r) => owner.get(r.id) === b && r.neighbors.some((q) => owner.get(q) === a)).map((r) => r.id);
    const depth = 1 + Math.floor(rng() * (1 + o.progress * 4));
    const taken = bfs(border.slice(0, 1 + Math.floor(rng() * 3)), (id) => landNb(id).filter((q) => owner.get(q) === b), depth);
    const cap = Math.max(1, Math.floor(ownedCount[b] * 0.4)); // a war never swallows a whole country here
    let n = 0;
    for (const [p] of taken) { if (n++ >= cap) break; provinces[p].controller = countries[a].id; }
  }
  if (o.praga > 0) {
    const nSeeds = 1 + Math.round(o.praga * 3);
    const radius = 1 + o.praga * 7;
    const pseeds = map.pragaSeeds.length ? map.pragaSeeds.slice(0, nSeeds) : Array.from({ length: nSeeds }, () => land[Math.floor(rng() * N)].id);
    const dist = bfs(pseeds, (id) => landNb(id), Math.ceil(radius));
    for (const [p, d] of dist) {
      const lvl = Math.max(0, Math.min(3, Math.round(3.4 * (1 - d / radius) + (rng() - 0.5) * 1.2)));
      provinces[p].praga = lvl as PragaLevel;
    }
  }

  // ---- exploration: owned land plus a radius that grows with the game
  const known: Record<string, number[]> = {};
  const reach = 1 + Math.round(o.progress * 5);
  countries.forEach((c, i) => {
    const mine = [...owner].filter(([, k]) => k === i).map(([p]) => p);
    known[c.id] = [...bfs(mine, (id) => map.regions[id].neighbors, reach).keys()];
  });

  return {
    turn: Math.round(1 + o.progress * 240), countries, provinces, known,
    reservedSlots: map.starts.filter((st) => st.reserved).map((st) => st.slot),
  };
}

function bfs(start: number[], next: (id: number) => number[], maxDepth = Infinity): Map<number, number> {
  const d = new Map<number, number>();
  const q: number[] = [];
  for (const s of start) if (!d.has(s)) { d.set(s, 0); q.push(s); }
  for (let h = 0; h < q.length; h++) {
    const u = q[h], du = d.get(u)!;
    if (du >= maxDepth) continue;
    for (const v of next(u)) if (!d.has(v)) { d.set(v, du + 1); q.push(v); }
  }
  return d;
}

function gaussian(rng: Rng) {
  return Math.sqrt(-2 * Math.log(Math.max(1e-9, rng()))) * Math.cos(2 * Math.PI * rng());
}

