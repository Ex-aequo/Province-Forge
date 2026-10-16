// Fair start positions.
//
// 1. Slots are split between continents by size (players + reserves).
// 2. Capitals are spread evenly over each continent: farthest-point seeding, then a
//    few rounds of "move each capital to the centre of its graph-Voronoi region".
// 3. Territories grow round-robin from the capitals (closest free land first) to
//    `startProvinces` each.
// 4. Resources are fixed inside starts: rares are moved out, every start gets the
//    four basics (grain, wood, stone, iron).
// 5. Values are equalised: swap border provinces, then nudge resource amounts, until
//    (max − min) / mean ≤ valueTolerance.
// 6. Rares: every capital gets one within reach on free land; distances reported.
// 7. Praga seeds: free land as far as possible from every start.
// Several attempts are made; the best one (fairness score) is kept.
import { COMPATIBLE, RESOURCE_VALUE, commonResourceFor, provinceValue } from './resources';
import type { Rng } from './rng';
import { BASIC_RESOURCES, RARE_RESOURCES, type Fairness, type GenParams, type Landmass, type Region, type Resource, type StartPosition } from './types';

export interface StartsResult {
  starts: StartPosition[];
  fairness: Fairness | null;
  pragaSeeds: number[];
  issues: string[];
}

const ATTEMPTS = 10;

export function placeStarts(regions: Region[], landmasses: Landmass[], p: GenParams, rng: Rng): StartsResult {
  const issues: string[] = [];
  const isLand = (id: number) => regions[id].kind === 'land';
  const landNb = regions.map((r) => (r.kind === 'land' ? r.neighbors.filter(isLand) : []));
  const continents = landmasses.filter((l) => l.isContinent);
  const total = p.playerSlots + p.reserveSlots;
  if (!continents.length || total === 0) return { starts: [], fairness: null, pragaSeeds: [], issues: ['sem continentes para posições iniciais'] };

  // ---- slots per continent (largest remainder by province count)
  const provs = continents.map((c) => c.provinces);
  const sum = provs.reduce((a, b) => a + b, 0);
  const quota = provs.map((v) => (v / sum) * total);
  const slots = quota.map(Math.floor);
  quota.map((q, i) => ({ i, r: q - Math.floor(q) })).sort((a, b) => b.r - a.r)
    .slice(0, total - slots.reduce((a, b) => a + b, 0)).forEach(({ i }) => slots[i]++);
  // reserves spread round-robin over continents, starting at a random one
  const reserves = continents.map(() => 0);
  let c0 = Math.floor(rng() * continents.length), placedR = 0, guard = 0;
  while (placedR < p.reserveSlots && guard++ < 100) {
    if (reserves[c0] < slots[c0]) { reserves[c0]++; placedR++; }
    c0 = (c0 + 1) % continents.length;
  }

  // snapshot resources so every attempt starts from the generated ones
  const snapRes = regions.map((r) => r.resource);
  const snapAmt = regions.map((r) => r.amount);
  const restore = () => regions.forEach((r, i) => { r.resource = snapRes[i]; r.amount = snapAmt[i]; });

  let best: { starts: StartPosition[]; fairness: Fairness; res: (Resource | undefined)[]; amt: (number | undefined)[] } | null = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    restore();
    const r = tryOnce(regions, landNb, continents, slots, reserves, p, rng);
    if (!r) continue;
    if (!best || r.fairness.score > best.fairness.score) {
      best = { ...r, res: regions.map((x) => x.resource), amt: regions.map((x) => x.amount) };
      best.fairness.attempts = attempt + 1;
    }
    if (best.fairness.score >= 92) break;
  }
  if (!best) {
    restore();
    return { starts: [], fairness: null, pragaSeeds: [], issues: ['não foi possível colocar as posições iniciais (continentes demasiado pequenos para tantos jogadores)'] };
  }
  regions.forEach((r, i) => { r.resource = best!.res[i]; r.amount = best!.amt[i]; r.value = provinceValue(r); r.startSlot = undefined; });
  for (const s of best.starts) for (const id of s.provinces) regions[id].startSlot = s.slot;
  if (best.fairness.valueSpread > p.valueTolerance + 1e-9) issues.push(`diferença de valor entre posições iniciais ${(best.fairness.valueSpread * 100).toFixed(1)}% (acima de ${(p.valueTolerance * 100).toFixed(0)}%)`);

  const pragaSeeds = pickPragaSeeds(regions, best.starts, 3);
  return { starts: best.starts, fairness: best.fairness, pragaSeeds, issues };
}

