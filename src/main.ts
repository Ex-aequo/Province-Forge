import './ui/style.css';
import { generateMap } from './gen/generate';
import { toExportJson } from './gen/export';
import type { GeneratedMap, GenParams, Region, Terrain } from './gen/types';
import { DEFAULT_PARAMS, TERRAINS } from './gen/types';
import { PALETTE, TERRAIN_COLORS, renderAdjacency, renderCells, renderIds, renderOutline, renderSeam, renderStandalone, renderWorld, type ViewMode } from './render/svg';
import { buildControls } from './ui/controls';
import { TileLayer } from './ui/tiles';
import { filterForViewer, type TurnState, type ViewerState } from './game/state';
import { makeTestState } from './game/testState';
import { LABEL_CSS, renderPolitical, type Lang } from './render/political';
import { ECONOMY_CSS, RESOURCE_COLORS, RESOURCE_PT, renderResources, renderStarts } from './render/economy';
import { RESOURCES } from './gen/types';
import { Viewport } from './ui/viewport';

export const TERRAIN_PT: Record<Terrain, string> = {
  plains: 'Planície', forest: 'Floresta', hills: 'Colinas', mountains: 'Montanha',
  desert: 'Deserto', marsh: 'Pântano', jungle: 'Selva', tundra: 'Tundra',
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const STORE_KEY = 'province-forge:params:v4';
const SVGNS = 'http://www.w3.org/2000/svg';

// ------------------------------------------------------------------ state
const params: GenParams = loadParams();
let map: GeneratedMap | null = null;
let mode: ViewMode = 'political';
let lang: Lang = 'pt';
let turnState: TurnState | null = null;
let vstate: ViewerState | null = null;
let viewer: string | null = null;
const test = { progress: 0.4, praga: 0.3, salt: 0 };
let selected = -1;
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

// ------------------------------------------------------------------ svg scaffold
const svg = $('map') as unknown as SVGSVGElement;
const mk = (tag: string, attrs: Record<string, string | number> = {}) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};
const bg = mk('rect', { fill: PALETTE.sea });
const defs = mk('defs');
const gTileBase = mk('g', { id: 'tbase' }) as SVGGElement;
const gTileDetail = mk('g', { class: 'tile-detail' }) as SVGGElement;
const gWorld = mk('g', { id: 'world' });
const gOverlay = mk('g', { id: 'ovl' });
const gSel = mk('g', { id: 'sel' });
defs.append(gTileBase, gWorld, gOverlay, gSel);
const labelStyle = mk('style');
labelStyle.textContent = LABEL_CSS + ECONOMY_CSS;
svg.append(labelStyle, bg, defs);
svg.setAttribute('data-lod', '0');
const uses: SVGElement[] = [];
for (const id of ['tbase', 'world', 'ovl', 'sel']) {
  for (let k = 0; k < 3; k++) {
    const u = mk('use', { href: `#${id}` });
    u.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', `#${id}`);
    if (id === 'tbase') u.setAttribute('class', 'tile-base');
    uses.push(u);
    svg.append(u);
  }
  // detail tiles sit above the base layer and below the vector world
  if (id === 'tbase') svg.append(gTileDetail);
}
const tiles = new TileLayer(gTileBase, gTileDetail);
function placeCopies(W: number, H: number) {
  // sea only inside the world's north/south bounds; beyond the poles the darker stage shows
  bg.setAttribute('x', String(-W)); bg.setAttribute('y', '0');
  bg.setAttribute('width', String(W * 3)); bg.setAttribute('height', String(H));
  uses.forEach((u, i) => u.setAttribute('x', String(((i % 3) - 1) * W)));
}

// ------------------------------------------------------------------ viewport + interaction
const hud = $('hud');
const viewport = new Viewport(svg, {
  onHover: (wx, wy, sx, sy) => {
    if (!map || busy) return;
    const r = regionAt(wx, wy);
    if (!r) { hud.hidden = true; return; }
    hud.textContent = describeShort(r);
    hud.hidden = false;
    const stage = svg.getBoundingClientRect();
    const left = Math.min(sx + 14, stage.width - hud.offsetWidth - 8);
    const top = Math.min(sy + 14, stage.height - hud.offsetHeight - 8);
    hud.style.left = `${Math.max(8, left)}px`;
    hud.style.top = `${Math.max(8, top)}px`;
  },
  onLeave: () => { hud.hidden = true; },
  onView: (v) => {
    tiles.update(v);
    // label level of detail: far / mid / close (zoom relative to seeing the whole world)
    const rel = v.zoom / (v.w / (map?.width ?? 4000));
    svg.setAttribute('data-lod', rel < 2.2 ? '0' : rel < 4.5 ? '1' : '2');
  },
  onClick: (wx, wy) => {
    if (!map || busy) return;
    const r = regionAt(wx, wy);
    select(r ? r.id : -1);
  },
});

function regionAt(wx: number, wy: number): Region | null {
  if (!map || wy < 0 || wy > map.height) return null;
  const c = map.findCell(wx, wy);
  const id = map.cellRegion[c];
  return id >= 0 ? map.regions[id] : null;
}

const RASTER_MODES: ViewMode[] = ['terrain', 'political', 'praga', 'resources', 'starts'];
const PRAGA_PT = ['sem Praga', 'Praga presente', 'infestada', 'devastada'];
const isHidden = (r: Region) => !!vstate && (mode === 'political' || mode === 'praga') && !vstate.visible.includes(r.id) && (r.kind === 'land' || r.kind === 'sea');
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
  const res = r.resource ? ` · ${RESOURCE_PT[r.resource]} ×${r.amount}` : '';
  return `${regionName(r)} · ${TERRAIN_PT[r.terrain ?? 'plains']}${res}${pol ? ` · ${pol}` : ''}`;
}

