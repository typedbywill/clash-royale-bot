import { readFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { cardWikiSchema, type CardWiki, type WikiCard } from "./schema.js";

let cached: CardWiki | null = null;
let cachedPath: string | null = null;

export function loadWiki(filePath?: string): CardWiki {
  const resolved = path.resolve(
    process.cwd(),
    filePath ?? config.WIKI_FILE ?? "wiki/cards.json",
  );
  if (cached && cachedPath === resolved) return cached;
  const raw = JSON.parse(readFileSync(resolved, "utf8"));
  const wiki = cardWikiSchema.parse(raw);
  const ids = new Set<string>();
  for (const card of wiki.cards) {
    if (ids.has(card.id)) {
      throw new Error(`wiki duplicate card id: ${card.id}`);
    }
    ids.add(card.id);
  }
  cached = wiki;
  cachedPath = resolved;
  return wiki;
}

export function getWikiCard(wiki: CardWiki, id: string): WikiCard | undefined {
  const key = id.trim().toLowerCase().replace(/\s+/g, "_");
  return (
    wiki.cards.find((c) => c.id === key) ??
    wiki.cards.find((c) => c.id.replace(/_/g, "") === key.replace(/_/g, ""))
  );
}

function formatOne(card: WikiCard, role: "ours" | "enemy"): string {
  const lines = [
    `[${role}] ${card.name} (${card.id}${card.elixir != null ? `, ${card.elixir}el` : ""})`,
    `  ${card.summary}`,
  ];
  if (card.strengths.length) {
    lines.push(`  Strengths: ${card.strengths.join("; ")}`);
  }
  if (card.weaknesses.length) {
    lines.push(`  Weaknesses: ${card.weaknesses.join("; ")}`);
  }
  if (card.counters.length) {
    lines.push(`  Counters: ${card.counters.join(", ")}`);
  }
  if (card.counteredBy.length) {
    lines.push(`  Countered by: ${card.counteredBy.join(", ")}`);
  }
  if (card.tips.length) {
    lines.push(`  Tips: ${card.tips.slice(0, 3).join("; ")}`);
  }
  return lines.join("\n");
}

/**
 * Build a compact wiki slice for the planner: our deck cards + enemy cards seen.
 * Also adds cross-tips when our cards appear in an enemy's counteredBy / counters.
 */
export function formatWikiContext(
  ourCardIds: string[],
  enemyCardIds: string[],
  wiki?: CardWiki,
): string {
  const catalog = wiki ?? loadWiki();
  const our = [...new Set(ourCardIds.map((id) => id.toLowerCase()))];
  const enemy = [...new Set(enemyCardIds.map((id) => id.toLowerCase()))];

  const blocks: string[] = [];
  const missing: string[] = [];

  for (const id of our) {
    const card = getWikiCard(catalog, id);
    if (card) blocks.push(formatOne(card, "ours"));
    else missing.push(id);
  }

  for (const id of enemy) {
    const card = getWikiCard(catalog, id);
    if (card) blocks.push(formatOne(card, "enemy"));
    else missing.push(`enemy:${id}`);
  }

  // Cross-match: which of OUR cards specifically answer THEIR cards
  const cross: string[] = [];
  for (const enemyId of enemy) {
    const enemyCard = getWikiCard(catalog, enemyId);
    if (!enemyCard) continue;
    for (const ourId of our) {
      const ourCard = getWikiCard(catalog, ourId);
      if (!ourCard) continue;
      const weCounterThem =
        ourCard.counters.some((c) => c === enemyId || enemyCard.counteredBy.includes(c)) ||
        enemyCard.counteredBy.includes(ourId);
      const theyCounterUs =
        enemyCard.counters.includes(ourId) || ourCard.counteredBy.includes(enemyId);
      if (weCounterThem) {
        cross.push(
          `- vs ${enemyCard.name}: prefer ${ourCard.name} (${ourCard.tips[0] ?? "good answer"})`,
        );
      } else if (theyCounterUs) {
        cross.push(
          `- CAUTION: ${enemyCard.name} beats ${ourCard.name} — do not overcommit that card`,
        );
      }
    }
  }

  if (blocks.length === 0 && cross.length === 0) {
    return "(No wiki entries loaded for current cards.)";
  }

  return [
    "=== CARD WIKI (dynamic slice) ===",
    ...blocks,
    cross.length ? "Matchup tips:" : "",
    ...cross.slice(0, 12),
    missing.length
      ? `Missing wiki ids (add later): ${missing.join(", ")}`
      : "",
    "=== END CARD WIKI ===",
  ]
    .filter(Boolean)
    .join("\n");
}

export type { CardWiki, WikiCard } from "./schema.js";