function tryOnce(
  regions: Region[], landNb: number[][], continents: Landmass[], slots: number[], reserves: number[], p: GenParams, rng: Rng,
): { starts: StartPosition[]; fairness: Fairness } | null {
  const starts: StartPosition[] = [];
  const owner = new Map<number, number>(); // province → start index
  const zoneOf = new Map<number, number>(); // province → start index of its zone

  for (let ci = 0; ci < continents.length; ci++) {
    const cont = continents[ci];
    const pool = regions.filter((r) => r.kind === 'land' && r.landmass === cont.id).map((r) => r.id);
    const k = slots[ci];
    if (!k) continue;
    if (pool.length < k * p.startProvinces * 1.15) return null;
    const inPool = new Set(pool);
    const good = (id: number) => !['mountains', 'tundra', 'marsh', 'desert'].includes(regions[id].terrain!);

    // farthest-point seeding on the land graph
    const caps: number[] = [];
    const goodPool = pool.filter(good);
    caps.push((goodPool.length ? goodPool : pool)[Math.floor(rng() * (goodPool.length || pool.length))]);
    while (caps.length < k) {
      const d = bfs(caps, (id) => landNb[id].filter((o) => inPool.has(o)));
      let bestId = -1, bd = -1;
      for (const id of pool) {
        const v = (d.get(id) ?? 0) * (good(id) ? 1 : 0.6) + rng() * 0.8;
        if (v > bd && !caps.includes(id)) { bd = v; bestId = id; }
      }
      caps.push(bestId);
    }
    // relaxation: weighted graph-Voronoi zones (a power diagram) — each capital moves
    // to the centre of its zone and zone weights adapt until all zones have the same
    // number of provinces. Equal zones = equal room to expand.
    const weight = caps.map(() => 1);
    const nbIn = (id: number) => landNb[id].filter((o) => inPool.has(o));
    let zone = new Map<number, number>();
    for (let it = 0; it < 14; it++) {
      zone = weightedZones(caps, weight, nbIn);
      const size = caps.map(() => 0);
      for (const z of zone.values()) size[z]++;
      const target = pool.length / k;
      for (let c = 0; c < k; c++) {
        weight[c] = Math.min(4, Math.max(0.25, weight[c] * Math.pow(Math.max(1, size[c]) / target, 0.5)));
        if (it % 2 === 1) continue; // alternate: weights, then centres
        const members = pool.filter((id) => zone.get(id) === c);
        if (members.length < 2) continue;
        const sub = new Set(members);
        let bestId = caps[c], bestEcc = Infinity;
        const cand = members.length > 30 ? members.filter((_, i) => i % Math.ceil(members.length / 30) === 0) : members;
        for (const m of cand) {
          if (!good(m) && members.some(good)) continue;
          const d = bfs([m], (id) => landNb[id].filter((o) => sub.has(o)));
          let ecc = 0, tot = 0;
          for (const v of d.values()) { ecc = Math.max(ecc, v); tot += v; }
          const score = ecc + (tot / Math.max(1, d.size)) * 0.5;
          if (score < bestEcc) { bestEcc = score; bestId = m; }
        }
        caps[c] = bestId;
      }
    }
    // final zones: balanced flood — every round each zone takes its nearest free
    // province, so zone sizes end up within a province or two of each other
    zone = balancedZones(caps, nbIn, pool.length);
    for (const [id, z] of zone) zoneOf.set(id, starts.length + z);
    if (typeof process !== "undefined" && process.env?.DEBUG_ZONES) { const sz = caps.map(() => 0); for (const z of zone.values()) sz[z]++; console.log('zones', sz.join(','), 'w', weight.map((x) => x.toFixed(2)).join(',')); }
    for (const cap of caps) {
      const idx = starts.length;
      starts.push({ slot: idx, reserved: false, landmass: cont.id, capital: cap, provinces: [cap], value: 0, freeNearby: 0, rareDistance: 0 });
      owner.set(cap, idx);
    }
  }

  // ---- grow territories round-robin, closest land first
  const distFromCap = starts.map((s) => bfs([s.capital], (id) => landNb[id]));
  for (let round = 1; round < p.startProvinces; round++) {
    const order = starts.map((_, i) => i).sort(() => rng() - 0.5);
    for (const i of order) {
      const s = starts[i];
      let bestId = -1, bd = Infinity;
      for (const m of s.provinces) for (const o of landNb[m]) {
        if (owner.has(o) || regions[o].landmass !== s.landmass) continue;
        // keep a one-province buffer from other capitals' territories when possible
        const touchesOther = landNb[o].some((q) => owner.has(q) && owner.get(q) !== i);
        const foreign = zoneOf.get(o) !== i;
        const d = (distFromCap[i].get(o) ?? 99) + (touchesOther ? 1.5 : 0) + (foreign ? 3 : 0) + rng() * 0.3;
        if (d < bd) { bd = d; bestId = o; }
      }
      if (bestId < 0) return null;
      s.provinces.push(bestId);
      owner.set(bestId, i);
    }
  }

  // ---- resources inside starts: no rares, all four basics
  const fixResources = () => {
    for (const s of starts) {
      for (const id of s.provinces) {
        const r = regions[id];
        if (RARE_RESOURCES.includes(r.resource!)) { r.resource = commonResourceFor(r, rng); r.amount = 2; }
      }
      for (const basic of BASIC_RESOURCES) {
        if (s.provinces.some((id) => regions[id].resource === basic)) continue;
        // replace a duplicated resource, preferring a province whose terrain fits
        const counts = new Map<Resource, number>();
        for (const id of s.provinces) counts.set(regions[id].resource!, (counts.get(regions[id].resource!) ?? 0) + 1);
        const cands = s.provinces.filter((id) => (counts.get(regions[id].resource!) ?? 0) > 1 || !BASIC_RESOURCES.includes(regions[id].resource!));
        cands.sort((a, b) => Number(COMPATIBLE[basic].includes(regions[b].terrain!)) - Number(COMPATIBLE[basic].includes(regions[a].terrain!)));
        const pick = cands[0] ?? s.provinces[s.provinces.length - 1];
        regions[pick].resource = basic;
        regions[pick].amount = Math.max(1, regions[pick].amount ?? 1);
      }
    }
  };
  fixResources();
  const value = (s: StartPosition) => s.provinces.reduce((a, id) => a + provinceValue(regions[id]), 0);

  // ---- equalise values. (a) swap a border province for a free neighbour
  for (let it = 0; it < 300; it++) {
    const vals = starts.map(value);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const hi = vals.indexOf(Math.max(...vals)), lo = vals.indexOf(Math.min(...vals));
    if ((vals[hi] - vals[lo]) / mean <= p.valueTolerance * 0.6) break;
    const i = it % 2 ? hi : lo;
    const s = starts[i];
    const wantDelta = mean - vals[i]; // + = needs more value
    let bestSwap: [number, number] | null = null, bestGain = 0;
    const holds = (id: number, list: number[]) => BASIC_RESOURCES.includes(regions[id].resource!) && list.filter((x) => regions[x].resource === regions[id].resource).length === 1;
    for (const out of s.provinces) {
      if (out === s.capital || holds(out, s.provinces)) continue;
      const rest = s.provinces.filter((x) => x !== out);
      if (!connected(rest, landNb)) continue;
      for (const m of rest) for (const inn of landNb[m]) {
        if (owner.has(inn) || regions[inn].landmass !== s.landmass || zoneOf.get(inn) !== i) continue;
        if (RARE_RESOURCES.includes(regions[inn].resource!)) continue;
        const delta = provinceValue(regions[inn]) - provinceValue(regions[out]);
        const gain = Math.abs(wantDelta) - Math.abs(wantDelta - delta);
        if (gain > bestGain) { bestGain = gain; bestSwap = [out, inn]; }
      }
    }
    if (!bestSwap) continue;
    const [out, inn] = bestSwap;
    s.provinces = s.provinces.filter((x) => x !== out).concat(inn);
    owner.delete(out); owner.set(inn, i);
  }
  fixResources();
  // (b) nudge resource amounts (1–3) — fine adjustment, keeps all basics
  for (let it = 0; it < 400; it++) {
    const vals = starts.map(value);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const hi = vals.indexOf(Math.max(...vals)), lo = vals.indexOf(Math.min(...vals));
    if ((vals[hi] - vals[lo]) / mean <= p.valueTolerance * 0.5) break;
    const i = it % 2 ? hi : lo;
    const up = i === lo;
    const cands = starts[i].provinces.filter((id) => (up ? (regions[id].amount ?? 1) < 3 : (regions[id].amount ?? 1) > 1));
    if (!cands.length) continue;
    // pick the step that best approaches the mean
    const need = Math.abs(mean - vals[i]);
    cands.sort((a, b) => Math.abs(need - RESOURCE_VALUE[regions[a].resource!]) - Math.abs(need - RESOURCE_VALUE[regions[b].resource!]));
    regions[cands[0]].amount = (regions[cands[0]].amount ?? 1) + (up ? 1 : -1);
  }

  // capital first in each list, contiguity check
  for (const s of starts) {
    s.provinces = [s.capital, ...s.provinces.filter((x) => x !== s.capital)];
    if (!connected(s.provinces, landNb)) return null;
  }

  // ---- rares: no rare inside starts (already), make sure each capital has one nearby
  const isRare = (id: number) => RARE_RESOURCES.includes(regions[id].resource!);
  // a rare touching a start territory would be a free head start: make it common
  for (const s of starts) for (const id of s.provinces) for (const o of landNb[id]) {
    if (!owner.has(o) && isRare(o)) { regions[o].resource = commonResourceFor(regions[o], rng); regions[o].amount = 1 + Math.floor(rng() * 2); }
  }
  const REACH = 5;
  for (const s of starts) {
    const d = bfs([s.capital], (id) => landNb[id], REACH);
    if ([...d.keys()].some((id) => isRare(id) && !owner.has(id))) continue;
    // place one on free land 3–5 steps away, compatible terrain if possible
    const cands = [...d.entries()].filter(([id, dd]) => dd >= 3 && !owner.has(id) && !landNb[id].some(isRare) && !landNb[id].some((o) => owner.has(o))).map(([id]) => id);
    if (!cands.length) continue;
    cands.sort((a, b) => fitRare(regions[b]) - fitRare(regions[a]));
    const pick = cands[0];
    regions[pick].resource = fitRare(regions[pick]) >= 1 && COMPATIBLE.spices.includes(regions[pick].terrain!) && !COMPATIBLE.gold.includes(regions[pick].terrain!) ? 'spices' : 'gold';
    regions[pick].amount = 1;
  }

  // top up rares to the target share, on free land away from starts and other rares
  const landIds = regions.filter((r) => r.kind === 'land').map((r) => r.id);
  const want = Math.round(landIds.length * p.rareShare);
  let have = landIds.filter(isRare).length;
  const pool = landIds.filter((id) => !owner.has(id) && fitRare(regions[id]) > 0 && !landNb[id].some((o) => owner.has(o)));
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  for (const id of pool) {
    if (have >= want) break;
    // free land away from starts is scarce (starts + their borders cover most of it),
    // so rares may sit next to each other here: contested "gold fields"
    if (isRare(id)) continue;
    const r = regions[id];
    const g = COMPATIBLE.gold.includes(r.terrain!), sp = COMPATIBLE.spices.includes(r.terrain!);
    r.resource = sp && (!g || rng() < 0.5) ? 'spices' : 'gold';
    r.amount = 1 + (rng() < 0.3 ? 1 : 0);
    have++;
  }

  // ---- metrics
  const reserveIdx = new Set<number>();
  for (let ci = 0; ci < continents.length; ci++) {
    const mine = starts.map((s, i) => ({ s, i })).filter((o) => o.s.landmass === continents[ci].id);
    // reserves = the starts with the most free land around them (late joiners need room)
    const want = reserves[ci];
    const scored = mine.map((o) => ({ i: o.i, free: freeAround(o.i, owner, zoneOf) })).sort((a, b) => b.free - a.free);
    for (let k = 0; k < want && k < scored.length; k++) reserveIdx.add(scored[k].i);
  }
  for (const [i, s] of starts.entries()) {
    s.reserved = reserveIdx.has(i);
    s.value = Math.round(value(s) * 10) / 10;
    s.freeNearby = freeAround(i, owner, zoneOf);
    const d = bfs([s.capital], (id) => landNb[id], 30);
    let rd = 99;
    for (const [id, dd] of d) if (isRare(id) && dd < rd) rd = dd;
    s.rareDistance = rd;
  }
  // player slots first, then reserves (slot numbers are what the server assigns)
  starts.sort((a, b) => Number(a.reserved) - Number(b.reserved));
  starts.forEach((s, i) => (s.slot = i));

  const vals = starts.map((s) => s.value);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const frees = starts.map((s) => s.freeNearby);
  const rds = starts.map((s) => s.rareDistance);
  let minCap = Infinity;
  for (const s of starts) {
    const d = bfs([s.capital], (id) => landNb[id]);
    for (const t of starts) if (t !== s && d.has(t.capital)) minCap = Math.min(minCap, d.get(t.capital)!);
  }
  const valueSpread = (Math.max(...vals) - Math.min(...vals)) / mean;
  const freeMean = frees.reduce((a, b) => a + b, 0) / frees.length;
  const freeSpread = (Math.max(...frees) - Math.min(...frees)) / Math.max(1, freeMean);
  const rareSpread = Math.max(...rds) - Math.min(...rds);
  const score = Math.max(0, Math.min(100, Math.round(100 - valueSpread * 300 - freeSpread * 25 - rareSpread * 3 - Math.max(0, 4 - minCap) * 8)));
  return {
    starts,
    fairness: {
      valueSpread: Math.round(valueSpread * 1000) / 1000,
      valueMin: Math.min(...vals), valueMax: Math.max(...vals),
      freeMin: Math.min(...frees), freeMax: Math.max(...frees),
      minCapitalDistance: Number.isFinite(minCap) ? minCap : 0,
      rareDistMin: Math.min(...rds), rareDistMax: Math.max(...rds),
      score, attempts: 1,
    },
  };
}

