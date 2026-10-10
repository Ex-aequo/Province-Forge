// React wrapper around MapView for the game client (React + Vite).
//
//   <ProvinceMap map={clientMap} tiles={tileSource} view={viewerState} lang="pt"
//                mode="political" onSelect={(id) => ...} />
//
// The MapView instance is created once; prop changes are pushed into it.
import { useEffect, useRef } from 'react';
import type { ViewerState } from '../game/state';
import type { ClientMap } from '../map/clientMap';
import type { Lang } from '../render/political';
import { MapView, type MapMode } from './MapView';
import type { TileSource } from './tileSources';

export interface ProvinceMapProps {
  map: ClientMap;
  tiles: TileSource | null;
  view: ViewerState | null;
  lang?: Lang;
  mode?: MapMode;
  selected?: number | null;
  onSelect?: (regionId: number | null) => void;
  onHover?: (regionId: number | null, screenX: number, screenY: number) => void;
  className?: string;
  style?: React.CSSProperties;
  /** Receives the MapView instance (for fit(), zoomBy(), export…). */
  apiRef?: React.MutableRefObject<MapView | null>;
}

export function ProvinceMap(props: ProvinceMapProps) {
  const host = useRef<HTMLDivElement>(null);
  const mv = useRef<MapView | null>(null);
  const cb = useRef(props);
  cb.current = props;

  // create once
  useEffect(() => {
    if (!host.current) return;
    const v = new MapView(host.current, {
      map: props.map, tiles: props.tiles, view: props.view, lang: props.lang, mode: props.mode,
      onSelect: (id) => cb.current.onSelect?.(id),
      onHover: (id, x, y) => cb.current.onHover?.(id, x, y),
    });
    mv.current = v;
    if (props.apiRef) props.apiRef.current = v;
    return () => { v.destroy(); mv.current = null; if (props.apiRef) props.apiRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { mv.current?.setMap(props.map, props.tiles); }, [props.map, props.tiles]);
  useEffect(() => { mv.current?.setView(props.view); }, [props.view]);
  useEffect(() => { if (props.lang) mv.current?.setLang(props.lang); }, [props.lang]);
  useEffect(() => { if (props.mode) mv.current?.setMode(props.mode); }, [props.mode]);
  useEffect(() => { if (props.selected !== undefined) mv.current?.select(props.selected); }, [props.selected]);

  return <div ref={host} className={props.className} style={{ position: 'relative', width: '100%', height: '100%', ...props.style }} />;
}
