import { zodTextFormat } from "openai/helpers/zod";
import { config } from "../config.js";
import { getOpenAIClient } from "../openaiClient.js";
import {
  debriefOutputSchema,
  type BattleReport,
  type DebriefOutput,
} from "./schema.js";
import type { BattleSession } from "./session.js";
import {
  fingerprint,
  normalizeCardId,
  saveBattleReport,
  upsertMatchupFromReport,
} from "./store.js";

/**
 * Post-battle async debrief: summarize enemy style + counter strategy, persist.
 */
export async function runBattleDebrief(
  session: BattleSession,
): Promise<BattleReport | null> {
  if (!session.startedAt) return null;

  const endedAt = new Date().toISOString();
  const id = endedAt.replace(/[:.]/g, "-");
  const summary = session.toDebriefSummary();

  let parsed: DebriefOutput;
  try {
    parsed = await callDebriefModel(summary, session.lastDataUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[memory] debrief failed: ${message}`);
    parsed = {
      result: "unknown",
      enemyCards: session.enemyCards,
      enemyStyle: "Debrief failed; raw cards only.",
      ourStrategy: "",
      keyLessons: [],
      notablePlays: [],
    };
  }

  const enemyCards = [
    ...new Set(
      [...session.enemyCards, ...parsed.enemyCards]
        .map(normalizeCardId)
        .filter(Boolean),
    ),
  ].sort();

  const report: BattleReport = {
    id,
    startedAt: session.startedAt,
    endedAt,
    result: parsed.result,
    ourDeckArchetype: session.ourDeckArchetype,
    enemyCards,
    enemyFingerprint: fingerprint(enemyCards),
    enemyStyle: parsed.enemyStyle,
    ourStrategy: parsed.ourStrategy,
    keyLessons: parsed.keyLessons,
    notablePlays: parsed.notablePlays,
  };

  const battlePath = await saveBattleReport(report);
  const matchup = await upsertMatchupFromReport(report);

  console.log(
    `[memory] saved battle ${report.id} result=${report.result} ` +
      `enemy=[${enemyCards.join(",")}] matchup=${matchup.fingerprint} ` +
      `(${matchup.wins}W-${matchup.losses}L) → ${battlePath}`,
  );

  return report;
}

async function callDebriefModel(
  summary: Record<string, unknown>,
  dataUrl: string | null,
): Promise<DebriefOutput> {
  const content: Array<
    | { type: "input_text"; text: string }
    | { type: "input_image"; image_url: string; detail: "high" | "low" }
  > = [
    {
      type: "input_text",
      text: [
        "You are a Clash Royale coach reviewing a finished battle.",
        "From the session log (and optional final screenshot), extract:",
        "- result: win / loss / unknown (use unknown if unclear)",
        "- enemyCards: card names/ids you can infer the opponent used",
        "- enemyStyle: how they play (cycle, beatdown, bait, bridge spam, etc.)",
        "- ourStrategy: what we should do next time vs this deck",
        "- keyLessons: short actionable bullets",
        "- notablePlays: important moments",
        "",
        "Session JSON:",
        JSON.stringify(summary, null, 2),
      ].join("\n"),
    },
  ];

  if (dataUrl) {
    content.push({
      type: "input_image",
      image_url: dataUrl,
      detail: "high",
    });
  }

  const response = await getOpenAIClient().responses.parse({
    model: config.PLANNER_MODEL,
    input: [
      {
        role: "user",
        content,
      },
    ],
    text: {
      format: zodTextFormat(debriefOutputSchema, "battle_debrief"),
    },
  });

  const parsed = response.output_parsed;
  if (!parsed) {
    return debriefOutputSchema.parse({});
  }
  return debriefOutputSchema.parse(parsed);
}
