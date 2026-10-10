import './ui/style.css';
import { generateMap } from './gen/generate';
import { toExportJson } from './gen/export';
import type { GeneratedMap, GenParams, Region, Terrain } from './gen/types';
import { DEFAULT_PARAMS, TERRAINS } from './gen/types';
import { TERRAIN_COLORS, renderAdjacency, renderCells, renderIds, renderSeam, renderStandalone, renderWorld, type ViewMode } from './render/svg';
import { buildControls } from './ui/controls';
import { filterForViewer, type TurnState, type ViewerState } from './game/state';
import { makeTestState } from './game/testState';
import { LABEL_CSS, type Lang } from './render/political';
import { ECONOMY_CSS, RESOURCE_COLORS, RESOURCE_PT } from './render/economy';
import { RESOURCES } from './gen/types';
import { toClientMap, type ClientMap } from './map/clientMap';
import { filterClientMap } from './map/filterClientMap';
import { RenderMap } from './map/renderMap';
import { MapView, type MapMode } from './view/MapView';
import { WorkerTileSource } from './view/tileSources';

export const TERRAIN_PT: Record<Terrain, string> = {
  plains: 'Planície', forest: 'Floresta', hills: 'Colinas', mountains: 'Montanha',
  desert: 'Deserto', marsh: 'Pântano', jungle: 'Selva', tundra: 'Tundra',
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const STORE_KEY = 'province-forge:params:v4';

// ------------------------------------------------------------------ state
const params: GenParams = loadParams();
let map: GeneratedMap | null = null;
let mode: ViewMode = 'political';
let lang: Lang = 'pt';
let turnState: TurnState | null = null;
let vstate: ViewerState | null = null;
let viewer: string | null = null;
const test = { progress: 0.4, praga: 0.3, salt: 0 };
let busy = false;

function loadParams(): GenParams {
  const p: GenParams = { ...DEFAULT_PARAMS, continentSizes: [...DEFAULT_PARAMS.continentSizes] as [number, number, number] };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      for (const k of Object.keys(p) as (keyof GenParams)[]) if (k in saved && typeof saved[k] === typeof p[k]) (p as any)[k] = saved[k];
      if (Array.isArray(saved.continentSizes) && saved.continentSizes.length === 3) p.continentSizes = saved.continentSizes;
    }
  } catch { /* storage unavailable — defaults are fine */ }
  return p;
}
function saveParams() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(params)); } catch { /* ignore */ }
}

// ------------------------------------------------------------------ map view (same component as the game)
const hud = $('hud');
let mv: MapView | null = null;
function ensureView(rm: RenderMap, tiles: WorkerTileSource) {
  if (mv) { mv.setMap(rm, tiles, true); return mv; }
  mv = new MapView($('map-host'), {
    map: rm, tiles, lang, mode: VIEW_MODES.includes(mode as MapMode) ? (mode as MapMode) : 'terrain',
    onHover: (id, sx, sy) => {
      if (!map || busy || id === null) { hud.hidden = true; return; }
      hud.textContent = describeShort(map.regions[id]);
      hud.hidden = false;
      const stage = $('map-host').getBoundingClientRect();
      hud.style.left = `${Math.max(8, Math.min(sx + 14, stage.width - hud.offsetWidth - 8))}px`;
      hud.style.top = `${Math.max(8, Math.min(sy + 14, stage.height - hud.offsetHeight - 8))}px`;
    },
    onSelect: (id) => { if (map && !busy) select(id ?? -1); },
  });
  return mv;
}
const VIEW_MODES: MapMode[] = ['political', 'praga', 'terrain', 'terrainType', 'resources', 'starts'];

