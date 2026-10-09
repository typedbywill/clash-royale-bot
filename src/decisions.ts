import OpenAI from "openai";
import type { Decision, DecisionCreateParams } from "openai/resources/decisions";
import { assertOpenAIKey, config } from "./config.js";
import {
  CARD_SLOTS,
  DEFAULT_FALLBACK_ZONE,
  PLACEMENT_ZONES,
  WAIT_ACTION,
  type ActionName,
  type CardSlotName,
  type PlacementZoneName,
} from "./layout.js";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  assertOpenAIKey();
  if (!client) {
    client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  }
  return client;
}

const IN_BATTLE_THRESHOLD = 0.55;

export type ActionDecision = {
  /** Action after confidence / in_battle gates */
  action: ActionName;
  /** Raw choice returned by the model (before gates) */
  rawChoice: ActionName | null;
  confidence: number;
  /** Probability mass on the chosen option */
  choiceProbability: number;
  inBattleProbability: number;
  inBattle: boolean;
  elixirScore: number | null;
  elixirConfidence: number | null;
  refused: boolean;
  raw: Decision;
  latencyMs: number;
};

export type PlacementDecision = {
  zone: PlacementZoneName;
  /** Raw zone from the model before gates */
  rawZone: PlacementZoneName | null;
  confidence: number;
  choiceProbability: number;
  usedFallback: boolean;
  cancelled: boolean;
  refused: boolean;
  raw: Decision;
  latencyMs: number;
};

