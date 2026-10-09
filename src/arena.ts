import { config } from "./config.js";
import type { PreferredTile } from "./deck/schema.js";
import type { Point } from "./layout.js";

/** Clash Royale playable tiles: 18 wide × 32 tall (full arena including both halves). */
export const ARENA_COLS = 18;
export const ARENA_ROWS = 32;

/** River / bridge row (0-indexed from enemy top). Our side is rows 16..31. */
export const BRIDGE_ROW = 15;
export const OUR_SIDE_START_ROW = 16;

export type Tile = { x: number; y: number };

export type ArenaBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type TowerFlags = {
  enemyLeftDestroyed: boolean;
  enemyRightDestroyed: boolean;
};

/** Named tactical shortcuts → representative tiles (col, row). */
export const TILE_SHORTCUTS: Record<string, Tile> = {
  bridge_left: { x: 3, y: 15 },
  bridge_right: { x: 14, y: 15 },
  bridge: { x: 3, y: 15 },
  front_princess_left: { x: 3, y: 20 },
  front_princess_right: { x: 14, y: 20 },
  behind_king_left: { x: 6, y: 26 },
  behind_king_center: { x: 9, y: 27 },
  behind_king_right: { x: 11, y: 26 },
  behind_king: { x: 9, y: 27 },
  center_defense: { x: 9, y: 22 },
  lane_back_left: { x: 2, y: 24 },
  lane_back_right: { x: 15, y: 24 },
  left_lane_back: { x: 2, y: 24 },
  right_lane_back: { x: 15, y: 24 },
  enemy_left_tower: { x: 3, y: 6 },
  enemy_right_tower: { x: 14, y: 6 },
  enemy_tower: { x: 3, y: 6 },
  kite_back: { x: 9, y: 25 },
};

export function clampTile(tile: Tile): Tile {
  return {
    x: Math.max(0, Math.min(ARENA_COLS - 1, Math.round(tile.x))),
    y: Math.max(0, Math.min(ARENA_ROWS - 1, Math.round(tile.y))),
  };
}

export function resolveShortcut(name: string | PreferredTile): Tile | undefined {
  const mapped = TILE_SHORTCUTS[name];
  return mapped ? { ...mapped } : undefined;
}

/**
 * Convert a tile into normalized screen coordinates (0..1) using arena bounds.
 * Tile (0,0) is top-left of the playable arena (enemy side); y increases toward us.
 */
export function tileToNormalized(
  tile: Tile,
  bounds: ArenaBounds = config.ARENA_BOUNDS,
): Point {
  const t = clampTile(tile);
  const u = (t.x + 0.5) / ARENA_COLS;
  const v = (t.y + 0.5) / ARENA_ROWS;
  return {
    x: bounds.left + u * (bounds.right - bounds.left),
    y: bounds.top + v * (bounds.bottom - bounds.top),
  };
}

export function tileToPixels(
  tile: Tile,
  screen: { width: number; height: number },
  bounds: ArenaBounds = config.ARENA_BOUNDS,
): { x: number; y: number } {
  const n = tileToNormalized(tile, bounds);
  return {
    x: Math.round(n.x * screen.width),
    y: Math.round(n.y * screen.height),
  };
}

/** Coarse perception grid: 6 cols × 8 rows covering the full arena. */
export const COARSE_COLS = 6;
export const COARSE_ROWS = 8;

export function coarseCellId(col: number, row: number): string {
  return `c${col}_r${row}`;
}

export function allCoarseCells(): Array<{ value: string; description: string }> {
  const cells: Array<{ value: string; description: string }> = [
    {
      value: "none",
      description: "No clear cluster / push visible",
    },
  ];
  for (let row = 0; row < COARSE_ROWS; row++) {
    for (let col = 0; col < COARSE_COLS; col++) {
      const side = row < COARSE_ROWS / 2 ? "enemy half" : "our half";
      const lane =
        col < 2 ? "left" : col > 3 ? "right" : "center";
      cells.push({
        value: coarseCellId(col, row),
        description: `${side}, ${lane} lane, coarse cell col=${col} row=${row}`,
      });
    }
  }
  return cells;
}

