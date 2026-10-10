// Bilingual place names. Each continent gets one phonetic "culture" so it has its own
// identity; islands take the culture of the nearest continent. Proper nouns are
// invented and identical in both languages — only the generic words are translated.
import type { Rng } from './rng';
import type { Culture, GeneratedMap, LocalName, Region } from './types';

interface Phonology {
  onsets: string[];
  vowels: string[];
  middles: string[]; // consonant clusters between syllables
  endings: string[];
  continentEndings: string[];
  maxLen: number;
}

const PHON: Record<Culture, Phonology> = {
  iberian: {
    onsets: ['b', 'c', 'd', 'f', 'g', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'br', 'cr', 'gr', 'tr', 'pr', 'qu', 'ch', 'alc', 'alm', 'est', 'val', 'mir', 'tor', 'ol', 'sar'],
    vowels: ['a', 'a', 'e', 'e', 'i', 'o', 'o', 'u', 'ei'],
    middles: ['d', 'l', 'n', 'r', 's', 't', 'v', 'nd', 'nt', 'rr', 'lh', 'nh', 'rc', 'lg', 'br', 'rd', 'ss', 'm'],
    endings: ['ora', 'ela', 'eira', 'al', 'ar', 'es', 'ana', 'ena', 'osa', 'ida', 'ejo', 'inho', 'ago', 'era', 'ões', 'ica', 'ura', 'il'],
    continentEndings: ['ória', 'ânia', 'ícia', 'ena'],
    maxLen: 11,
  },
  nordic: {
    onsets: ['b', 'd', 'f', 'g', 'h', 'k', 'l', 'm', 'n', 'r', 's', 't', 'v', 'br', 'dr', 'fr', 'gr', 'kj', 'sk', 'sn', 'st', 'th', 'tr', 'hr', 'ulf', 'ask', 'eir'],
    vowels: ['a', 'a', 'e', 'e', 'i', 'o', 'o', 'u', 'ø', 'å', 'ei'],
    middles: ['g', 'k', 'l', 'n', 'r', 's', 't', 'v', 'nd', 'rd', 'rk', 'lf', 'ld', 'ng', 'rn', 'sk', 'st', 'th'],
    endings: ['heim', 'vik', 'gard', 'borg', 'stad', 'fjord', 'by', 'dal', 'mark', 'holm', 'ness', 'lund', 'havn', 'vang', 'berg', 'rud', 'sund'],
    continentEndings: ['land', 'heim', 'gard'],
    maxLen: 11,
  },
  desert: {
    onsets: ['b', 'd', 'f', 'h', 'j', 'k', 'm', 'n', 'q', 'r', 's', 't', 'z', 'kh', 'sh', 'gh', 'dh', 'al', 'ab', 'is', 'ur'],
    vowels: ['a', 'a', 'a', 'i', 'i', 'u', 'aa', 'ai'],
    middles: ['b', 'd', 'f', 'h', 'j', 'k', 'l', 'm', 'n', 'r', 's', 't', 'z', 'sh', 'kh', 'rd', 'zr', 'mr', 'sr', 'nj'],
    endings: ['abad', 'istan', 'ar', 'an', 'iya', 'im', 'ah', 'esh', 'ur', 'and', 'ul', 'eh', 'ira', 'oun', 'at'],
    continentEndings: ['istan', 'iya', 'ar'],
    maxLen: 11,
  },
};

const BAD = /(.)\1\1|[^aeiouyøåäöüáéíóúâêôãõ]{4}|ðð|çç|ç[ei]|[ðç]$/i;

export class NameGen {
  private used = new Set<string>();
  constructor(private rng: Rng) {}

  private pick<T>(a: T[]): T { return a[Math.floor(this.rng() * a.length)]; }

