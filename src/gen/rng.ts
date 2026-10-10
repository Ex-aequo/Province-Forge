// Seeded, deterministic randomness. Never use Math.random() inside the generator.

/** Hash an arbitrary string seed into a 32-bit integer (cyrb53-style mix). */
export function hashSeed(str: string): number {
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

export type Rng = () => number; // uniform [0, 1)

/** sfc32 PRNG — fast, good statistical quality, 128-bit state. */
export function createRng(seed: string | number): Rng {
  const s = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
  let a = s ^ 0x9e3779b9;
  let b = Math.imul(s, 0x85ebca6b) >>> 0;
  let c = Math.imul(s ^ 0xc2b2ae35, 0x27d4eb2f) >>> 0;
  let d = 1;
  const next: Rng = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const r = (t + d) | 0;
    c = (c + r) | 0;
    return (r >>> 0) / 4294967296;
  };
  for (let i = 0; i < 16; i++) next(); // warm up
  return next;
}

/** Independent sub-stream so each pipeline stage is stable when other stages change. */
export function subRng(seed: string, stage: string): Rng {
  return createRng(`${seed}::${stage}`);
}

export const range = (rng: Rng, lo: number, hi: number) => lo + (hi - lo) * rng();
