export type Point = { x: number; y: number };

export type NamedPoint = Point & {
  name: string;
  description: string;
};

/**
 * Card hand slots, left → right (normalized 0..1 of full screen).
 *
 * How to recalibrate on your phone:
 *   1. Open a battle, then run:  npm run calibrate
 *   2. Open debug/calibration.png — green dots must sit in the CENTER of each card.
 *   3. Edit x/y below (0 = left/top, 1 = right/bottom). Nudge ~0.01–0.02 at a time.
 *      - Dot too high on the card  → increase y
 *      - Dot too far left          → increase x
 *   4. Re-run npm run calibrate and repeat until centered.
 *   5. Smoke test: npm run test-launch -- card_1 center_defense
 */
export const CARD_SLOTS: NamedPoint[] = [
  {
    name: "card_1",
    description:
      "Launch the leftmost card in the hand (slot 1). Use when that card is the best play.",
    x: 0.33,
    y: 0.915,
  },
  {
    name: "card_2",
    description:
      "Launch the second card from the left (slot 2). Use when that card is the best play.",
    x: 0.49,
    y: 0.915,
  },
  {
    name: "card_3",
    description:
      "Launch the third card from the left (slot 3). Use when that card is the best play.",
    x: 0.65,
    y: 0.915,
  },
  {
    name: "card_4",
    description:
      "Launch the rightmost card in the hand (slot 4). Use when that card is the best play.",
    x: 0.81,
    y: 0.915,
  },
];

/**
 * Named tactical placement zones on the arena (normalized coordinates).
 * Our side is the bottom half of the screen; enemy side is the top half.
 * Keep y well above the hand (~0.85+) so ADB taps register as arena drops.
 */
export const PLACEMENT_ZONES: NamedPoint[] = [
  {
    name: "left_bridge",
    description:
      "Our left bridge — push or support a left-lane attack across the river.",
    x: 0.28,
    y: 0.46,
  },
  {
    name: "right_bridge",
    description:
      "Our right bridge — push or support a right-lane attack across the river.",
    x: 0.72,
    y: 0.46,
  },
  {
    name: "left_front_princess",
    description:
      "In front of our left princess tower — defend that tower or tank for a left push.",
    x: 0.25,
    y: 0.55,
  },
  {
    name: "right_front_princess",
    description:
      "In front of our right princess tower — defend that tower or tank for a right push.",
    x: 0.75,
    y: 0.55,
  },
  {
    name: "behind_king_left",
    description:
      "Behind the king tower on the left — safe defensive placement for buildings or support.",
    x: 0.35,
    y: 0.68,
  },
  {
    name: "behind_king_center",
    description:
      "Directly behind the king tower (center) — safest default defensive spot.",
    x: 0.5,
    y: 0.7,
  },
  {
    name: "behind_king_right",
    description:
      "Behind the king tower on the right — safe defensive placement for buildings or support.",
    x: 0.65,
    y: 0.68,
  },
  {
    name: "center_defense",
    description:
      "Center of our half, mid depth — stop a mid-lane push or place a building.",
    x: 0.5,
    y: 0.58,
  },
  {
    name: "left_lane_back",
    description:
      "Deep left lane near our princess tower — kite or defend far back on the left.",
    x: 0.22,
    y: 0.64,
  },
  {
    name: "right_lane_back",
    description:
      "Deep right lane near our princess tower — kite or defend far back on the right.",
    x: 0.78,
    y: 0.64,
  },
  {
    name: "enemy_left_tower",
    description:
      "On/near the enemy left princess tower — for spells (Fireball, Rocket, etc.).",
    x: 0.25,
    y: 0.28,
  },
  {
    name: "enemy_right_tower",
    description:
      "On/near the enemy right princess tower — for spells (Fireball, Rocket, etc.).",
    x: 0.75,
    y: 0.28,
  },
];

export const WAIT_ACTION = {
  name: "wait",
  description:
    "Do nothing this tick. Use ONLY when every useful card costs more elixir than you have, or playing now would clearly waste elixir. Do not wait while an enemy push is unchecked if you can afford a defender.",
} as const;

/** Prefer a mid-arena drop so taps never land on the hand UI. */
export const DEFAULT_FALLBACK_ZONE = "center_defense";

export type CardSlotName = (typeof CARD_SLOTS)[number]["name"];
export type PlacementZoneName = (typeof PLACEMENT_ZONES)[number]["name"];
export type ActionName = typeof WAIT_ACTION.name | CardSlotName;

export function getCardSlot(name: string): NamedPoint | undefined {
  return CARD_SLOTS.find((slot) => slot.name === name);
}

export function getPlacementZone(name: string): NamedPoint | undefined {
  return PLACEMENT_ZONES.find((zone) => zone.name === name);
}

export function toPixels(
  point: Point,
  screen: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: Math.round(point.x * screen.width),
    y: Math.round(point.y * screen.height),
  };
}
