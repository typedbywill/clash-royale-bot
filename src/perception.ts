import type { Decision, DecisionCreateParams } from "openai/resources/decisions";
import { allCoarseCells } from "./arena.js";
import { cardChoices, type Deck } from "./deck/index.js";
import { config } from "./config.js";
import { getOpenAIClient } from "./openaiClient.js";
import type { BattlePhase, PerceptionSnapshot } from "./state/gameState.js";

const IN_BATTLE_THRESHOLD = 0.55;

function imageInput(
  dataUrl: string,
  text: string,
  detail: "low" | "high" = "high",
): DecisionCreateParams["input"] {
  return [
    {
      role: "user",
      content: [
        { type: "input_text", text },
        { type: "input_image", image_url: dataUrl, detail },
      ],
    },
  ];
}

const MIN_HAND_SLOT_CONFIDENCE = 0.4;

/** Assign at most one slot per card id, preferring higher confidence. */
function dedupeHandSlots(
  hand: Array<string | null>,
  confidence: number[],
): { hand: Array<string | null>; handConfidence: number[] } {
  const ranked = [0, 1, 2, 3]
    .map((i) => ({ i, id: hand[i], conf: confidence[i] ?? 0 }))
    .filter((s) => s.id && s.conf >= MIN_HAND_SLOT_CONFIDENCE)
    .sort((a, b) => b.conf - a.conf);

  const outHand: Array<string | null> = [null, null, null, null];
  const outConf: number[] = [0, 0, 0, 0];
  const used = new Set<string>();
  for (const slot of ranked) {
    const id = slot.id!;
    if (used.has(id)) continue;
    used.add(id);
    outHand[slot.i] = id;
    outConf[slot.i] = slot.conf;
  }
  return { hand: outHand, handConfidence: outConf };
}

function findAnswer<T extends Decision["answers"][number]["type"]>(
  decision: Decision,
  name: string,
  type: T,
): Extract<Decision["answers"][number], { type: T }> | undefined {
  return decision.answers.find(
    (answer): answer is Extract<Decision["answers"][number], { type: T }> =>
      answer.name === name && answer.type === type,
  );
}

function isRefusal(decision: Decision, name: string): boolean {
  return decision.answers.some(
    (answer) => answer.name === name && answer.type === "refusal",
  );
}

function scoreToNumber(scoreAnswer: Decision.AnswerResourceScore | undefined): {
  value: number | null;
  confidence: number | null;
} {
  if (!scoreAnswer) return { value: null, confidence: null };
  return { value: scoreAnswer.score, confidence: scoreAnswer.confidence };
}

function predicateTrue(
  decision: Decision,
  name: string,
  threshold = 0.55,
): boolean {
  if (isRefusal(decision, name)) return false;
  const pred = findAnswer(decision, name, "predicate");
  return (pred?.probability ?? 0) >= threshold;
}

function parsePhase(choice: string | boolean | undefined): BattlePhase {
  if (typeof choice !== "string") return "unknown";
  if (
    choice === "single_elixir" ||
    choice === "double_elixir" ||
    choice === "overtime"
  ) {
    return choice;
  }
  return "unknown";
}

function slotQuestion(
  slot: number,
  deck: Deck,
): DecisionCreateParams.QuestionParamChoice {
  return {
    type: "choice",
    name: `slot_${slot}`,
    instructions: [
      `Which card is in hand slot ${slot} (1=leftmost … 4=rightmost)?`,
      "Look at the card art/name at the bottom of the screen.",
      "Pick the matching card from THIS deck only. If unclear, pick the closest visual match.",
    ].join(" "),
    choices: cardChoices(deck),
  };
}

function threatScoreQuestion(
  name: string,
  lane: string,
): DecisionCreateParams.QuestionParamScore {
  return {
    type: "score",
    name,
    instructions: [
      `Rate enemy pressure on the ${lane} lane from 0 (empty) to 9 (lethal push at/near our tower).`,
      "Count troops/buildings threatening that princess or king from that side.",
    ].join(" "),
    levels: Array.from({ length: 10 }, (_, i) => ({
      label: String(i),
      description:
        i === 0
          ? "No threat"
          : i <= 3
            ? "Light / far"
            : i <= 6
              ? "Medium push"
              : "Heavy / near tower",
    })),
  };
}

/**
 * Single Decisions API call: hand identity, elixir, phase, threats, clusters, towers.
 */
