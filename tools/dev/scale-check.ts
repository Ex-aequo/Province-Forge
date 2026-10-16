// Dev check: does the generator hold up at Praga scales (25–150 kingdoms)?
// npx tsx tools/dev/scale-check.ts "25:8:0.3,50:6:0.3,150:5:0.3" [seed]
import { generateMap } from '../../src/gen/generate';
import { DEFAULT_PARAMS } from '../../src/gen/types';
import { toClientMap } from '../../src/map/clientMap';
import { gzipSync } from 'node:zlib';
const cases = (process.argv[2] ?? '25:8:0.3').split(',').map((c) => c.split(':').map(Number));
const seed = process.argv[3] ?? 'ex-aequo';
for (const [k, sp, share] of cases) {
  const lp = Math.round((k * sp) / share);
  const scale = Math.sqrt(lp / 650);
  const p = { ...DEFAULT_PARAMS, seed, playerSlots: k, reserveSlots: 0, startProvinces: sp, landProvinces: lp,
    cellCount: Math.round(36000 * lp / 650), width: Math.round(4000 * scale), height: Math.round(2000 * scale) };
  const t0 = performance.now();
  const m = generateMap(p);
  const ms = Math.round(performance.now() - t0);
  const land = m.regions.filter((r) => r.kind === 'land').length;
  const cm = JSON.stringify(toClientMap(m));
  const f = m.fairness;
  console.log(`K=${k} sp=${sp} lp=${lp} cells=${p.cellCount} → land ${land}, starts ${m.starts.length}` +
    ` sizes ${[...new Set(m.starts.map((s) => s.provinces.length))]}, fair ${f?.score} spread ${((f?.valueSpread ?? 0) * 100).toFixed(1)}%` +
    ` capDist≥${f?.minCapitalDistance} | client ${(cm.length / 1e6).toFixed(2)} MB (${(gzipSync(cm).length / 1e6).toFixed(2)} gz)` +
    ` | ${ms} ms ${JSON.stringify(m.stats.timings)} | ${m.issues.map((i) => i.message).join('; ') || 'valid'}`);
}