const RASTER_MODES: ViewMode[] = ['terrain', 'political', 'praga', 'resources', 'starts'];
const PRAGA_PT = ['sem Praga', 'Praga presente', 'infestada', 'devastada'];
const isHidden = (r: Region) => !!vstate && vstate.viewer !== null && !vstate.visible.includes(r.id) && (r.kind === 'land' || r.kind === 'sea');
const countryById = (id: string | null | undefined) => (id ? vstate?.countries.find((c) => c.id === id) : undefined);
function regionName(r: Region) {
  if (isHidden(r)) return 'Terra incógnita';
  const nm = r.name?.[lang];
  if (r.kind === 'land') return `${nm ?? 'Província'} (#${r.id})`;
  if (r.kind === 'ice') return nm ?? 'Gelo polar';
  return `${nm ?? (r.kind === 'lake' ? 'Lago' : 'Mar')} (#${r.id})`;
}
function politicsLine(r: Region) {
  const p = vstate?.provinces[r.id];
  if (!p || r.kind !== 'land') return '';
  const own = countryById(p.owner), ctl = countryById(p.controller);
  let t = own ? own.fullName[lang] : 'sem dono';
  if (p.controller && p.controller !== p.owner) t += ` · ocupada por ${ctl?.name[lang] ?? '?'}`;
  if (p.praga) t += ` · ${PRAGA_PT[p.praga]}`;
  return t;
}
function describeShort(r: Region) {
  if (isHidden(r)) return 'Terra incógnita';
  if (r.kind === 'lake' || r.kind === 'ice') return `${regionName(r)} · intransitável`;
  if (r.kind === 'sea') return `${regionName(r)} · ${r.neighbors.length} vizinhos`;
  const pol = politicsLine(r);
  const d = vstate?.details[r.id];
  const res = d ? ` · ${RESOURCE_PT[d.resource]} ×${d.amount}` : '';
  return `${regionName(r)} · ${TERRAIN_PT[r.terrain ?? 'plains']}${res}${pol ? ` · ${pol}` : ''}`;
}

// ------------------------------------------------------------------ selection
const selBox = $('selection');
let selected = -1;
function select(id: number, center = false) {
  if (!map) return;
  selected = id;
  if (id < 0) { mv?.select(null); selBox.hidden = true; return; }
  const r = map.regions[id];
  if (isHidden(r)) {
    mv?.select(null);
    selBox.innerHTML = '<h3>Terra incógnita</h3><div class="meta">Ainda não explorada por este jogador.</div>';
    selBox.hidden = false;
    return;
  }
  mv?.select(id, center);
  const lm = r.kind === 'land' ? (map.landmasses[r.landmass]?.title?.[lang] ?? map.landmasses[r.landmass]?.name) : null;
  const chips = r.neighbors.map((o) => {
    const q = map!.regions[o];
    const river = r.riverNeighbors.includes(o);
    return `<button type="button" class="chip${q.kind === 'sea' ? ' sea' : ''}${river ? ' river' : ''}" data-id="${o}" title="${regionName(q)}${river ? ' · do outro lado do rio' : ''}">${o}${river ? ' ≈' : ''}</button>`;
  }).join('');
  const crossSeam = r.neighbors.filter((o) => Math.abs(map!.regions[o].label[0] - r.label[0]) > map!.width / 2).length;
  const terrainLine = r.kind === 'land'
    ? `<div class="meta"><i class="sw" style="background:${TERRAIN_COLORS[r.terrain ?? 'plains']}"></i>${TERRAIN_PT[r.terrain ?? 'plains']}${r.hasRiver ? ' · atravessada por rio' : ''}${r.riverNeighbors.length ? ` · ${r.riverNeighbors.length} ${r.riverNeighbors.length > 1 ? 'fronteiras' : 'fronteira'} de rio (≈)` : ''}</div>`
    : '';
  const pol = politicsLine(r);
  // resources only as the viewer knows them; values and start positions only for the GM
  const det = vstate?.details[r.id];
  const st = vstate?.gm && r.startSlot !== undefined ? vstate.gm.starts.find((x) => x.slot === r.startSlot) : undefined;
  const ecoLine = r.kind === 'land' && det
    ? `<div class="meta"><i class="sw round" style="background:${RESOURCE_COLORS[det.resource]}"></i>${RESOURCE_PT[det.resource]} ×${det.amount}${det.value !== undefined ? ` · valor ${num(det.value, 1)}` : ''}${st ? ` · ${st.reserved ? 'posição de reserva' : `posição inicial ${st.slot + 1}`}${st.capital === r.id ? ' (capital)' : ''}` : ''}</div>`
    : '';
  selBox.innerHTML =
    `<h3>${regionName(r)}</h3>` + (pol ? `<div class="meta">${pol}</div>` : '') + terrainLine + ecoLine +
    `<div class="meta">${lm ? `${lm} · ` : ''}${r.cells.length} células · área ${Math.round(r.area).toLocaleString('pt-PT')}${r.kind === 'land' && r.coastal ? ' · costeira' : ''}${crossSeam ? ` · ${crossSeam} ${crossSeam > 1 ? 'ligações' : 'ligação'} através da junção` : ''}</div>` +
    (r.neighbors.length ? `<div class="meta">Vizinhos (${r.neighbors.length}) — contorno amarelo</div><div class="chips">${chips}</div>` : '<div class="meta">Intransitável: não faz parte do grafo de movimento.</div>');
  selBox.hidden = false;
}
selBox.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('.chip') as HTMLElement | null;
  if (b) select(Number(b.dataset.id), true);
});

