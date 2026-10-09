import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { ARENA_COLS, ARENA_ROWS } from "./arena.js";
import { config } from "./config.js";
import { deckSummary, type Deck } from "./deck/index.js";
import {
  findMatchupForCards,
  formatMatchupForPlanner,
  type MatchupMemory,
} from "./memory/index.js";
import { getOpenAIClient } from "./openaiClient.js";
import type { GameState } from "./state/gameState.js";

const triggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("now") }),
  z.object({
    kind: z.literal("elixir_at_least"),
    value: z.number().min(0).max(10),
  }),
  z.object({
    kind: z.literal("enemy_crosses_bridge"),
    lane: z.enum(["left", "right"]),
  }),
  z.object({
    kind: z.literal("after_ms"),
    ms: z.number().int().nonnegative(),
  }),
]);

const planStepSchema = z.object({
  card: z.string().min(1),
  tile: z.object({
    x: z.number().int().min(0).max(ARENA_COLS - 1),
    y: z.number().int().min(0).max(ARENA_ROWS - 1),
  }),
  trigger: triggerSchema,
});

export const battlePlanSchema = z.object({
  intent: z.enum([
    "defend",
    "counterpush",
    "attack",
    "cycle",
    "save_elixir",
  ]),
  enemyCardsSeen: z.array(z.string()).default([]),
  steps: z.array(planStepSchema).max(6),
  expiresInMs: z.number().int().positive().default(8000),
  note: z.string().default(""),
});

export type PlanTrigger = z.infer<typeof triggerSchema>;
export type PlanStep = z.infer<typeof planStepSchema>;
export type BattlePlan = z.infer<typeof battlePlanSchema> & {
  createdAtMs: number;
  expiresAtMs: number;
  /** Steps already executed (indices). */
  completedStepIndexes: number[];
};

export type PlannerEvents = {
  newPush: boolean;
  towerDamaged: boolean;
  phaseChanged: boolean;
  planCompleted: boolean;
};

export class Planner {
  private deck: Deck;
  private current: BattlePlan | null = null;
  private inFlight: Promise<void> | null = null;
  private lastPlanAtMs = 0;
  private lastPhase: string | null = null;
  private lastThreatMax = 0;
  /** Injected matchup memory for the current opponent. */
  private matchup: MatchupMemory | null = null;
  private onPlanCreated: ((plan: BattlePlan) => void) | null = null;

  constructor(deck: Deck) {
    this.deck = deck;
  }

  get plan(): BattlePlan | null {
    return this.current;
  }

  setMatchup(matchup: MatchupMemory | null): void {
    this.matchup = matchup;
  }

  setOnPlanCreated(cb: ((plan: BattlePlan) => void) | null): void {
    this.onPlanCreated = cb;
  }

  isExpired(nowMs: number = Date.now()): boolean {
    if (!this.current) return true;
    return nowMs >= this.current.expiresAtMs;
  }

  markStepDone(index: number): void {
    if (!this.current) return;
    if (!this.current.completedStepIndexes.includes(index)) {
      this.current.completedStepIndexes.push(index);
    }
  }

  shouldReplan(state: GameState, events: PlannerEvents, nowMs = Date.now()): boolean {
    if (this.inFlight) return false;
    if (!this.current || this.isExpired(nowMs)) return true;
    if (events.planCompleted) return true;
    if (events.phaseChanged) return true;
    if (events.towerDamaged) return true;
    if (events.newPush) return true;
    if (nowMs - this.lastPlanAtMs >= config.PLANNER_INTERVAL_MS) return true;

    // Threat spike
    const threatMax = Math.max(state.threatLeft, state.threatRight);
    if (threatMax >= 6 && threatMax > this.lastThreatMax + 2) return true;

    return false;
  }

  detectEvents(state: GameState): PlannerEvents {
    const phaseChanged =
      this.lastPhase != null && this.lastPhase !== state.phase;
    this.lastPhase = state.phase;

    const threatMax = Math.max(state.threatLeft, state.threatRight);
    const newPush =
      threatMax >= 5 &&
      (state.threatLeft >= 5 || state.threatRight >= 5) &&
      threatMax > this.lastThreatMax;
    this.lastThreatMax = Math.max(this.lastThreatMax * 0.9, threatMax);

    const towerDamaged =
      state.ourTowerDamagedLeft || state.ourTowerDamagedRight;

    const planCompleted =
      !!this.current &&
      this.current.steps.length > 0 &&
      this.current.completedStepIndexes.length >= this.current.steps.length;

    return { newPush, towerDamaged, phaseChanged, planCompleted };
  }

