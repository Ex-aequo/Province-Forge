// Shared types for the generator. The exported JSON (see export.ts) is the contract
// with the game server — the SVG is only one way of looking at it.

export interface GenParams {
  seed: string;
  /** World size in map units. The world wraps east–west (x). */
  width: number;
  height: number;
  /** Approximate number of Voronoi cells (fine terrain resolution). */
  cellCount: number;
  /** Lloyd relaxation passes (0–3). More = more regular cells. */
  relaxIterations: number;
  /** Fraction of the world that is land (0.2–0.6). */
  landFraction: number;
  /** Relative size of the three continents (each 0.4–1.6). */
  continentSizes: [number, number, number];
  /** Minimum open water between two continents, in cells (≈ coastal sea band × 2). */
  minStraitCells: number;
  /** Domain-warp strength for continent outlines (0 = blobs, 1 = very ragged). */
  coastRoughness: number;
  /** Number of island seeds scattered in the oceans. */
  islandCount: number;
  /** Target number of land provinces. */
  landProvinces: number;
  /** Target size of coastal sea zones, in cells. */
  coastalZoneCells: number;
  /** Target size of open-ocean sea zones, in cells. */
  oceanZoneCells: number;
  /** Width of the coastal sea band, in cell hops from the coast. */
  coastalBandHops: number;
  /** Smallest allowed province as a fraction of the mean province size. */
  minProvinceFraction: number;
  /** How strongly province borders prefer to follow elevation changes (ridges). */
  ridgeBorderWeight: number;
  /** Fraction of the height kept as ocean at each pole. */
  polarMargin: number;
  /** Amplitude of the noisy-edge displacement on borders (0–1). */
  borderDetail: number;
  /** Chaikin smoothing passes for borders (0–3). */
  borderSmoothing: number;
  // ---- M2: hydrology & climate
  /** Share of land cells crossed by a drawn river (0.02–0.12). */
  riverDensity: number;
  /** How strongly province borders prefer to follow rivers (0 = ignore rivers). */
  riverBorderWeight: number;
  /** Number of lakes to carve inland. */
  lakeCount: number;
  /** Polar ice cap thickness as a fraction of map height. */
  polarIce: number;
  /** Shifts the whole climate warmer (+) or colder (−), −0.3..0.3. */
  temperatureBias: number;
  /** Shifts the whole climate wetter (+) or drier (−), −0.3..0.3. */
  moistureBias: number;
  // ---- M4: start positions
  /** Player start positions (filled when the game starts). */
  playerSlots: number;
  /** Extra start positions kept untouchable for players who join mid-game. */
  reserveSlots: number;
  /** Provinces in every start position. */
  startProvinces: number;
  /** Allowed difference between the richest and poorest start, as a fraction of the mean. */
  valueTolerance: number;
  /** Fraction of land provinces that get a rare resource (gold, spices). */
  rareShare: number;
}

export const DEFAULT_PARAMS: GenParams = {
  seed: 'ex-aequo',
  width: 4000,
  height: 2000,
  cellCount: 36000,
  relaxIterations: 2,
  landFraction: 0.5,
  continentSizes: [1, 1, 1],
  minStraitCells: 7,
  coastRoughness: 0.7,
  islandCount: 14,
  landProvinces: 650,
  coastalZoneCells: 60,
  oceanZoneCells: 280,
  coastalBandHops: 3,
  minProvinceFraction: 0.5,
  ridgeBorderWeight: 1,
  polarMargin: 0.07,
  borderDetail: 0.45,
  borderSmoothing: 2,
  riverDensity: 0.06,
  riverBorderWeight: 1,
  lakeCount: 7,
  polarIce: 0.035,
  temperatureBias: 0,
  moistureBias: 0,
  playerSlots: 25,
  reserveSlots: 5,
  startProvinces: 8,
  valueTolerance: 0.05,
  rareShare: 0.07,
};

/** What a cell is. Lakes and ice are impassable and belong to no gameplay graph. */
export const CT = { Land: 0, Sea: 1, Lake: 2, Ice: 3 } as const;

export type Biome = 'snow' | 'tundra' | 'taiga' | 'forest' | 'grassland' | 'steppe' | 'savanna' | 'desert' | 'jungle' | 'marsh';
export const BIOMES: Biome[] = ['snow', 'tundra', 'taiga', 'forest', 'grassland', 'steppe', 'savanna', 'desert', 'jungle', 'marsh'];

/** Gameplay terrain types — part of the contract with the game server. */
export type Terrain = 'plains' | 'forest' | 'hills' | 'mountains' | 'desert' | 'marsh' | 'jungle' | 'tundra';
export const TERRAINS: Terrain[] = ['plains', 'forest', 'hills', 'mountains', 'desert', 'marsh', 'jungle', 'tundra'];

/** Province resources — part of the contract with the game server. */
export type Resource = 'grain' | 'wood' | 'stone' | 'iron' | 'horses' | 'salt' | 'gold' | 'spices';
export const RESOURCES: Resource[] = ['grain', 'wood', 'stone', 'iron', 'horses', 'salt', 'gold', 'spices'];
export const RARE_RESOURCES: Resource[] = ['gold', 'spices'];
/** Every start position is guaranteed these. */
export const BASIC_RESOURCES: Resource[] = ['grain', 'wood', 'stone', 'iron'];

