import {
  bridgeTileForLane,
  coarseCellToTile,
  frontPrincessForLane,
  leadSpellAim,
  resolveShortcut,
  validatePlacement,
  type Tile,
} from "./arena.js";
import { config } from "./config.js";
import { getCard, type Deck } from "./deck/index.js";
import type { BattlePlan, PlanStep, Planner } from "./planner.js";
import type { GameState } from "./state/gameState.js";

export type ExecutedAction = {
  kind: "play" | "wait";
  reason: string;
  cardId?: string;
  slotIndex?: number;
  tile?: Tile;
  source: "plan" | "reactive" | "cycle" | "none";
  adjusted?: boolean;
};

function towersFromState(state: GameState) {
  return {
    enemyLeftDestroyed: state.enemyTowerDestroyedLeft,
    enemyRightDestroyed: state.enemyTowerDestroyedRight,
  };
}

function triggerReady(
  step: PlanStep,
  state: GameState,
  plan: BattlePlan,
  nowMs: number,
): boolean {
  switch (step.trigger.kind) {
    case "now":
      return true;
    case "elixir_at_least":
      return state.elixir + 1e-6 >= step.trigger.value;
    case "enemy_crosses_bridge": {
      const threat =
        step.trigger.lane === "left" ? state.threatLeft : state.threatRight;
      const push = state.enemyPushCell
        ? coarseCellToTile(state.enemyPushCell)
        : null;
      // Coarse rows 3–4 are near the river on a 8-row grid.
      const nearBridge =
        push != null && push.y >= 12 && push.y <= 18;
      return threat >= 4 || nearBridge;
    }
    case "after_ms":
      return nowMs - plan.createdAtMs >= step.trigger.ms;
    default:
      return false;
  }
}

function aimForSpell(cardId: string, state: GameState): Tile | null {
  const card = getCard(state.deck, cardId);
  if (!card || card.type !== "spell") return null;

  const cluster = state.enemyClusterCell
    ? coarseCellToTile(state.enemyClusterCell)
    : state.enemyPushCell
      ? coarseCellToTile(state.enemyPushCell)
      : null;
  if (!cluster) return null;

  const travelMs = card.travelMs ?? 800;
  return leadSpellAim(cluster, travelMs);
}

function spellHasValue(cardId: string, state: GameState): boolean {
  const card = getCard(state.deck, cardId);
  if (!card || card.type !== "spell") return true;
  const minValue = card.minValueElixir ?? card.elixir;
  // Heuristic: threat scores approximate elixir on board in that lane.
  const threatValue = Math.max(state.threatLeft, state.threatRight);
  const hasCluster = !!state.enemyClusterCell;
  // Tower chip allowed in overtime with medium threat
  if (state.phase === "overtime" && threatValue >= 2) return true;
  return hasCluster && threatValue + (hasCluster ? 2 : 0) >= minValue;
}

function placeForReactive(
  place: string,
  state: GameState,
  lane: "left" | "right",
): Tile {
  switch (place) {
    case "on_cluster": {
      const cluster = state.enemyClusterCell
        ? coarseCellToTile(state.enemyClusterCell)
        : null;
      if (cluster) return cluster;
      return frontPrincessForLane(lane);
    }
    case "behind_king":
      return resolveShortcut("behind_king") ?? { x: 9, y: 27 };
    case "opposite_bridge":
      return bridgeTileForLane(lane === "left" ? "right" : "left");
    case "same_lane_bridge":
      return bridgeTileForLane(lane);
    case "kite_back":
      return resolveShortcut("kite_back") ?? { x: 9, y: 25 };
    case "in_front_of_threatened_tower":
    default:
      return frontPrincessForLane(lane);
  }
}

