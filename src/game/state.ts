// Turn state: the part of the map that changes every turn. This is the contract
// between the game server and the map renderer. The static map (geometry, terrain,
// names) never changes; this does.
//
// SECURITY: the server must send each player an ALREADY FILTERED state
// (see filterForViewer). Greying provinces out in the client is presentation only —
// anything the client receives, the player can read.
import type { Fairness, LocalName, Resource, StartPosition } from '../gen/types';

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
  viewer: string | null; // null = game master (sees everything)
  /** Region ids shown in colour; everything else is drawn grey (terra incognita). */
  visible: number[];
  /** Static facts revealed only for visible provinces (not in the client map). */
  details: Record<number, ProvinceDetails>;
  /** Reserved start territories the viewer can see (drawn hatched, untouchable). */
  reserved: { slot: number; provinces: number[] }[];
  /** Game-master extras — present only when the server built the view for a GM. */
  gm?: GmExtras;
}

export interface ProvinceDetails { resource: Resource; amount: number; value?: number }

export interface GmExtras {
  starts: StartPosition[];
  pragaSeeds: number[];
  fairness: Fairness | null;
}

/** Minimal static-map shape the state logic needs (GeneratedMap or the static JSON). */
export interface StateMap {
  regions: { id: number; kind: string; neighbors: number[]; resource?: Resource | null; amount?: number | null; value?: number | null }[];
  starts?: StartPosition[];
  pragaSeeds?: number[];
  fairness?: Fairness | null;
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

export interface FilterOptions {
  /** Build the game-master view. Only the server may set this, after checking the role. */
  gm?: boolean;
}

/**
 * Strip everything the viewer may not see. Run this on the SERVER before sending.
 * `viewer: null` (see everything) is only allowed together with `gm: true`.
 */
export function filterForViewer(map: StateMap, state: TurnState, viewer: string | null, opt: FilterOptions = {}): ViewerState {
  if (viewer === null && !opt.gm) throw new Error('filterForViewer: viewer null requires gm: true');
  const vis = visibleFor(map, state, viewer);
  const provinces: Record<number, ProvinceState> = {};
  for (const [id, p] of Object.entries(state.provinces)) if (vis.has(Number(id))) provinces[Number(id)] = p;
  const seen = new Set<string>();
  for (const p of Object.values(provinces)) { if (p.owner) seen.add(p.owner); if (p.controller) seen.add(p.controller); }
  if (viewer) seen.add(viewer);
  const details: Record<number, ProvinceDetails> = {};
  for (const id of vis) {
    const r = map.regions[id];
    if (r?.kind === 'land' && r.resource) details[id] = { resource: r.resource, amount: r.amount ?? 1, ...(opt.gm ? { value: r.value ?? 0 } : {}) };
  }
  const reservedSlots = new Set(state.reservedSlots ?? []);
  const reserved = (map.starts ?? [])
    .filter((st) => reservedSlots.has(st.slot) && st.provinces.some((id) => vis.has(id)))
    .map((st) => ({ slot: st.slot, provinces: st.provinces.filter((id) => vis.has(id)) }));
  return {
    turn: state.turn,
    countries: state.countries.filter((c) => viewer === null || seen.has(c.id)),
    provinces,
    known: viewer ? { [viewer]: state.known[viewer] ?? [] } : state.known,
    reservedSlots: state.reservedSlots,
    viewer,
    visible: Array.from(vis).sort((a, b) => a - b),
    details,
    reserved,
    ...(opt.gm ? { gm: { starts: map.starts ?? [], pragaSeeds: map.pragaSeeds ?? [], fairness: map.fairness ?? null } } : {}),
  };
}

/** Server-side rule: may `country` move into / claim `province` this turn? */
export function canEnter(map: StateMap, state: TurnState, province: number): boolean {
  const r = map.regions[province];
  if (!r || (r.kind !== 'land' && r.kind !== 'sea')) return false;
  const reserved = new Set(state.reservedSlots ?? []);
  return !(map.starts ?? []).some((st) => reserved.has(st.slot) && st.provinces.includes(province));
}
