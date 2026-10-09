import { z } from "zod";

export const cardRoleSchema = z.enum([
  "win_condition",
  "tank",
  "support",
  "swarm",
  "air_defense",
  "building",
  "spell_small",
  "spell_medium",
  "spell_heavy",
  "cycle",
  "bait",
]);

export const cardTypeSchema = z.enum(["troop", "building", "spell"]);

export const preferredTileSchema = z.enum([
  "bridge",
  "bridge_left",
  "bridge_right",
  "behind_king",
  "behind_king_left",
  "behind_king_right",
  "front_princess_left",
  "front_princess_right",
  "lane_back_left",
  "lane_back_right",
  "center_defense",
  "enemy_tower",
  "on_cluster",
  "kite_back",
]);

export const deckCardSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  elixir: z.number().int().min(1).max(10),
  type: cardTypeSchema,
  roles: z.array(cardRoleSchema).default([]),
  targets: z
    .enum(["ground", "air", "buildings", "all", "none"])
    .optional()
    .default("all"),
  usage: z.string().min(1),
  /** Short visual cues for screenshot recognition (art, color, shape). */
  visual: z.string().optional().default(""),
  neverAlone: z.boolean().optional().default(false),
  preferredTiles: z.array(preferredTileSchema).optional().default([]),
  /** Spell splash radius in tiles (Clash Royale units). */
  radius: z.number().positive().optional(),
  /** Spell projectile travel time in ms (for lead aiming). */
  travelMs: z.number().int().nonnegative().optional(),
  /** Minimum enemy elixir value before casting this spell. */
  minValueElixir: z.number().nonnegative().optional(),
});

export const reactiveCounterSchema = z.object({
  threat: z.enum([
    "air_troop",
    "swarm",
    "tank",
    "win_condition",
    "building",
    "spell_bait",
    "any_push",
  ]),
  use: z.array(z.string().min(1)).min(1),
  place: z.enum([
    "in_front_of_threatened_tower",
    "on_cluster",
    "behind_king",
    "opposite_bridge",
    "same_lane_bridge",
    "kite_back",
  ]),
  minThreat: z.number().min(0).max(9).optional().default(5),
});

export const deckSchema = z.object({
  archetype: z.string().min(1),
  gameplan: z.string().min(1),
  cards: z.array(deckCardSchema).length(8),
  reactiveCounters: z.array(reactiveCounterSchema).default([]),
  phases: z
    .object({
      single_elixir: z.string().optional(),
      double_elixir: z.string().optional(),
      overtime: z.string().optional(),
    })
    .default({}),
});

export type CardRole = z.infer<typeof cardRoleSchema>;
export type CardType = z.infer<typeof cardTypeSchema>;
export type PreferredTile = z.infer<typeof preferredTileSchema>;
export type DeckCard = z.infer<typeof deckCardSchema>;
export type ReactiveCounter = z.infer<typeof reactiveCounterSchema>;
export type Deck = z.infer<typeof deckSchema>;