// ------------------------------------------------------------------ rendering
function rebuildState(newState = true) {
  if (!map) return;
  if (newState || !turnState) turnState = makeTestState(map, { seed: `${params.seed}#${test.salt}`, progress: test.progress, praga: test.praga, countries: 25 });
  if (viewer && !turnState.countries.some((c) => c.id === viewer)) viewer = null;
  // the preview tool is a game-master tool: "no viewer" = GM view (sees everything)
  vstate = filterForViewer(map, turnState, viewer, { gm: viewer === null });
  const sel = $('view-as') as HTMLSelectElement;
  sel.innerHTML = '<option value="">Mestre de jogo (vê tudo)</option>' +
    turnState.countries.map((c) => {
      const n = Object.values(turnState!.provinces).filter((p) => p.owner === c.id).length;
      return `<option value="${c.id}"${c.id === viewer ? ' selected' : ''}>${c.fullName[lang]} · ${n} prov.</option>`;
    }).join('');
  $('state-meta').textContent = `Turno ${turnState.turn} · ${turnState.countries.length} países · dados de teste, não são do jogo`;
}

// What the map view draws: the full client map for the GM, or — exactly like the game
// server does — the client map cut to the chosen player's view (no hidden geometry).
let fullClient: ClientMap | null = null, fullRender: RenderMap | null = null, tileSrc: WorkerTileSource | null = null;
let shownFor = '';
function syncViewerMap() {
  if (!mv || !fullClient || !fullRender || !vstate) return;
  const key = viewer === null ? 'gm' : `${viewer}|${vstate.visible.join(",")}`;
  if (key === shownFor) return;
  shownFor = key;
  mv.setMap(viewer === null ? fullRender : new RenderMap(filterClientMap(fullClient, vstate.visible)), tileSrc, true);
}

function renderAll() {
  if (!map || !mv) return;
  syncViewerMap();
  mv.setLang(lang);
  mv.setView(vstate);
  if (VIEW_MODES.includes(mode as MapMode)) { mv.setCustomWorld(null); mv.setMode(mode as MapMode); }
  else mv.setCustomWorld(renderWorld(map, { mode }), false); // generator debug modes
  renderOverlays();
  select(selected >= 0 && selected < map.regions.length ? selected : -1);
}
function renderOverlays() {
  if (!map) return;
  let s = '';
  if (($('ov-cells') as HTMLInputElement).checked) s += renderCells(map);
  if (($('ov-adj') as HTMLInputElement).checked) s += renderAdjacency(map);
  if (($('ov-ids') as HTMLInputElement).checked) s += renderIds(map);
  if (($('ov-seam') as HTMLInputElement).checked) s += renderSeam(map);
  mv?.setOverlay(s);
  $('adj-legend').hidden = !($('ov-adj') as HTMLInputElement).checked;
}