function imageInput(dataUrl: string, text: string): DecisionCreateParams["input"] {
  return [
    {
      role: "user",
      content: [
        { type: "input_text", text },
        { type: "input_image", image_url: dataUrl, detail: "low" },
      ],
    },
  ];
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

function asActionName(value: string | boolean): ActionName | null {
  if (typeof value !== "string") return null;
  if (value === WAIT_ACTION.name) return WAIT_ACTION.name;
  if (CARD_SLOTS.some((slot) => slot.name === value)) {
    return value as CardSlotName;
  }
  return null;
}

function asZoneName(value: string | boolean): PlacementZoneName | null {
  if (typeof value !== "string") return null;
  if (PLACEMENT_ZONES.some((zone) => zone.name === value)) {
    return value as PlacementZoneName;
  }
  return null;
}

/**
 * First Decisions call: pick wait / card_1..card_4, plus in_battle + elixir.
 */
export async function decideAction(dataUrl: string): Promise<ActionDecision> {
  const started = performance.now();

  const decision = await getClient().decisions.create({
    model: config.DECISIONS_MODEL,
    input: imageInput(
      dataUrl,
      [
        "You are playing Clash Royale aggressively. This is a live battle screenshot.",
        "Look at the hand (4 cards at the bottom — greyed cards cost more than current elixir), elixir bar, and both sides of the arena.",
        "Default to playing a card when you have enough elixir. Defend immediately if enemy troops threaten our towers.",
      ].join(" "),
    ),
    questions: [
      {
        type: "choice",
        name: "action",
        instructions:
          "Pick the best action NOW. Prefer launching an affordable card (not greyed out) to defend threats or start a push. Choose wait ONLY if elixir is too low for every useful card or playing would be a clear misplay.",
        choices: [
          {
            value: WAIT_ACTION.name,
            description: WAIT_ACTION.description,
          },
          ...CARD_SLOTS.map((slot) => ({
            value: slot.name,
            description: slot.description,
          })),
        ],
      },
      {
        type: "predicate",
        name: "in_battle",
        instructions:
          "Does this screenshot show an active Clash Royale battle (arena with towers, river, and card hand visible)? Answer no for menus, matchmaking, victory/defeat screens, or shop.",
      },
      {
        type: "score",
        name: "elixir",
        instructions:
          "Estimate the player's current elixir from the elixir bar at the bottom of the screen.",
        // Decisions API allows at most 10 score levels (elixir is 0..10 in-game).
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
    ],
  });

  const latencyMs = Math.round(performance.now() - started);

  if (isRefusal(decision, "action")) {
    return {
      action: WAIT_ACTION.name,
      rawChoice: null,
      confidence: 0,
      choiceProbability: 0,
      inBattleProbability: 0,
      inBattle: false,
      elixirScore: null,
      elixirConfidence: null,
      refused: true,
      raw: decision,
      latencyMs,
    };
  }

  const actionAnswer = findAnswer(decision, "action", "choice");
  const inBattleAnswer = findAnswer(decision, "in_battle", "predicate");
  const elixirAnswer = findAnswer(decision, "elixir", "score");

  const inBattleProbability = inBattleAnswer?.probability ?? 0;
  const inBattle = inBattleProbability >= IN_BATTLE_THRESHOLD;

  let action: ActionName = WAIT_ACTION.name;
  let rawChoice: ActionName | null = null;
  let confidence = 0;
  let choiceProbability = 0;

  if (actionAnswer) {
    confidence = actionAnswer.confidence;
    rawChoice = asActionName(actionAnswer.choice);
    const matched = actionAnswer.probabilities.find(
      (p) => p.value === actionAnswer.choice,
    );
    choiceProbability = matched?.probability ?? 0;

    // Gate on the chosen option's probability (more stable than confidence alone).
    const score = Math.max(confidence, choiceProbability);
    if (rawChoice && score >= config.MIN_ACTION_CONFIDENCE && inBattle) {
      action = rawChoice;
    } else {
      action = WAIT_ACTION.name;
    }
  }

  return {
    action,
    rawChoice,
    confidence,
    choiceProbability,
    inBattleProbability,
    inBattle,
    elixirScore: elixirAnswer?.score ?? null,
    elixirConfidence: elixirAnswer?.confidence ?? null,
    refused: false,
    raw: decision,
    latencyMs,
  };
}

/**
 * Second Decisions call: where to place the chosen card.
 */
export async function decidePlacement(
  dataUrl: string,
  slot: CardSlotName,
): Promise<PlacementDecision> {
  const started = performance.now();
  const slotIndex = CARD_SLOTS.findIndex((s) => s.name === slot) + 1;

  const decision = await getClient().decisions.create({
    model: config.DECISIONS_MODEL,
    input: imageInput(
      dataUrl,
      [
        `You are playing Clash Royale. You will launch the card in hand slot ${slotIndex} (${slot}).`,
        "Our side is the BOTTOM half; enemy is the TOP.",
        "Match the lane: left threats → left_* zones, right threats → right_* zones.",
        "Do NOT default to center unless the fight is truly in the middle.",
        "Enemy tower zones are for spells only.",
      ].join(" "),
    ),
    questions: [
      {
        type: "choice",
        name: "placement",
        instructions:
          "Pick the single best named zone for this card. Defend the threatened lane; avoid dumping everything in the center.",
        choices: PLACEMENT_ZONES.map((zone) => ({
          value: zone.name,
          description: zone.description,
        })),
      },
    ],
  });

  const latencyMs = Math.round(performance.now() - started);

  if (isRefusal(decision, "placement")) {
    return {
      zone: DEFAULT_FALLBACK_ZONE,
      rawZone: null,
      confidence: 0,
      choiceProbability: 0,
      usedFallback: config.LOW_CONFIDENCE_PLACEMENT === "fallback",
      cancelled: config.LOW_CONFIDENCE_PLACEMENT === "cancel",
      refused: true,
      raw: decision,
      latencyMs,
    };
  }

  const placementAnswer = findAnswer(decision, "placement", "choice");
  const confidence = placementAnswer?.confidence ?? 0;
  const rawZone = placementAnswer
    ? asZoneName(placementAnswer.choice)
    : null;
  const matched = placementAnswer?.probabilities.find(
    (p) => p.value === placementAnswer.choice,
  );
  const choiceProbability = matched?.probability ?? 0;
  const score = Math.max(confidence, choiceProbability);

  // Trust the model's zone whenever it returns one. Only cancel/fallback when
  // score is below threshold AND policy says so — never silently remap to center
  // while discarding a valid lane choice (that caused "everything in the middle").
  if (rawZone) {
    if (score < config.MIN_PLACEMENT_CONFIDENCE) {
      if (config.LOW_CONFIDENCE_PLACEMENT === "cancel") {
        return {
          zone: DEFAULT_FALLBACK_ZONE,
          rawZone,
          confidence,
          choiceProbability,
          usedFallback: false,
          cancelled: true,
          refused: false,
          raw: decision,
          latencyMs,
        };
      }
    }

    return {
      zone: rawZone,
      rawZone,
      confidence,
      choiceProbability,
      usedFallback: false,
      cancelled: false,
      refused: false,
      raw: decision,
      latencyMs,
    };
  }

  return {
    zone: DEFAULT_FALLBACK_ZONE,
    rawZone: null,
    confidence,
    choiceProbability,
    usedFallback: true,
    cancelled: false,
    refused: false,
    raw: decision,
    latencyMs,
  };
}
