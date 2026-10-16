// Names and colours for the start positions, so a game can turn each slot into a
// country (Praga: every slot is a kingdom from turn 1, run by a player or a bot).
import { NameGen, countryName } from './names';
import type { Rng } from './rng';
import type { Culture, Landmass, LocalName, Region, StartPosition } from './types';

export interface StartCountry { name: LocalName; fullName: LocalName; color: string }

/** HSL triples (h 0–360, s, l in %) with well-spread hues and alternating lightness. */
export function makePalette(n: number, rng: Rng): [number, number, number][] {
  const out: [number, number, number][] = [];
  const start = rng() * 360;
  for (let i = 0; i < n; i++) {
    const h = (start + i * 137.508) % 360;
    const s = 48 + ((i * 7) % 3) * 9;
    const l = 40 + ((i * 5) % 4) * 6;
    out.push([h, s, l]);
  }
  return out;
}
export function colourDistance(a: [number, number, number], b: [number, number, number]) {
  const dh = Math.min(Math.abs(a[0] - b[0]), 360 - Math.abs(a[0] - b[0]));
  return dh + Math.abs(a[2] - b[2]) * 2;
}
export function hslHex([h, s, l]: [number, number, number]) {
  s /= 100; l /= 100;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Give every start position a name (from its continent's culture) and a colour that
 *  differs as much as possible from the starts around it (within 3 land steps). */
export function nameStarts(starts: StartPosition[], regions: Region[], landmasses: Landmass[], rng: Rng): void {
  const gen = new NameGen(rng);
  const used = new Set<string>();
  const slotOf = new Map<number, number>();
  starts.forEach((s, i) => s.provinces.forEach((p) => slotOf.set(p, i)));
  // neighbouring starts: reachable within 3 land steps of the territory
  const near = starts.map((s, i) => {
    const out = new Set<number>();
    let front = new Set(s.provinces);
    const seen = new Set(s.provinces);
    for (let d = 0; d < 3; d++) {
      const next = new Set<number>();
      for (const p of front) for (const q of regions[p].neighbors) {
        if (regions[q].kind !== 'land' || seen.has(q)) continue;
        seen.add(q); next.add(q);
        const o = slotOf.get(q);
        if (o !== undefined && o !== i) out.add(o);
      }
      front = next;
    }
    return out;
  });
  const palette = makePalette(starts.length, rng);
  const colour = new Map<number, [number, number, number]>();
  const taken = new Set<number>();
  const order = starts.map((_, i) => i).sort((a, b) => near[b].size - near[a].size || a - b);
  for (const i of order) {
    let best = -1, bestScore = -1;
    palette.forEach((col, k) => {
      if (taken.has(k)) return;
      let score = 1e9;
      for (const n of near[i]) { const u = colour.get(n); if (u) score = Math.min(score, colourDistance(col, u)); }
      if (score > bestScore) { bestScore = score; best = k; }
    });
    taken.add(best);
    colour.set(i, palette[best]);
  }
  starts.forEach((s, i) => {
    const culture: Culture = landmasses[regions[s.capital].landmass]?.culture ?? 'iberian';
    let nm = countryName(gen, culture, rng);
    for (let t = 0; t < 20 && used.has(nm.short.pt); t++) nm = countryName(gen, culture, rng);
    used.add(nm.short.pt);
    s.country = { name: nm.short, fullName: nm.full, color: hslHex(colour.get(i)!) };
  });
}
