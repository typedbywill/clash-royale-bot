import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import {
  battleReportSchema,
  matchupMemorySchema,
  type BattleReport,
  type MatchupMemory,
} from "./schema.js";

const MAX_LESSONS = 12;
const OVERLAP_MIN = 4;

function memoryRoot(): string {
  return path.resolve(process.cwd(), config.MEMORY_DIR);
}

function battlesDir(): string {
  return path.join(memoryRoot(), "battles");
}

function matchupsDir(): string {
  return path.join(memoryRoot(), "matchups");
}

export function normalizeCardId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Sorted unique card ids joined by `_`. */
export function fingerprint(cards: string[]): string {
  const unique = [
    ...new Set(
      cards.map(normalizeCardId).filter((id) => id.length > 0),
    ),
  ].sort();
  return unique.length > 0 ? unique.join("_") : "unknown";
}

export function cardOverlap(a: string[], b: string[]): number {
  const setB = new Set(b.map(normalizeCardId));
  return a.map(normalizeCardId).filter((id) => setB.has(id)).length;
}

async function ensureDirs(): Promise<void> {
  await mkdir(battlesDir(), { recursive: true });
  await mkdir(matchupsDir(), { recursive: true });
}

function safeFilename(fingerprintKey: string): string {
  const safe = fingerprintKey.replace(/[^a-z0-9_]+/gi, "_").slice(0, 180);
  return safe || "unknown";
}

export async function saveBattleReport(report: BattleReport): Promise<string> {
  await ensureDirs();
  const parsed = battleReportSchema.parse(report);
  const file = path.join(battlesDir(), `${parsed.id}.json`);
  await writeFile(file, JSON.stringify(parsed, null, 2), "utf8");
  return file;
}

export async function loadMatchup(
  fingerprintKey: string,
): Promise<MatchupMemory | null> {
  await ensureDirs();
  const file = path.join(matchupsDir(), `${safeFilename(fingerprintKey)}.json`);
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    return matchupMemorySchema.parse(raw);
  } catch {
    return null;
  }
}

export async function listMatchups(): Promise<MatchupMemory[]> {
  await ensureDirs();
  const files = await readdir(matchupsDir());
  const out: MatchupMemory[] = [];
  for (const name of files) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(
        await readFile(path.join(matchupsDir(), name), "utf8"),
      );
      out.push(matchupMemorySchema.parse(raw));
    } catch {
      // skip corrupt
    }
  }
  return out;
}

/**
 * Find best matchup for a partial enemy deck.
 * Exact fingerprint first; else highest overlap ≥ OVERLAP_MIN.
 */
export async function findMatchupForCards(
  enemyCards: string[],
): Promise<MatchupMemory | null> {
  const normalized = [
    ...new Set(enemyCards.map(normalizeCardId).filter(Boolean)),
  ];
  if (normalized.length === 0) return null;

  const exactKey = fingerprint(normalized);
  const exact = await loadMatchup(exactKey);
  if (exact) return exact;

  const all = await listMatchups();
  let best: MatchupMemory | null = null;
  let bestScore = 0;
  for (const m of all) {
    const score = cardOverlap(normalized, m.enemyCards);
    if (score >= OVERLAP_MIN && score > bestScore) {
      best = m;
      bestScore = score;
    }
  }
  return best;
}

export function formatMatchupForPlanner(m: MatchupMemory): string {
  return [
    `Known matchup vs [${m.enemyCards.join(", ")}] (fp=${m.fingerprint})`,
    `Record: ${m.wins}W-${m.losses}L in ${m.gamesPlayed} games`,
    `Enemy style: ${m.styleSummary || "n/a"}`,
    `Counter strategy: ${m.counterStrategy || "n/a"}`,
    "Lessons:",
    ...(m.lessons.length
      ? m.lessons.slice(-8).map((l) => `- ${l}`)
      : ["- (none yet)"]),
  ].join("\n");
}

export async function upsertMatchupFromReport(
  report: BattleReport,
): Promise<MatchupMemory> {
  await ensureDirs();
  const cards = [
    ...new Set(report.enemyCards.map(normalizeCardId).filter(Boolean)),
  ].sort();
  const fp = report.enemyFingerprint || fingerprint(cards);

  // Prefer merging into an existing overlapping matchup when deck is incomplete.
  let existing = await loadMatchup(fp);
  if (!existing && cards.length < 8) {
    existing = await findMatchupForCards(cards);
  }

  const now = new Date().toISOString();
  const mergedCards = [
    ...new Set([...(existing?.enemyCards ?? []), ...cards].map(normalizeCardId)),
  ]
    .filter(Boolean)
    .sort();

  const lessons = [
    ...(existing?.lessons ?? []),
    ...report.keyLessons,
  ].slice(-MAX_LESSONS);

  const wins =
    (existing?.wins ?? 0) + (report.result === "win" ? 1 : 0);
  const losses =
    (existing?.losses ?? 0) + (report.result === "loss" ? 1 : 0);

  const next: MatchupMemory = matchupMemorySchema.parse({
    fingerprint: existing?.fingerprint ?? fp,
    enemyCards: mergedCards,
    gamesPlayed: (existing?.gamesPlayed ?? 0) + 1,
    wins,
    losses,
    styleSummary: report.enemyStyle || existing?.styleSummary || "",
    counterStrategy: report.ourStrategy || existing?.counterStrategy || "",
    lessons,
    updatedAt: now,
  });

  // If we merged into a different fingerprint file, write under that key;
  // also rewrite under the fuller fingerprint when deck grew.
  const primaryKey = next.fingerprint;
  const file = path.join(matchupsDir(), `${safeFilename(primaryKey)}.json`);
  await writeFile(file, JSON.stringify(next, null, 2), "utf8");

  const fullerFp = fingerprint(mergedCards);
  if (fullerFp !== primaryKey && mergedCards.length >= cards.length) {
    const fuller: MatchupMemory = { ...next, fingerprint: fullerFp };
    const fullerFile = path.join(
      matchupsDir(),
      `${safeFilename(fullerFp)}.json`,
    );
    await writeFile(file, JSON.stringify(next, null, 2), "utf8");
    await writeFile(fullerFile, JSON.stringify(fuller, null, 2), "utf8");
    return fuller;
  }

  return next;
}
