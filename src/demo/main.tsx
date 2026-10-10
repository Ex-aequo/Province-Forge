// Demo game client: what a player's browser does in production.
//   1. terrain tiles: static, public, cacheable — here from ./demo-map/tiles
//   2. per turn, from the server: the view (filter_for_viewer) and the client map cut
//      to that view (filter_client_map) — here pre-baked JSON files
//   3. <ProvinceMap> draws it; hidden land has no geometry in the browser at all
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ViewerState } from '../game/state';
import type { ClientMap, TileSpec } from '../map/clientMap';
import type { Lang } from '../render/political';
import { RESOURCE_EN, RESOURCE_PT } from '../render/economy';
import type { MapMode, MapView } from '../view/MapView';
import { ProvinceMap } from '../view/MapViewReact';
import { UrlTileSource } from '../view/tileSources';

interface DemoIndex { mapId: string; seed: string; tiles: TileSpec; turns: { turn: number; views: { id: string; label: string; file: string; map: string }[] }[] }

const BASE = `${import.meta.env.BASE_URL}demo-map/`;
const getJson = async <T,>(f: string): Promise<T> => {
  const r = await fetch(BASE + f);
  if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
  return r.json();
};

const MODES: { id: MapMode; pt: string; en: string; gmOnly?: boolean }[] = [
  { id: 'political', pt: 'Político', en: 'Political' },
  { id: 'praga', pt: 'Praga', en: 'Praga' },
  { id: 'terrain', pt: 'Relevo', en: 'Relief' },
  { id: 'terrainType', pt: 'Tipo de terreno', en: 'Terrain type' },
  { id: 'resources', pt: 'Recursos', en: 'Resources' },
  { id: 'starts', pt: 'Posições iniciais (GM)', en: 'Start positions (GM)', gmOnly: true },
];

function App() {
  const [index, setIndex] = useState<DemoIndex | null>(null);
  const [map, setMap] = useState<ClientMap | null>(null);
  const [bytes, setBytes] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [turnIdx, setTurnIdx] = useState(1);
  const [viewer, setViewer] = useState(0);
  const [view, setView] = useState<ViewerState | null>(null);
  const [mode, setMode] = useState<MapMode>('political');
  const [lang, setLang] = useState<Lang>('pt');
  const [hover, setHover] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const api = useRef<MapView | null>(null);

  useEffect(() => {
    getJson<DemoIndex>('demo.json')
      .then((ix) => setIndex(ix))
      .catch((e) => setErr(String(e)));
  }, []);

  const tiles = useMemo(() => (index ? new UrlTileSource(BASE, index.tiles) : null), [index]);
  const turn = index?.turns[turnIdx];
  const entry = turn?.views[Math.min(viewer, turn.views.length - 1)];

  useEffect(() => {
    if (!entry) return;
    // view and map change together, so the map never shows a mismatched turn
    Promise.all([getJson<ViewerState>(entry.file), fetch(BASE + entry.map).then((r) => r.text())])
      .then(([v, txt]) => { setBytes(txt.length); setMap(JSON.parse(txt)); setView(v); })
      .catch((e) => setErr(String(e)));
  }, [entry?.file, entry?.map]);

  const isGm = !!view?.gm;
  useEffect(() => { if (!isGm && mode === 'starts') setMode('political'); }, [isGm, mode]);

  if (err) return <div className="err">Não foi possível carregar a demonstração: {err}</div>;
  if (!index || !map || !turn) return <div className="err" style={{ color: '#9aa4ad' }}>A carregar…</div>;

  const shown = selected ?? hover;
  const t = (pt: string, en: string) => (lang === 'pt' ? pt : en);

  return (
    <div className="app">
      <header>
        <h1>Province Forge <small>· {t('cliente de demonstração', 'demo client')}</small></h1>
        <label>{t('Turno', 'Turn')}
          <select value={turnIdx} onChange={(e) => setTurnIdx(+e.target.value)}>
            {index.turns.map((x, i) => <option key={x.turn} value={i}>{x.turn}</option>)}
          </select>
        </label>
        <label>{t('Jogador', 'Player')}
          <select value={viewer} onChange={(e) => { setViewer(+e.target.value); setSelected(null); }}>
            {turn.views.map((v, i) => <option key={v.id} value={i}>{v.id === 'gm' ? t('Mestre de jogo', 'Game master') : v.label}</option>)}
          </select>
        </label>
        <label>{t('Mapa', 'Map')}
          <select value={mode} onChange={(e) => setMode(e.target.value as MapMode)}>
            {MODES.filter((m) => !m.gmOnly || isGm).map((m) => <option key={m.id} value={m.id}>{lang === 'pt' ? m.pt : m.en}</option>)}
          </select>
        </label>
        <label>{t('Idioma', 'Language')}
          <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
            <option value="pt">Português</option><option value="en">English</option>
          </select>
        </label>
      </header>
      <div className="stage">
        <ProvinceMap map={map} tiles={tiles} view={view} lang={lang} mode={mode} selected={selected}
          onSelect={setSelected} onHover={(id) => setHover(id)} apiRef={api} />
        {shown !== null && <Info id={shown} map={map} view={view} lang={lang} />}
        <div className="zoom">
          <button onClick={() => api.current?.zoomBy(1.5)} aria-label="zoom +">+</button>
          <button onClick={() => api.current?.zoomBy(1 / 1.5)} aria-label="zoom −">−</button>
          <button onClick={() => api.current?.fit()} aria-label="fit">⤢</button>
        </div>
        <div className="note">{t('Dados de teste', 'Test data')} · {index.mapId} · {t('mapa recebido', 'map received')}: {Math.round(bytes / 1024)} KB · {map.regions.filter(Boolean).length}/{map.regions.length} {t('regiões', 'regions')}</div>
      </div>
    </div>
  );
}

function Info({ id, map, view, lang }: { id: number; map: ClientMap; view: ViewerState | null; lang: Lang }) {
  const r = map.regions[id];
  if (!r) return <div className="info"><b>{lang === 'pt' ? 'Terra incógnita' : 'Terra incognita'}</b></div>;
  const visible = !view || view.visible.includes(id);
  const p = view?.provinces[id];
  const owner = p?.owner ? view?.countries.find((c) => c.id === p.owner) : null;
  const d = view?.details[id];
  const pt = lang === 'pt';
  return (
    <div className="info">
      {!visible ? <b>{pt ? 'Terra incógnita' : 'Terra incognita'}</b> : <>
        <b>{r.name ? r.name[lang] : `#${id}`}</b>
        {owner && <div>{pt ? 'Dono' : 'Owner'}: {owner.fullName[lang]}</div>}
        {d && <div>{pt ? 'Recurso' : 'Resource'}: {(pt ? RESOURCE_PT : RESOURCE_EN)[d.resource]} ×{d.amount}{d.value !== undefined ? ` · ${pt ? 'valor' : 'value'} ${d.value}` : ''}</div>}
        {p && p.praga > 0 && <div>Praga: {p.praga}</div>}
      </>}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
