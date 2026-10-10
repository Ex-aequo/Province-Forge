// Dev check: fairness of start positions across seeds.
import { generateMap } from '../../src/gen/generate';
import { DEFAULT_PARAMS, BASIC_RESOURCES, RARE_RESOURCES } from '../../src/gen/types';
const seeds = (process.argv[2] ?? 'ex-aequo,alpha,beta,gamma,delta,eps,zeta,eta,theta,iota').split(',');
for (const seed of seeds) {
  const t0 = performance.now();
  const m = generateMap({ ...DEFAULT_PARAMS, seed });
  const f = m.fairness!;
  const perCont = m.landmasses.filter((l) => l.isContinent).map((l) => `${m.starts.filter((s) => s.landmass === l.id && !s.reserved).length}+${m.starts.filter((s) => s.landmass === l.id && s.reserved).length}`).join(' ');
  const basicsOk = m.starts.every((s) => BASIC_RESOURCES.every((b) => s.provinces.some((id) => m.regions[id].resource === b)));
  const noRares = m.starts.every((s) => s.provinces.every((id) => !RARE_RESOURCES.includes(m.regions[id].resource!)));
  const sizes = new Set(m.starts.map((s) => s.provinces.length));
  console.log(`${seed}: score ${f?.score} (try ${f?.attempts}) value ${f?.valueMin}-${f?.valueMax} spread ${(f!.valueSpread * 100).toFixed(1)}% free ${f?.freeMin}-${f?.freeMax} capDist≥${f?.minCapitalDistance} rare ${f?.rareDistMin}-${f?.rareDistMax} | slots ${perCont} sizes ${[...sizes]} basics ${basicsOk} noRares ${noRares} praga ${m.pragaSeeds.length} | ${m.issues.map((i) => i.message).join('; ') || 'valid'} | ${Math.round(performance.now() - t0)}ms starts ${m.stats.timings.starts}ms`);
}