function renderStats() {
  if (!map) return;
  const s = map.stats;
  const total = Object.values(s.timings).reduce((a, b) => a + b, 0);
  const lmRows = map.landmasses.filter((l) => l.isContinent)
    .map((l) => `<tr><td>${l.title?.[lang] ?? l.name} <span class="muted">${l.name.slice(-1)}</span></td><td class="n">${l.provinces}</td><td class="n">${Math.round((100 * l.provinces) / s.landProvinces)}%</td></tr>`).join('');
  const islands = map.landmasses.filter((l) => !l.isContinent);
  const islandProv = islands.reduce((a, l) => a + l.provinces, 0);
  const issues = map.issues.length
    ? map.issues.map((i) => `<li><span class="pill ${i.level}">${i.level === 'error' ? 'Erro' : 'Atenção'}</span><span>${i.message}</span></li>`).join('')
    : '<li><span class="pill ok">Válido</span><span>Todas as regiões são contíguas, ligadas e acessíveis.</span></li>';
  $('stats').innerHTML =
    `<h2 class="label">Este mundo</h2>` +
    `<div class="stat-grid">` +
    stat(s.landProvinces, 'províncias terrestres') + stat(s.seaZones, `zonas marítimas (${s.coastalZones} costeiras)`) + stat(`${num(s.landPct, 1)}%`, 'terra') +
    stat(`${s.provinceCellsMin}–${s.provinceCellsMax}`, 'células por província') + stat(num(s.provinceAreaCv, 2), 'variação de tamanho (CV)') + stat(s.cells.toLocaleString('pt-PT'), 'células de terreno') +
    `</div>` +
    `<table class="lm"><thead><tr><th>Massa de terra</th><th class="n">Províncias</th><th class="n">Quota</th></tr></thead><tbody>${lmRows}` +
    `<tr><td>${islands.length} ${islands.length === 1 ? 'ilha' : 'ilhas'}</td><td class="n">${islandProv}</td><td class="n">${Math.round((100 * islandProv) / s.landProvinces)}%</td></tr></tbody></table>` +
    `<div class="stat-grid">` + stat(s.rivers, 'rios') + stat(s.lakes, 'lagos') + stat(s.riverCrossings, 'fronteiras com rio') + `</div>` +
    fairnessBlock() +
    `<h2 class="label">Recursos</h2>` +
    `<ul class="terrain-legend">${RESOURCES.map((t) => `<li><i class="sw round" style="background:${RESOURCE_COLORS[t]}"></i><span>${RESOURCE_PT[t]}</span><b>${s.resourceCounts[t]}</b></li>`).join('')}</ul>` +
    `<h2 class="label">Tipos de terreno</h2>` +
    `<ul class="terrain-legend">${TERRAINS.map((t) => `<li><i class="sw" style="background:${TERRAIN_COLORS[t]}"></i><span>${TERRAIN_PT[t]}</span><b>${s.terrainCounts[t]}</b></li>`).join('')}</ul>` +
    `<ul class="issues">${issues}</ul>` +
    `<div class="timing">Gerado em ${num(total / 1000, 1)} s · província mais pequena <button type="button" class="link" id="go-smallest">#${s.smallestProvinceId}</button></div>`;
  $('go-smallest').addEventListener('click', () => select(s.smallestProvinceId, true));
}
function fairnessBlock() {
  const f = map?.fairness;
  if (!f || !map) return '';
  const players = map.starts.filter((x) => !x.reserved).length, reserves = map.starts.length - players;
  const perCont = map.landmasses.filter((l) => l.isContinent).map((l) => {
    const n = map!.starts.filter((x) => x.landmass === l.id && !x.reserved).length, r = map!.starts.filter((x) => x.landmass === l.id && x.reserved).length;
    return `${l.title?.[lang] ?? l.name} ${n}+${r}`;
  }).join(' · ');
  const tone = f.score >= 70 ? 'ok' : f.score >= 55 ? 'warn' : 'error';
  return `<h2 class="label">Posições iniciais</h2>` +
    `<div class="fair"><span class="pill ${tone}">Justiça ${f.score}/100</span><span class="muted">${players} jogadores + ${reserves} reservas · ${map.params.startProvinces} províncias cada</span></div>` +
    `<div class="stat-grid">` +
    stat(`${num(f.valueSpread * 100, 1)}%`, `diferença de valor (${num(f.valueMin, 1)}–${num(f.valueMax, 1)})`) +
    stat(`${f.freeMin}–${f.freeMax}`, 'terra livre na zona de cada um') +
    stat(`${f.rareDistMin}–${f.rareDistMax}`, 'passos até ouro/especiarias') +
    `</div><p class="hint">${perCont} · capitais a ≥ ${f.minCapitalDistance} passos · ${f.attempts} tentativa${f.attempts > 1 ? 's' : ''}</p>`;
}
const num = (v: number, d: number) => v.toLocaleString('pt-PT', { minimumFractionDigits: d, maximumFractionDigits: d });
const stat = (v: string | number, l: string) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`;

// ------------------------------------------------------------------ generation
async function regenerate(keepView = true) {
  if (busy) return;
  busy = true;
  hud.hidden = true;
  $('busy').hidden = false;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    params.seed = ($('seed') as HTMLInputElement).value.trim() || DEFAULT_PARAMS.seed;
    map = generateMap(params);
    // exactly what the game client receives: the slim client map + tiles
    fullClient = toClientMap(map);
    fullRender = new RenderMap(fullClient);
    tileSrc = new WorkerTileSource(map);
    shownFor = 'gm';
    selected = -1;
    rebuildState(true);
    ensureView(fullRender, tileSrc);
    if (!keepView) mv!.fit();
    renderAll();
    renderStats();
    saveParams();
  } catch (err) {
    console.error(err);
    $('stats').innerHTML = `<h2 class="label">Este mundo</h2><ul class="issues"><li><span class="pill error">Erro</span><span>A geração falhou: ${(err as Error).message}. Experimente outra semente ou reponha os controlos.</span></li></ul>`;
  } finally {
    busy = false;
    $('busy').hidden = true;
  }
}

// ------------------------------------------------------------------ export
async function saveFile(filename: string, data: string, mime: string) {
  const msg = $('export-msg');
  const claude = (window as any).claude;
  if (claude?.use) {
    try {
      const downloads = await claude.use('downloads');
      if (downloads) {
        await downloads.save({ filename, data: new Blob([data], { type: mime }) });
        msg.textContent = `Guardado: ${filename}`;
        return;
      }
    } catch (e: any) {
      if (e?.code === 'declined') { msg.textContent = 'Gravação cancelada.'; return; }
    }
  }
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  msg.textContent = `Guardado: ${filename}`;
}
const safeName = () => params.seed.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase() || 'world';
$('export-json').addEventListener('click', () => { if (map) saveFile(`${safeName()}.static-map.json`, JSON.stringify(toExportJson(map)), 'application/json'); });
$('export-client').addEventListener('click', () => { if (map) saveFile(`${safeName()}.client-map.json`, JSON.stringify(toClientMap(map)), 'application/json'); });
$('export-svg').addEventListener('click', async () => {
  if (!map || !mv) return;
  const raster = RASTER_MODES.includes(mode);
  const img = raster ? await mv.baseImageDataUrl() : undefined;
  if (raster && !img) { $('export-msg').textContent = 'O terreno ainda está a ser desenhado. Tente de novo dentro de momentos.'; return; }
  // export at full detail
  const rm = mv.renderMap, lod = rm.lod;
  rm.lod = 1;
  mv.setMode(mode as MapMode);
  const content = mv.worldSvg();
  rm.lod = lod;
  mv.setMode(mode as MapMode);
  saveFile(`${safeName()}-${mode}.svg`, renderStandalone(map, { mode }, '', img ?? undefined, VIEW_MODES.includes(mode as MapMode) ? content : undefined, LABEL_CSS + ECONOMY_CSS), 'image/svg+xml');
});
$('export-state').addEventListener('click', () => {
  if (!map || !turnState) return;
  saveFile(`${safeName()}.turn-state${viewer ? `.${viewer}` : ''}.json`, JSON.stringify(viewer ? vstate : turnState, null, 1), 'application/json');
});

// ------------------------------------------------------------------ test state controls
const bindRange = (id: string, key: 'progress' | 'praga', out: string) => {
  const el = $(id) as HTMLInputElement, o = $(out);
  const show = () => { o.textContent = `${Math.round(Number(el.value) * 100)}%`; };
  el.value = String(test[key]); show();
  el.addEventListener('input', show);
  el.addEventListener('change', () => { test[key] = Number(el.value); rebuildState(true); renderAll(); });
};
bindRange('ts-progress', 'progress', 'ts-progress-out');
bindRange('ts-praga', 'praga', 'ts-praga-out');
$('ts-new').addEventListener('click', () => { test.salt++; rebuildState(true); renderAll(); });
$('view-as').addEventListener('change', (e) => { viewer = (e.target as HTMLSelectElement).value || null; rebuildState(false); renderAll(); });
$('lang').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button[data-lang]') as HTMLButtonElement | null;
  if (!b) return;
  lang = b.dataset.lang as Lang;
  for (const x of $('lang').querySelectorAll('button')) x.setAttribute('aria-checked', String(x === b));
  rebuildState(false);
  renderAll();
});

// ------------------------------------------------------------------ wiring
const SYL = ['ar', 'bel', 'cor', 'dan', 'el', 'fen', 'gal', 'hir', 'is', 'kar', 'lum', 'mar', 'nor', 'os', 'pel', 'ras', 'sul', 'tor', 'ul', 'var', 'zan'];
const randomSeed = () => {
  const w = () => SYL[Math.floor(Math.random() * SYL.length)] + SYL[Math.floor(Math.random() * SYL.length)];
  return `${w()}-${w()}-${Math.floor(Math.random() * 1000)}`;
};

const seedInput = $('seed') as HTMLInputElement;
seedInput.value = params.seed;
seedInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') regenerate(false); });
$('reroll').addEventListener('click', () => { seedInput.value = randomSeed(); regenerate(false); });
$('generate').addEventListener('click', () => regenerate(false));

buildControls($('controls'), params, () => { if (($('auto') as HTMLInputElement).checked) regenerate(true); else saveParams(); });

$('modes').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button[data-mode]') as HTMLButtonElement | null;
  if (!b || !map) return;
  mode = b.dataset.mode as ViewMode;
  for (const x of $('modes').querySelectorAll('button')) x.setAttribute('aria-checked', String(x === b));
  renderAll();
});
for (const id of ['ov-cells', 'ov-ids', 'ov-adj', 'ov-seam']) $(id).addEventListener('change', renderOverlays);

$('zoom-in').addEventListener('click', () => mv?.zoomBy(1.6));
$('zoom-out').addEventListener('click', () => mv?.zoomBy(1 / 1.6));
$('zoom-fit').addEventListener('click', () => mv?.fit());
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') select(-1); });

// console handle for debugging: forge.map, forge.select(id), forge.viewport
(window as any).forge = { get map() { return map; }, select: (id: number) => select(id, true), get viewport() { return mv?.viewport; }, get view() { return mv; } };

regenerate(false);