// ------------------------------------------------------------------ selection
const selBox = $('selection');
function select(id: number, center = false) {
  if (!map) return;
  selected = id;
  if (id < 0) { gSel.innerHTML = ''; selBox.hidden = true; return; }
  const r = map.regions[id];
  if (isHidden(r)) {
    gSel.innerHTML = '';
    selBox.innerHTML = '<h3>Terra incógnita</h3><div class="meta">Ainda não explorada por este jogador.</div>';
    selBox.hidden = false;
    return;
  }
  gSel.innerHTML =
    renderOutline(map, r.neighbors, '#ffd166', 1.4) +
    renderOutline(map, [id], '#ffffff', 2.6, 'rgba(255,255,255,0.18)');
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
  const st = r.startSlot !== undefined ? map.starts.find((x) => x.slot === r.startSlot) : undefined;
  const ecoLine = r.kind === 'land' && r.resource
    ? `<div class="meta"><i class="sw round" style="background:${RESOURCE_COLORS[r.resource]}"></i>${RESOURCE_PT[r.resource]} ×${r.amount} · valor ${num(r.value ?? 0, 1)}${st ? ` · ${st.reserved ? 'posição de reserva' : `posição inicial ${st.slot + 1}`}${st.capital === r.id ? ' (capital)' : ''}` : ''}</div>`
    : '';
  selBox.innerHTML =
    `<h3>${regionName(r)}</h3>` + (pol ? `<div class="meta">${pol}</div>` : '') + terrainLine + ecoLine +
    `<div class="meta">${lm ? `${lm} · ` : ''}${r.cells.length} células · área ${Math.round(r.area).toLocaleString('pt-PT')}${r.kind === 'land' && r.coastal ? ' · costeira' : ''}${crossSeam ? ` · ${crossSeam} ${crossSeam > 1 ? 'ligações' : 'ligação'} através da junção` : ''}</div>` +
    (r.neighbors.length ? `<div class="meta">Vizinhos (${r.neighbors.length}) — contorno amarelo</div><div class="chips">${chips}</div>` : '<div class="meta">Intransitável: não faz parte do grafo de movimento.</div>');
  selBox.hidden = false;
  if (center) viewport.centerOn(nearestCopyX(r.label[0]), r.label[1]);
}
selBox.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('.chip') as HTMLElement | null;
  if (b) select(Number(b.dataset.id), true);
});
function nearestCopyX(x: number) {
  if (!map) return x;
  const W = map.width, cx = viewport.state.cx;
  return x + Math.round((cx - x) / W) * W;
}

// ------------------------------------------------------------------ rendering
function rebuildState(newState = true) {
  if (!map) return;
  if (newState || !turnState) turnState = makeTestState(map, { seed: `${params.seed}#${test.salt}`, progress: test.progress, praga: test.praga, countries: 25 });
  if (viewer && !turnState.countries.some((c) => c.id === viewer)) viewer = null;
  vstate = filterForViewer(map, turnState, viewer);
  const sel = $('view-as') as HTMLSelectElement;
  sel.innerHTML = '<option value="">Observador (vê tudo)</option>' +
    turnState.countries.map((c) => {
      const n = Object.values(turnState!.provinces).filter((p) => p.owner === c.id).length;
      return `<option value="${c.id}"${c.id === viewer ? ' selected' : ''}>${c.fullName[lang]} · ${n} prov.</option>`;
    }).join('');
  $('state-meta').textContent = `Turno ${turnState.turn} · ${turnState.countries.length} países · dados de teste, não são do jogo`;
}

function renderAll() {
  if (!map) return;
  gWorld.innerHTML = mode === 'political' || mode === 'praga'
    ? renderPolitical(map, vstate!, { lang, mode })
    : mode === 'resources' ? renderResources(map)
    : mode === 'starts' ? renderStarts(map, lang)
    : renderWorld(map, { mode });
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
  gOverlay.innerHTML = s;
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
    placeCopies(map.width, map.height);
    viewport.setWorld(map.width, map.height, keepView);
    tiles.setVisible(RASTER_MODES.includes(mode));
    void tiles.setMap(map);
    rebuildState(true);
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
$('export-svg').addEventListener('click', async () => {
  if (!map) return;
  const raster = RASTER_MODES.includes(mode);
  const img = raster ? await tiles.baseImageDataUrl() : undefined;
  if (raster && !img) { $('export-msg').textContent = 'O terreno ainda está a ser desenhado. Tente de novo dentro de momentos.'; return; }
  const content = mode === 'political' || mode === 'praga' ? renderPolitical(map, vstate!, { lang, mode })
    : mode === 'resources' ? renderResources(map) : mode === 'starts' ? renderStarts(map, lang) : undefined;
  saveFile(`${safeName()}-${mode}.svg`, renderStandalone(map, { mode }, '', img ?? undefined, content, LABEL_CSS + ECONOMY_CSS), 'image/svg+xml');
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
  tiles.setVisible(RASTER_MODES.includes(mode));
  renderAll();
});
for (const id of ['ov-cells', 'ov-ids', 'ov-adj', 'ov-seam']) $(id).addEventListener('change', renderOverlays);

$('zoom-in').addEventListener('click', () => viewport.zoomBy(1.6));
$('zoom-out').addEventListener('click', () => viewport.zoomBy(1 / 1.6));
$('zoom-fit').addEventListener('click', () => viewport.fit());
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') select(-1); });

// console handle for debugging: forge.map, forge.select(id), forge.viewport
(window as any).forge = { get map() { return map; }, select: (id: number) => select(id, true), viewport };

regenerate(false);
