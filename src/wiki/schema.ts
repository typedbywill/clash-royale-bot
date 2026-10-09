import { z } from "zod";

export const wikiCardSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  elixir: z.number().int().min(1).max(10).optional(),
  type: z.enum(["troop", "building", "spell"]).optional(),
  summary: z.string().min(1),
  strengths: z.array(z.string()).default([]),
  weaknesses: z.array(z.string()).default([]),
  /** Card ids / archetypes this card beats. */
  counters: z.array(z.string()).default([]),
  /** Card ids / archetypes that beat this card. */
  counteredBy: z.array(z.string()).default([]),
  tips: z.array(z.string()).default([]),
});

export const cardWikiSchema = z.object({
  version: z.number().int().positive().default(1),
  cards: z.array(wikiCardSchema).min(1),
});

export type WikiCard = z.infer<typeof wikiCardSchema>;
export type CardWiki = z.infer<typeof cardWikiSchema>;