/** Map a coarse cell to the center tile of that cell. */
export function coarseCellToTile(cell: string): Tile | null {
  if (cell === "none" || !cell) return null;
  const match = /^c(\d+)_r(\d+)$/.exec(cell);
  if (!match) return null;
  const col = Number(match[1]);
  const row = Number(match[2]);
  if (
    col < 0 ||
    col >= COARSE_COLS ||
    row < 0 ||
    row >= COARSE_ROWS
  ) {
    return null;
  }
  const tilesPerCol = ARENA_COLS / COARSE_COLS;
  const tilesPerRow = ARENA_ROWS / COARSE_ROWS;
  return clampTile({
    x: Math.floor(col * tilesPerCol + tilesPerCol / 2),
    y: Math.floor(row * tilesPerRow + tilesPerRow / 2),
  });
}

export function isOurSide(tile: Tile): boolean {
  return clampTile(tile).y >= OUR_SIDE_START_ROW;
}

export function isEnemySide(tile: Tile): boolean {
  return clampTile(tile).y < OUR_SIDE_START_ROW;
}

/**
 * Pocket: enemy half behind a destroyed princess tower (left cols 0-8 or right 9-17).
 */
export function isPocket(
  tile: Tile,
  towers: TowerFlags,
): boolean {
  const t = clampTile(tile);
  if (t.y >= OUR_SIDE_START_ROW) return false;
  if (t.x <= 8 && towers.enemyLeftDestroyed) return true;
  if (t.x >= 9 && towers.enemyRightDestroyed) return true;
  return false;
}

export type PlaceableKind = "troop" | "building" | "spell";

/**
 * Validate / snap a placement tile for the given card type.
 * Spells may go anywhere; troops/buildings only our side (or pocket if unlocked).
 */
export function validatePlacement(
  tile: Tile,
  kind: PlaceableKind,
  towers: TowerFlags,
): { tile: Tile; adjusted: boolean } {
  const clamped = clampTile(tile);
  if (kind === "spell") {
    return { tile: clamped, adjusted: clamped.x !== tile.x || clamped.y !== tile.y };
  }

  if (isOurSide(clamped) || isPocket(clamped, towers)) {
    return {
      tile: clamped,
      adjusted: clamped.x !== Math.round(tile.x) || clamped.y !== Math.round(tile.y),
    };
  }

  // Snap to nearest valid tile on our side, same lane column.
  const snapped: Tile = {
    x: clamped.x,
    y: Math.max(OUR_SIDE_START_ROW, clamped.y),
  };
  return { tile: clampTile(snapped), adjusted: true };
}

/**
 * Lead a spell aim toward our towers (down the screen) based on travel time.
 * Assumes ground units walk ~1 tile / 400ms toward us.
 */
export function leadSpellAim(
  cluster: Tile,
  travelMs: number,
  tilesPerSecond = 2.5,
): Tile {
  const leadTiles = (travelMs / 1000) * tilesPerSecond;
  return clampTile({
    x: cluster.x,
    y: cluster.y + leadTiles,
  });
}

export function laneForTile(tile: Tile): "left" | "right" | "center" {
  const t = clampTile(tile);
  if (t.x <= 5) return "left";
  if (t.x >= 12) return "right";
  return "center";
}

export function bridgeTileForLane(lane: "left" | "right" | "center"): Tile {
  if (lane === "right") return { ...TILE_SHORTCUTS.bridge_right! };
  if (lane === "left") return { ...TILE_SHORTCUTS.bridge_left! };
  return { x: 9, y: BRIDGE_ROW };
}

export function frontPrincessForLane(lane: "left" | "right"): Tile {
  return lane === "left"
    ? { ...TILE_SHORTCUTS.front_princess_left! }
    : { ...TILE_SHORTCUTS.front_princess_right! };
}

/** All fine tiles as a flat list (for calibration overlays). */
export function sampleGridTiles(step = 2): Tile[] {
  const out: Tile[] = [];
  for (let y = 0; y < ARENA_ROWS; y += step) {
    for (let x = 0; x < ARENA_COLS; x += step) {
      out.push({ x, y });
    }
  }
  return out;
}