export interface StartPosition {
  /** 0-based slot number. Player slots first, then reserve slots. */
  slot: number;
  /** Untouchable until a late-joining player is assigned to it (enforced by the server). */
  reserved: boolean;
  /** Continent landmass id. */
  landmass: number;
  capital: number;
  /** Region ids, capital first. */
  provinces: number[];
  value: number;
  /** Free (non-start) land provinces within 3 land steps of the territory. */
  freeNearby: number;
  /** Land steps from the capital to the nearest gold / spices province. */
  rareDistance: number;
}

export interface Fairness {
  /** (max − min) / mean of start values. */
  valueSpread: number;
  valueMin: number;
  valueMax: number;
  freeMin: number;
  freeMax: number;
  /** Minimum land steps between any two capitals. */
  minCapitalDistance: number;
  rareDistMin: number;
  rareDistMax: number;
  /** 0–100, higher is fairer (shown in the tool, for comparing seeds). */
  score: number;
  attempts: number;
}

/** A display name in both game languages. Invented proper nouns are identical; only
 *  the generic part is translated ("Mar de Kaldor" / "Sea of Kaldor"). */
export interface LocalName { pt: string; en: string }

export type Culture = 'iberian' | 'nordic' | 'desert';

export interface River {
  /** Rivers made of several pieces (split by lakes) share the same id and name. */
  id: number;
  name?: LocalName;
  /** Smoothed polyline (flat x,y), unwrapped — may extend past [0,width]. */
  pts: number[];
  /** Width in map units at each point. */
  widths: number[];
}

export type RegionKind = 'land' | 'sea' | 'lake' | 'ice';
export type SeaKind = 'coastal' | 'ocean';

export interface Region {
  id: number;
  kind: RegionKind;
  seaKind?: SeaKind;
  /** Index of the landmass: 0..2 = the three continents, 3+ = islands; -1 for sea. */
  landmass: number;
  cells: number[];
  area: number;
  /** A point guaranteed to be inside the region (centre of its most central cell). */
  label: [number, number];
  /** Passable neighbours only (land and sea); lakes and ice never appear here. */
  neighbors: number[];
  /** Subset of `neighbors` separated from this region by a river (land–land only). */
  riverNeighbors: number[];
  name?: LocalName;
  /** Gameplay terrain (land provinces only). */
  terrain?: Terrain;
  /** A river runs through or along this province. */
  hasRiver?: boolean;
  /** Main resource and its amount (1–3) — land provinces only. */
  resource?: Resource;
  amount?: number;
  /** Economic value used for balancing start positions. */
  value?: number;
  /** Start slot this province belongs to (land only), if any. */
  startSlot?: number;
  /** Polygon rings (flat x,y arrays). May extend past [0,width] — render with wrap copies. */
  rings: number[][];
  coastal: boolean;
}

/** coast = land–sea · land = land–land · sea = sea–sea · lakeshore = lake–land ·
 *  ice = ice–(land|sea) · iceInner = between ice chunks · edge = top/bottom of the world */
export type BorderKind = 'coast' | 'land' | 'sea' | 'lakeshore' | 'ice' | 'iceInner' | 'edge';

export interface BorderChain {
  /** Region ids on either side (b = -1 for the top/bottom world edge). */
  a: number;
  b: number;
  kind: BorderKind;
  closed: boolean;
  /** Smoothed polyline, flat x,y. */
  pts: number[];
}

export interface Landmass {
  id: number;
  /** Technical label tied to the share sliders ("Continente A"); not shown to players. */
  name: string;
  /** Generated proper name. */
  title?: LocalName;
  culture?: Culture;
  isContinent: boolean;
  cells: number;
  provinces: number;
}

export interface ValidationIssue {
  level: 'error' | 'warn';
  message: string;
}

export interface MapStats {
  cells: number;
  landCells: number;
  landPct: number;
  landProvinces: number;
  seaZones: number;
  coastalZones: number;
  oceanZones: number;
  provinceCellsMin: number;
  provinceCellsMean: number;
  provinceCellsMax: number;
  provinceAreaCv: number;
  smallestProvinceId: number;
  rivers: number;
  lakes: number;
  /** Land provinces per gameplay terrain. */
  terrainCounts: Record<Terrain, number>;
  /** Land–land adjacencies that cross a river. */
  riverCrossings: number;
  resourceCounts: Record<Resource, number>;
  timings: Record<string, number>;
}

export interface GeneratedMap {
  params: GenParams;
  width: number;
  height: number;
  /** Cell sites and elevation (−1..0 water, 0..1 land). */
  cellX: Float64Array;
  cellY: Float64Array;
  elevation: Float64Array;
  cellRegion: Int32Array;
  /** CT.* per cell. */
  cellType: Uint8Array;
  /** Index into BIOMES (land cells; 255 for water). */
  biome: Uint8Array;
  /** Index into TERRAINS (land cells; 255 for water). */
  cellTerrain: Uint8Array;
  temperature: Float32Array;
  moisture: Float32Array;
  rivers: River[];
  /** Delaunay triangles (incl. seam ghosts) for smooth raster interpolation. */
  triXY: Float64Array;
  triCell: Int32Array;
  /** Cell polygons in their own frame (flat x,y). */
  cellPolys: Float64Array[];
  regions: Region[];
  starts: StartPosition[];
  fairness: Fairness | null;
  /** Free land provinces where the Praga begins, as far as possible from every start. */
  pragaSeeds: number[];
  borders: BorderChain[];
  landmasses: Landmass[];
  stats: MapStats;
  issues: ValidationIssue[];
  /** Nearest-cell lookup that respects the east–west wrap. */
  findCell: (x: number, y: number) => number;
}