  /** A unique invented proper noun in the given culture. */
  word(c: Culture, kind: 'place' | 'continent' = 'place'): string {
    const ph = PHON[c];
    for (let attempt = 0; attempt < 200; attempt++) {
      const syl = 1 + (this.rng() < 0.55 ? 1 : 0) + (this.rng() < 0.12 ? 1 : 0);
      let w = this.pick(ph.onsets) + this.pick(ph.vowels);
      for (let s = 1; s < syl; s++) w += this.pick(ph.middles) + this.pick(ph.vowels);
      const end = kind === 'continent' ? this.pick(ph.continentEndings) : this.pick(ph.endings);
      // join: drop a trailing vowel when the ending starts with one
      if (/[aeiouyøå]$/.test(w) && /^[aeiouyøåóâáíé]/.test(end)) w = w.slice(0, -1);
      w += end;
      // no doubled vowels (except one "aa" in desert names), no vowel triples
      if (c !== 'desert' || (w.match(/aa/g) ?? []).length > 1) w = w.replace(/([aeiouøå])\1/g, '$1');
      if (/[aeiouøå]{3}/.test(w)) continue;
      if (w.length < 4 || w.length > ph.maxLen + (kind === 'continent' ? 2 : 0) || BAD.test(w)) continue;
      const cap = w.charAt(0).toUpperCase() + w.slice(1);
      if (this.used.has(cap)) continue;
      this.used.add(cap);
      return cap;
    }
    // extremely unlikely: fall back to a numbered name
    const n = `${c.slice(0, 1).toUpperCase()}${this.used.size}`;
    this.used.add(n);
    return n;
  }
}

/** "de" contractions in Portuguese: de + o/a → do/da is not needed for invented names; keep "de". */
const both = (pt: string, en: string): LocalName => ({ pt, en });

