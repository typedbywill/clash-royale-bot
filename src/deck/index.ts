import { readFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { deckSchema, type Deck, type DeckCard } from "./schema.js";

let cached: Deck | null = null;
let cachedPath: string | null = null;

export function loadDeck(filePath?: string): Deck {
  const resolved = path.resolve(
    process.cwd(),
    filePath ?? config.DECK_FILE ?? "deck.json",
  );
  if (cached && cachedPath === resolved) {
    return cached;
  }
  const raw = JSON.parse(readFileSync(resolved, "utf8"));
  const deck = deckSchema.parse(raw);
  const ids = new Set(deck.cards.map((c) => c.id));
  if (ids.size !== 8) {
    throw new Error(`deck.json must have 8 unique card ids (got ${ids.size})`);
  }
  for (const counter of deck.reactiveCounters) {
    for (const id of counter.use) {
      if (!ids.has(id)) {
        throw new Error(
          `reactiveCounters references unknown card id "${id}" (not in deck)`,
        );
      }
    }
  }
  cached = deck;
  cachedPath = resolved;
  return deck;
}

export function getCard(deck: Deck, id: string): DeckCard | undefined {
  return deck.cards.find((c) => c.id === id);
}

export function cardChoices(deck: Deck): Array<{ value: string; description: string }> {
  return deck.cards.map((card) => ({
    value: card.id,
    description: `${card.name} (${card.elixir} elixir, ${card.type}) — ${card.usage}`,
  }));
}

export function deckSummary(deck: Deck): string {
  const cards = deck.cards
    .map(
      (c) =>
        `- ${c.id}: ${c.name} [${c.elixir}] ${c.type}/${c.roles.join(",") || "none"} — ${c.usage}`,
    )
    .join("\n");
  const counters = deck.reactiveCounters
    .map(
      (c) =>
        `- threat=${c.threat} (min ${c.minThreat}): use [${c.use.join(", ")}] place=${c.place}`,
    )
    .join("\n");
  return [
    `Archetype: ${deck.archetype}`,
    `Gameplan: ${deck.gameplan}`,
    "Cards:",
    cards,
    "Reactive counters:",
    counters || "(none)",
    "Phase notes:",
    `  single: ${deck.phases.single_elixir ?? "n/a"}`,
    `  double: ${deck.phases.double_elixir ?? "n/a"}`,
    `  overtime: ${deck.phases.overtime ?? "n/a"}`,
  ].join("\n");
}

export type { Deck, DeckCard } from "./schema.js";
