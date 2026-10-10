// Turn state: the part of the map that changes every turn. This is the contract
// between the game server and the map renderer. The static map (geometry, terrain,
// names) never changes; this does.
//
// SECURITY: the server must send each player an ALREADY FILTERED state
// (see filterForViewer). Greying provinces out in the client is presentation only —
// anything the client receives, the player can read.
import type { LocalName } from '../gen/types';

/** Praga level per province: 0 absent · 1 present · 2 infested · 3 devastated. */
export type PragaLevel = 0 | 1 | 2 | 3;

export interface Country {
  id: string;
  /** Short name used on the map ("Valmora"). */
  name: LocalName;
  /** Full name used in the interface ("Reino de Valmora" / "Kingdom of Valmora"). */
  fullName: LocalName;
  /** Map colour, CSS hex. */
  color: string;
}

export interface ProvinceState {
  owner: string | null;
  /** Who holds it militarily; differs from owner when occupied. */
  controller: string | null;
  praga: PragaLevel;
}

export interface TurnState {
  turn: number;
  countries: Country[];
  /** Keyed by region id (land provinces only). */
  provinces: Record<number, ProvinceState>;
  /** Region ids each country has explored (land and sea). */
  known: Record<string, number[]>;
  /** Start slots (from the static map) still reserved for late joiners. The SERVER
   *  must refuse any move into their provinces while they are listed here. */
  reservedSlots?: number[];
}

/** What one viewer receives: a filtered TurnState plus the set of regions they can see. */
export interface ViewerState extends TurnState {
  viewer: string | null; // null = observer (sees everything)
  /** Region ids shown in colour; everything else is drawn grey (terra incognita). */
  visible: number[];
}

/** Minimal static-map shape the state logic needs (GeneratedMap or the exported JSON). */
export interface StateMap {
  regions: { id: number; kind: string; neighbors: number[] }[];
}

/**
 * Visibility rule (decided with Pedro): a region is shown if it is owned or known by
 * the viewer, or is adjacent to such a region. Everything else is grey.
 */
export function visibleFor(map: StateMap, state: TurnState, viewer: string | null): Set<number> {
  if (viewer === null) return new Set(map.regions.map((r) => r.id));
  const base = new Set<number>(state.known[viewer] ?? []);
  for (const [id, p] of Object.entries(state.provinces)) if (p.owner === viewer || p.controller === viewer) base.add(Number(id));
  const out = new Set(base);
  for (const id of base) for (const o of map.regions[id]?.neighbors ?? []) out.add(o);
  return out;
}

/** Strip everything the viewer may not see. Run this on the SERVER before sending. */
export function filterForViewer(map: StateMap, state: TurnState, viewer: string | null): ViewerState {
  const vis = visibleFor(map, state, viewer);
  const provinces: Record<number, ProvinceState> = {};
  for (const [id, p] of Object.entries(state.provinces)) if (vis.has(Number(id))) provinces[Number(id)] = p;
  const seen = new Set<string>();
  for (const p of Object.values(provinces)) { if (p.owner) seen.add(p.owner); if (p.controller) seen.add(p.controller); }
  if (viewer) seen.add(viewer);
  return {
    turn: state.turn,
    countries: state.countries.filter((c) => viewer === null || seen.has(c.id)),
    provinces,
    known: viewer ? { [viewer]: state.known[viewer] ?? [] } : state.known,
    reservedSlots: state.reservedSlots,
    viewer,
    visible: Array.from(vis).sort((a, b) => a - b),
  };
}