function fitRare(r: Region) {
  return (COMPATIBLE.gold.includes(r.terrain!) ? 1 : 0) + (COMPATIBLE.spices.includes(r.terrain!) ? 1 : 0);
}

/** Free provinces in this start's zone (land closer to it than to any other start). */
function freeAround(i: number, owner: Map<number, number>, zoneOf: Map<number, number>) {
  let n = 0;
  for (const [id, z] of zoneOf) if (z === i && !owner.has(id)) n++;
  return n;
}

/** Round-robin flood: each zone claims one adjacent province per round (nearest to its
 *  capital first). Zones that are boxed in stop; the rest keep going. */
function balancedZones(caps: number[], next: (id: number) => number[], total: number) {
  const zone = new Map<number, number>();
  const dist = caps.map((c) => bfs([c], next));
  const frontier = caps.map((c, z) => { zone.set(c, z); return new Set(next(c)); });
  const size = caps.map(() => 1);
  let progress = true;
  while (zone.size < total && progress) {
    progress = false;
    const order = caps.map((_, z) => z).sort((a, b) => size[a] - size[b]);
    for (const z of order) {
      let best = -1, bd = Infinity;
      for (const f of frontier[z]) {
        if (zone.has(f)) { frontier[z].delete(f); continue; }
        const d = dist[z].get(f) ?? 999;
        if (d < bd) { bd = d; best = f; }
      }
      if (best < 0) continue;
      zone.set(best, z); size[z]++; progress = true;
      for (const o of next(best)) if (!zone.has(o)) frontier[z].add(o);
    }
  }
  return zone;
}