/** Assign names to landmasses, regions and rivers. Mutates the map. */
export function nameMap(map: Pick<GeneratedMap, 'regions' | 'landmasses' | 'rivers' | 'width'>, cellX: Float64Array, rng: Rng) {
  const gen = new NameGen(rng);
  const cultures: Culture[] = ['iberian', 'nordic', 'desert'];
  // shuffle which continent gets which culture
  for (let i = 2; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [cultures[i], cultures[j]] = [cultures[j], cultures[i]]; }

  const W = map.width;
  const circMean = (xs: number[]) => {
    let sx = 0, sy = 0;
    for (const x of xs) { const a = (x / W) * Math.PI * 2; sx += Math.cos(a); sy += Math.sin(a); }
    return ((Math.atan2(sy, sx) / (Math.PI * 2)) * W + W) % W;
  };
  const lmX = map.landmasses.map((lm) => circMean(map.regions.filter((r) => r.kind === 'land' && r.landmass === lm.id).map((r) => r.label[0])));
  const continents = map.landmasses.filter((l) => l.isContinent);
  continents.forEach((lm, i) => { lm.culture = cultures[i % 3]; });
  for (const lm of map.landmasses) {
    if (lm.isContinent) continue;
    let best = continents[0], bd = Infinity;
    for (const c of continents) {
      const d = Math.abs(((lmX[lm.id] - lmX[c.id] + W * 1.5) % W) - W / 2);
      if (d < bd) { bd = d; best = c; }
    }
    lm.culture = best?.culture ?? 'iberian';
  }

  // landmasses
  for (const lm of map.landmasses) {
    const c = lm.culture!;
    if (lm.isContinent) {
      const w = gen.word(c, 'continent');
      lm.title = both(w, w);
    } else {
      const w = gen.word(c);
      const multi = lm.provinces > 1;
      lm.title = multi ? both(`Ilhas ${w}`, `${w} Isles`) : both(`Ilha de ${w}`, `${w} Island`);
    }
  }

  // provinces: proper noun of their landmass culture
  const cultureOf = (r: Region) => map.landmasses[r.landmass]?.culture ?? 'iberian';
  for (const r of map.regions) {
    if (r.kind !== 'land') continue;
    const w = gen.word(cultureOf(r));
    r.name = both(w, w);
  }

  // sea zones: named after the nearest land culture; type from the shape of the zone
  const landNbCulture = (r: Region): Culture => {
    const counts = new Map<Culture, number>();
    for (const o of r.neighbors) {
      const q = map.regions[o];
      if (q.kind === 'land') counts.set(cultureOf(q), (counts.get(cultureOf(q)) ?? 0) + 1);
    }
    let best: Culture = 'iberian', bc = -1;
    for (const [c, n] of counts) if (n > bc) { bc = n; best = c; }
    if (bc < 0) {
      // open ocean: inherit from a coastal neighbour's culture, else nearest continent by longitude
      let bd = Infinity;
      for (const c of continents) {
        const d = Math.abs(((r.label[0] - lmX[c.id] + W * 1.5) % W) - W / 2);
        if (d < bd) { bd = d; best = c.culture!; }
      }
    }
    return best;
  };
  for (const r of map.regions) {
    if (r.kind === 'sea') {
      const w = gen.word(landNbCulture(r));
      const landNb = r.neighbors.filter((o) => map.regions[o].kind === 'land');
      const landmasses = new Set(landNb.map((o) => map.regions[o].landmass));
      if (r.seaKind === 'ocean') r.name = both(`Mar de ${w}`, `Sea of ${w}`);
      else if (landmasses.size >= 2) r.name = both(`Estreito de ${w}`, `${w} Strait`);
      else if (landNb.length >= 5) r.name = both(`Golfo de ${w}`, `Gulf of ${w}`);
      else if (landNb.length >= 3) r.name = both(`Baía de ${w}`, `${w} Bay`);
      else r.name = both(`Costa de ${w}`, `${w} Coast`);
    } else if (r.kind === 'lake') {
      // lake culture: the land around it
      const cell = r.cells[0];
      void cell;
      const near = map.regions.find((q) => q.kind === 'land' && Math.hypot(q.label[0] - r.label[0], q.label[1] - r.label[1]) < 200);
      const w = gen.word(near ? cultureOf(near) : 'iberian');
      r.name = both(`Lago ${w}`, `Lake ${w}`);
    } else if (r.kind === 'ice') {
      r.name = both('Gelo polar', 'Polar ice');
    }
  }

  // rivers: one name per river id, culture of the land at its mouth
  const riverNames = new Map<number, LocalName>();
  for (const rv of map.rivers) {
    let nm = riverNames.get(rv.id);
    if (!nm) {
      const mx = rv.pts[rv.pts.length - 2], my = rv.pts[rv.pts.length - 1];
      let best: Region | null = null, bd = Infinity;
      for (const q of map.regions) {
        if (q.kind !== 'land') continue;
        const dx = Math.abs(((q.label[0] - mx) % W + W * 1.5) % W - W / 2), dy = q.label[1] - my;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = q; }
      }
      const w = gen.word(best ? cultureOf(best) : 'iberian');
      nm = both(`Rio ${w}`, `${w} River`);
      riverNames.set(rv.id, nm);
    }
    rv.name = nm;
  }
  void cellX;
}

/** Country names for test states: a proper noun plus a culture-appropriate title. */
export function countryName(gen: NameGen, c: Culture, rng: Rng): { short: LocalName; full: LocalName } {
  const w = gen.word(c);
  const titles: Record<Culture, [string, string][]> = {
    iberian: [['Reino de', 'Kingdom of'], ['Principado de', 'Principality of'], ['Ducado de', 'Duchy of'], ['República de', 'Republic of'], ['Condado de', 'County of']],
    nordic: [['Reino de', 'Kingdom of'], ['Jarlado de', 'Jarldom of'], ['Liga de', 'League of'], ['Ducado de', 'Duchy of']],
    desert: [['Sultanato de', 'Sultanate of'], ['Emirado de', 'Emirate of'], ['Califado de', 'Caliphate of'], ['Reino de', 'Kingdom of']],
  };
  const [pt, en] = titles[c][Math.floor(rng() * titles[c].length)];
  return { short: both(w, w), full: both(`${pt} ${w}`, `${en} ${w}`) };
}