export async function perceiveBattle(
  dataUrl: string,
  deck: Deck,
): Promise<PerceptionSnapshot> {
  const started = performance.now();
  const coarse = allCoarseCells();

  const decision = await getOpenAIClient().decisions.create({
    model: config.DECISIONS_MODEL,
    input: imageInput(
      dataUrl,
      [
        "You are a Clash Royale vision system for a live battle screenshot.",
        "Our side is the BOTTOM half; enemy is the TOP. Hand is 4 cards at the bottom.",
        "Greyed-out cards cost more than current elixir.",
        `Our deck archetype: ${deck.archetype}. Identify which deck cards are in each hand slot.`,
        "Estimate elixir from the bar, threats per lane, and where enemy troops cluster.",
      ].join(" "),
    ),
    questions: [
      {
        type: "predicate",
        name: "in_battle",
        instructions:
          "Does this screenshot show an active Clash Royale battle (arena with towers, river, and card hand visible)? Answer no for menus, matchmaking, victory/defeat screens, or shop.",
      },
      slotQuestion(1, deck),
      slotQuestion(2, deck),
      slotQuestion(3, deck),
      slotQuestion(4, deck),
      {
        type: "score",
        name: "elixir",
        instructions:
          "Estimate the player's current elixir from the elixir bar at the bottom of the screen.",
        levels: [
          ...Array.from({ length: 9 }, (_, i) => ({
            label: String(i),
            description: `About ${i} elixir`,
          })),
          {
            label: "9+",
            description: "About 9 or 10 elixir (near/full bar)",
          },
        ],
      },
      {
        type: "choice",
        name: "phase",
        instructions:
          "Which battle phase? single_elixir (normal), double_elixir (faster elixir / 1:00 or overtime clock with 2x), overtime (sudden death / overtime banner).",
        choices: [
          {
            value: "single_elixir",
            description: "Normal speed elixir (early/mid battle)",
          },
          {
            value: "double_elixir",
            description: "Double elixir active",
          },
          {
            value: "overtime",
            description: "Overtime / sudden death",
          },
          {
            value: "unknown",
            description: "Cannot tell from this frame",
          },
        ],
      },
      threatScoreQuestion("threat_left", "LEFT"),
      threatScoreQuestion("threat_right", "RIGHT"),
      {
        type: "choice",
        name: "enemy_push_cell",
        instructions:
          "Where is the main enemy push / lead troop? Pick a coarse cell (cCOL_rROW) or none.",
        choices: coarse,
      },
      {
        type: "choice",
        name: "enemy_cluster_cell",
        instructions:
          "Best Fireball/Log aim point: densest enemy troop cluster (or tower+troops). Pick coarse cell or none.",
        choices: coarse,
      },
      {
        type: "predicate",
        name: "our_tower_damaged_left",
        instructions:
          "Is our LEFT princess tower damaged (HP bar not full / visibly hurt)?",
      },
      {
        type: "predicate",
        name: "our_tower_damaged_right",
        instructions:
          "Is our RIGHT princess tower damaged (HP bar not full / visibly hurt)?",
      },
      {
        type: "predicate",
        name: "enemy_tower_destroyed_left",
        instructions:
          "Is the ENEMY LEFT princess tower destroyed (gone / king exposed on that side)?",
      },
      {
        type: "predicate",
        name: "enemy_tower_destroyed_right",
        instructions:
          "Is the ENEMY RIGHT princess tower destroyed (gone / king exposed on that side)?",
      },
    ],
  });

  const latencyMs = Math.round(performance.now() - started);

  const inBattleAnswer = findAnswer(decision, "in_battle", "predicate");
  const inBattleProbability = inBattleAnswer?.probability ?? 0;
  const inBattle = inBattleProbability >= IN_BATTLE_THRESHOLD;

  const hand: Array<string | null> = [null, null, null, null];
  const handConfidence: number[] = [0, 0, 0, 0];
  const validIds = new Set(deck.cards.map((c) => c.id));

  for (let slot = 1; slot <= 4; slot++) {
    if (isRefusal(decision, `slot_${slot}`)) continue;
    const answer = findAnswer(decision, `slot_${slot}`, "choice");
    if (!answer) continue;
    const choice = typeof answer.choice === "string" ? answer.choice : null;
    const matched = answer.probabilities.find((p) => p.value === answer.choice);
    const conf = Math.max(answer.confidence, matched?.probability ?? 0);
    if (choice && validIds.has(choice)) {
      hand[slot - 1] = choice;
      handConfidence[slot - 1] = conf;
    }
  }

  const elixirAnswer = findAnswer(decision, "elixir", "score");
  const { value: elixirVisual, confidence: elixirConfidence } =
    scoreToNumber(elixirAnswer);

  const phaseAnswer = findAnswer(decision, "phase", "choice");
  const phase = parsePhase(phaseAnswer?.choice);

  const threatLeft = findAnswer(decision, "threat_left", "score")?.score ?? 0;
  const threatRight = findAnswer(decision, "threat_right", "score")?.score ?? 0;

  const pushAnswer = findAnswer(decision, "enemy_push_cell", "choice");
  const clusterAnswer = findAnswer(decision, "enemy_cluster_cell", "choice");
  const enemyPushCell =
    typeof pushAnswer?.choice === "string" && pushAnswer.choice !== "none"
      ? pushAnswer.choice
      : null;
  const enemyClusterCell =
    typeof clusterAnswer?.choice === "string" &&
    clusterAnswer.choice !== "none"
      ? clusterAnswer.choice
      : null;

  return {
    inBattle,
    inBattleProbability,
    elixirVisual,
    elixirConfidence,
    hand,
    handConfidence,
    phase,
    threatLeft,
    threatRight,
    enemyPushCell,
    enemyClusterCell,
    ourTowerDamagedLeft: predicateTrue(decision, "our_tower_damaged_left"),
    ourTowerDamagedRight: predicateTrue(decision, "our_tower_damaged_right"),
    enemyTowerDestroyedLeft: predicateTrue(
      decision,
      "enemy_tower_destroyed_left",
    ),
    enemyTowerDestroyedRight: predicateTrue(
      decision,
      "enemy_tower_destroyed_right",
    ),
    latencyMs,
  };
}