/** Multi-source Dijkstra where each source's edges cost its weight. */
function weightedZones(caps: number[], w: number[], next: (id: number) => number[]) {
  const dist = new Map<number, number>(), zone = new Map<number, number>();
  const heap: [number, number, number][] = [];
  const push = (d: number, id: number, z: number) => { heap.push([d, id, z]); let i = heap.length - 1; while (i > 0) { const pI = (i - 1) >> 1; if (heap[pI][0] <= heap[i][0]) break; [heap[pI], heap[i]] = [heap[i], heap[pI]]; i = pI; } };
  const pop = () => { const top = heap[0], last = heap.pop()!; if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  caps.forEach((c, z) => { dist.set(c, 0); zone.set(c, z); push(0, c, z); });
  while (heap.length) {
    const [d, id, z] = pop();
    if (d > (dist.get(id) ?? Infinity) || zone.get(id) !== z) continue;
    for (const o of next(id)) {
      const nd = d + w[z];
      if (nd < (dist.get(o) ?? Infinity)) { dist.set(o, nd); zone.set(o, z); push(nd, o, z); }
    }
  }
  return zone;
}

function connected(ids: number[], landNb: number[][]) {
  if (ids.length <= 1) return true;
  const set = new Set(ids);
  const seen = new Set([ids[0]]);
  const q = [ids[0]];
  for (let h = 0; h < q.length; h++) for (const o of landNb[q[h]]) if (set.has(o) && !seen.has(o)) { seen.add(o); q.push(o); }
  return seen.size === ids.length;
}

export function bfs(start: number[], next: (id: number) => number[], maxDepth = Infinity): Map<number, number> {
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

/** Free land provinces as far as possible from every start (land + sea graph). */
function pickPragaSeeds(regions: Region[], starts: StartPosition[], n: number): number[] {
  const all = starts.flatMap((s) => s.provinces);
  const dStart = bfs(all, (id) => regions[id].neighbors);
  const owned = new Set(all);
  const seeds: number[] = [];
  for (let k = 0; k < n; k++) {
    const dSeed = seeds.length ? bfs(seeds, (id) => regions[id].neighbors) : null;
    let best = -1, bd = -1;
    for (const r of regions) {
      if (r.kind !== 'land' || owned.has(r.id)) continue;
      const a = dStart.get(r.id) ?? 0;
      const b = dSeed ? (dSeed.get(r.id) ?? 99) * 0.6 : 99;
      const v = Math.min(a, b);
      if (v > bd) { bd = v; best = r.id; }
    }
    if (best >= 0) seeds.push(best);
  }
  return seeds;
}