  /**
   * Fire-and-forget replan. Never blocks the battle tick.
   */
  kickoff(
    dataUrl: string,
    state: GameState,
    events: PlannerEvents,
    nowMs = Date.now(),
  ): void {
    if (!this.shouldReplan(state, events, nowMs)) return;
    if (this.inFlight) return;

    this.inFlight = this.runPlan(dataUrl, state, nowMs)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[planner] error: ${message}`);
      })
      .finally(() => {
        this.inFlight = null;
      });
  }

  private async runPlan(
    dataUrl: string,
    state: GameState,
    nowMs: number,
  ): Promise<void> {
    const started = performance.now();
    const cardIds = this.deck.cards.map((c) => c.id).join(", ");
    const previous = this.current
      ? JSON.stringify({
          intent: this.current.intent,
          steps: this.current.steps,
          note: this.current.note,
          completed: this.current.completedStepIndexes,
        })
      : "none";

    // Refresh matchup from cards seen so far if we don't have one yet.
    if (!this.matchup && state.enemyCardsSeen.length >= 4) {
      try {
        this.matchup = await findMatchupForCards(state.enemyCardsSeen);
      } catch {
        // ignore store errors mid-battle
      }
    }

    const matchupBlock = this.matchup
      ? [
          "",
          "=== PERSISTENT MATCHUP MEMORY (from past battles) ===",
          formatMatchupForPlanner(this.matchup),
          "Use this memory: adapt defense/offense to their known style.",
          "=== END MATCHUP MEMORY ===",
          "",
        ].join("\n")
      : "\n(No prior matchup memory for this opponent yet.)\n";

    const response = await getOpenAIClient().responses.parse({
      model: config.PLANNER_MODEL,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: [
                "You are a professional Clash Royale coach/player.",
                "Produce a short tactical PLAN for the next few seconds.",
                `Arena grid is ${ARENA_COLS} cols × ${ARENA_ROWS} rows. (0,0)=enemy top-left; our side is rows ${16}–${ARENA_ROWS - 1}.`,
                "Troops/buildings: only place on our side (or enemy pocket if that princess is destroyed).",
                "Spells may target anywhere; lead moving clusters toward our towers.",
                "Only use cards from the deck. Prefer 1–3 steps. Use triggers so the executor can wait for elixir/bridge crossings.",
                "Defend first if a lane threat is high. Then counter-push.",
                "When matchup memory is provided, prioritize its counterStrategy and lessons.",
                "DECK RULES (critical):",
                "1) When calm early, plan elixir_collector behind the king (y≈26–28).",
                "2) Combo: sparky BEHIND king first (y≈26–28), then giant IN FRONT of sparky (bridge y≈15–18) BEFORE sparky reaches the bridge. Never send sparky alone across.",
                "3) Support behind the tank with princess / ice_wizard / mega_minion when elixir allows.",
                "4) Defense priority: ice_wizard, mega_minion, princess, barbarians; sparky vs heavy tanks.",
                "5) Cards marked neverAlone must not be placed near the bridge without a tank step first.",
              ].join(" "),
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                deckSummary(this.deck),
                "",
                `Valid card ids: ${cardIds}`,
                matchupBlock,
                "Current game state JSON:",
                JSON.stringify(state.toPlannerSummary(), null, 2),
                "",
                `Previous plan: ${previous}`,
                "",
                "Return a fresh plan with tile coordinates and triggers.",
                "Also list any enemy cards you can identify in enemyCardsSeen.",
              ].join("\n"),
            },
            {
              type: "input_image",
              image_url: dataUrl,
              detail: "high",
            },
          ],
        },
      ],
      text: {
        format: zodTextFormat(battlePlanSchema, "battle_plan"),
      },
    });

    const parsed = response.output_parsed;
    if (!parsed) {
      console.warn("[planner] no parsed output");
      return;
    }

    const validIds = new Set(this.deck.cards.map((c) => c.id));
    const steps = parsed.steps.filter((step) => validIds.has(step.card));

    this.current = {
      ...parsed,
      steps,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + parsed.expiresInMs,
      completedStepIndexes: [],
    };
    this.lastPlanAtMs = nowMs;

    if (parsed.enemyCardsSeen?.length) {
      state.noteEnemyCards(parsed.enemyCardsSeen);
    }

    this.onPlanCreated?.(this.current);

    const ms = Math.round(performance.now() - started);
    console.log(
      `[planner] intent=${this.current.intent} steps=${steps.length} expiresInMs=${parsed.expiresInMs} ms=${ms} note=${JSON.stringify(parsed.note)}`,
    );
  }
}