function tryPlanStep(
  state: GameState,
  planner: Planner,
  nowMs: number,
): ExecutedAction | null {
  const plan = planner.plan;
  if (!plan || planner.isExpired(nowMs)) return null;

  for (let i = 0; i < plan.steps.length; i++) {
    if (plan.completedStepIndexes.includes(i)) continue;
    const step = plan.steps[i]!;
    if (!triggerReady(step, state, plan, nowMs)) {
      // Sequential: wait for this trigger before later steps.
      return {
        kind: "wait",
        reason: `plan_wait_trigger:${step.trigger.kind}:${step.card}`,
        source: "plan",
      };
    }
    if (!state.canAfford(step.card)) {
      return {
        kind: "wait",
        reason: `plan_wait_elixir:${step.card}`,
        source: "plan",
      };
    }
    const slotIndex = state.findSlotForCard(step.card);
    if (slotIndex == null) {
      // Card not in hand yet — wait/cycle
      return {
        kind: "wait",
        reason: `plan_card_not_in_hand:${step.card}`,
        source: "plan",
      };
    }

    const card = getCard(state.deck, step.card);
    if (!card) continue;

    let tile = step.tile;
    if (card.type === "spell") {
      if (!spellHasValue(step.card, state)) {
        planner.markStepDone(i);
        continue;
      }
      const aimed = aimForSpell(step.card, state);
      if (aimed) tile = aimed;
    }

    // neverAlone (Sparky): snap unsafe bridge pushes back behind the king.
    if (isUnsafeNeverAlonePush(step.card, tile, state.deck)) {
      tile = resolveShortcut("behind_king") ?? { x: 9, y: 27 };
    }

    const validated = validatePlacement(
      tile,
      card.type,
      towersFromState(state),
    );

    planner.markStepDone(i);
    return {
      kind: "play",
      reason: `plan:${plan.intent}:${step.card}`,
      cardId: step.card,
      slotIndex,
      tile: validated.tile,
      source: "plan",
      adjusted: validated.adjusted,
    };
  }

  return null;
}

function tryReactive(state: GameState, deck: Deck): ExecutedAction | null {
  const lane = state.threatenedLane();
  if (lane === "none") return null;

  const threat =
    lane === "left" ? state.threatLeft : state.threatRight;
  if (threat < config.REACTIVE_THREAT_THRESHOLD) return null;

  // Infer threat category from context (coarse).
  const categories: Array<(typeof deck.reactiveCounters)[number]["threat"]> = [
    "any_push",
    "win_condition",
    "tank",
    "swarm",
    "air_troop",
  ];

  for (const category of categories) {
    const counters = deck.reactiveCounters.filter(
      (c) => c.threat === category && threat >= (c.minThreat ?? 5),
    );
    for (const counter of counters) {
      for (const cardId of counter.use) {
        if (!state.canAfford(cardId)) continue;
        const slotIndex = state.findSlotForCard(cardId);
        if (slotIndex == null) continue;
        const card = getCard(deck, cardId);
        if (!card) continue;

        let tile = placeForReactive(counter.place, state, lane);
        if (card.type === "spell") {
          if (!spellHasValue(cardId, state)) continue;
          const aimed = aimForSpell(cardId, state);
          if (aimed) tile = aimed;
        }

        const validated = validatePlacement(
          tile,
          card.type,
          towersFromState(state),
        );
        return {
          kind: "play",
          reason: `reactive:${category}:${cardId}`,
          cardId,
          slotIndex,
          tile: validated.tile,
          source: "reactive",
          adjusted: validated.adjusted,
        };
      }
    }
  }

  return null;
}

/**
 * When the board is calm: farm with Elixir Collector behind the king.
 * Priority in single elixir / early battle (at least one pump).
 */
function tryElixirPump(state: GameState, deck: Deck): ExecutedAction | null {
  const pump = deck.cards.find((c) => c.id === "elixir_collector");
  if (!pump) return null;

  const threatMax = Math.max(state.threatLeft, state.threatRight);
  if (threatMax >= 3) return null;
  if (!state.canAfford(pump.id)) return null;

  const slotIndex = state.findSlotForCard(pump.id);
  if (slotIndex == null) return null;

  // Prefer early pump; later only if very calm and we have spare elixir.
  const early = state.battleElapsedMs < 90_000 || state.phase === "single_elixir";
  if (!early && state.elixir < 8) return null;

  const preferred =
    (pump.preferredTiles[0] && resolveShortcut(pump.preferredTiles[0])) ||
    resolveShortcut("behind_king") ||
    { x: 9, y: 27 };

  const validated = validatePlacement(
    preferred,
    pump.type,
    towersFromState(state),
  );
  return {
    kind: "play",
    reason: early ? "pump_early" : "pump_calm",
    cardId: pump.id,
    slotIndex,
    tile: validated.tile,
    source: "cycle",
    adjusted: validated.adjusted,
  };
}

/**
 * Soft cycle: if elixir is high and no threats, play cheapest cycle card
 * on a safe tile so we don't leak elixir at 10.
 */
function tryCycle(state: GameState, deck: Deck): ExecutedAction | null {
  if (state.elixir < 9) return null;
  if (Math.max(state.threatLeft, state.threatRight) >= 4) return null;

  const cycleCards = deck.cards
    .filter(
      (c) =>
        c.id !== "elixir_collector" &&
        (c.roles.includes("cycle") || c.elixir <= 2),
    )
    .sort((a, b) => a.elixir - b.elixir);

  for (const card of cycleCards) {
    if (!state.canAfford(card.id)) continue;
    const slotIndex = state.findSlotForCard(card.id);
    if (slotIndex == null) continue;
    if (card.type === "spell") continue;
    if (card.neverAlone) continue;

    const preferred =
      (card.preferredTiles[0] && resolveShortcut(card.preferredTiles[0])) ||
      resolveShortcut("behind_king") ||
      { x: 9, y: 27 };
    const validated = validatePlacement(
      preferred,
      card.type,
      towersFromState(state),
    );
    return {
      kind: "play",
      reason: `cycle_leak:${card.id}`,
      cardId: card.id,
      slotIndex,
      tile: validated.tile,
      source: "cycle",
      adjusted: validated.adjusted,
    };
  }

  return null;
}

/** Sparky (neverAlone) must not be sent alone near/over the bridge. */
function isUnsafeNeverAlonePush(cardId: string, tile: Tile, deck: Deck): boolean {
  const card = getCard(deck, cardId);
  if (!card?.neverAlone) return false;
  // Safe charge zone: deep our side (behind king / mid defense).
  return tile.y <= 20;
}

/**
 * Decide the next action for this tick (does not send ADB).
 */
export function decideExecution(
  state: GameState,
  planner: Planner,
  nowMs: number = Date.now(),
): ExecutedAction {
  if (!state.isInBattle) {
    return { kind: "wait", reason: "not_in_battle", source: "none" };
  }

  // 1) Urgent reactive defense overrides stale plans when threat is high.
  const threatMax = Math.max(state.threatLeft, state.threatRight);
  if (threatMax >= config.REACTIVE_THREAT_THRESHOLD + 1) {
    const reactiveFirst = tryReactive(state, state.deck);
    if (reactiveFirst?.kind === "play") return reactiveFirst;
  }

  // 2) Follow plan
  const fromPlan = tryPlanStep(state, planner, nowMs);
  if (fromPlan) {
    if (fromPlan.kind === "play") return fromPlan;
    // Plan says wait — still allow reactive if threat rising
    if (threatMax >= config.REACTIVE_THREAT_THRESHOLD) {
      const reactive = tryReactive(state, state.deck);
      if (reactive?.kind === "play") return reactive;
    }
    return fromPlan;
  }

  // 3) Reactive fallback when no plan
  const reactive = tryReactive(state, state.deck);
  if (reactive) return reactive;

  // 4) Calm board → Elixir Collector (core of this deck's early game)
  const pump = tryElixirPump(state, state.deck);
  if (pump) return pump;

  // 5) Don't leak elixir
  const cycle = tryCycle(state, state.deck);
  if (cycle) return cycle;

  return { kind: "wait", reason: "no_action", source: "none" };
}
