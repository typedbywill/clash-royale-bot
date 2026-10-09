import {
  getScreenSize,
  launchCard,
  screencap,
  type ScreenSize,
} from "./adb.js";
import { tileToPixels } from "./arena.js";
import { config } from "./config.js";
import { loadDeck } from "./deck/index.js";
import { logTickJson } from "./debugLog.js";
import { decideExecution } from "./executor.js";
import { prepareScreenshot } from "./image.js";
import { getCardSlot, toPixels } from "./layout.js";
import {
  BattleSession,
  findMatchupForCards,
  runBattleDebrief,
} from "./memory/index.js";
import { perceiveBattle } from "./perception.js";
import { Planner } from "./planner.js";
import { GameState } from "./state/gameState.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logTick(parts: Record<string, string | number | boolean | null>) {
  const stamp = new Date().toISOString();
  const body = Object.entries(parts)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.log(`[${stamp}] ${body}`);
}

export class BattleBot {
  private running = false;
  private screen: ScreenSize | null = null;
  private tick = 0;
  private readonly deck = loadDeck();
  private readonly state = new GameState(this.deck);
  private readonly planner = new Planner(this.deck);
  private readonly session = new BattleSession();
  private wasInBattle = false;
  private debriefInFlight: Promise<void> | null = null;
  private lastEnemyCardCount = 0;

  async start(): Promise<void> {
    this.running = true;
    this.screen = await getScreenSize();

    this.planner.setOnPlanCreated((plan) => {
      if (this.session.active) {
        this.session.notePlan(plan, this.state.battleElapsedMs);
        this.session.noteEnemyCards(plan.enemyCardsSeen ?? []);
      }
    });

    console.log(
      `Battle bot started — screen ${this.screen.width}x${this.screen.height}, ` +
        `loop=${config.BATTLE_LOOP_TOOL_CALL_MS}ms, dryRun=${config.DRY_RUN}, ` +
        `deck=${this.deck.archetype}, planner=${config.PLANNER_MODEL}, ` +
        `screencap=${config.SCREENCAP_FORMAT}, memory=${config.MEMORY_DIR}`,
    );
    console.log(
      `Cards: ${this.deck.cards.map((c) => c.id).join(", ")}`,
    );

    while (this.running) {
      const tickStarted = performance.now();
      try {
        await this.runTick();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[tick ${this.tick}] error: ${message}`);
      }

      const elapsed = Math.round(performance.now() - tickStarted);
      const waitMs = Math.max(0, config.BATTLE_LOOP_TOOL_CALL_MS - elapsed);
      if (waitMs > 0 && this.running) {
        await sleep(waitMs);
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  private async onBattleStart(nowMs: number): Promise<void> {
    this.session.start(this.deck.archetype, nowMs);
    this.lastEnemyCardCount = 0;
    this.planner.setMatchup(null);
    console.log("[memory] battle started — session buffer reset");
  }

  private onBattleEnd(dataUrl: string | null): void {
    if (!this.session.active) return;
    this.session.lastDataUrl = dataUrl;
    this.session.noteEnemyCards(this.state.enemyCardsSeen);
    this.session.end();

    // Snapshot for async debrief (session fields stay readable after end()).
    if (this.debriefInFlight) return;
    const session = this.session;
    this.debriefInFlight = runBattleDebrief(session)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[memory] debrief error: ${message}`);
      })
      .then(() => undefined)
      .finally(() => {
        this.debriefInFlight = null;
      });

    console.log(
      `[memory] battle ended — debrief queued (enemy cards so far: ${session.enemyCards.join(", ") || "none"})`,
    );
  }

  private async refreshMatchupIfNeeded(): Promise<void> {
    const cards = [
      ...new Set([...this.state.enemyCardsSeen, ...this.session.enemyCards]),
    ];
    if (cards.length === this.lastEnemyCardCount && this.session.matchup) {
      return;
    }
    this.lastEnemyCardCount = cards.length;
    if (cards.length < 2) return;

    try {
      const matchup = await findMatchupForCards(cards);
      if (matchup) {
        this.session.matchup = matchup;
        this.planner.setMatchup(matchup);
        if (cards.length >= 4) {
          console.log(
            `[memory] matchup loaded: ${matchup.fingerprint} (${matchup.wins}W-${matchup.losses}L)`,
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[memory] matchup lookup failed: ${message}`);
    }
  }

  private async runTick(): Promise<void> {
    this.tick += 1;
    const tick = this.tick;
    const nowMs = Date.now();

    const shotStarted = performance.now();
    const png = await screencap();
    const shotMs = Math.round(performance.now() - shotStarted);

    const prepared = await prepareScreenshot(png, {
      label: `tick-${tick}`,
    });

    const perception = await perceiveBattle(prepared.dataUrl, this.deck);
    this.state.applyPerception(perception, nowMs);

    const inBattle = this.state.isInBattle;

    if (!this.wasInBattle && inBattle) {
      await this.onBattleStart(nowMs);
    } else if (this.wasInBattle && !inBattle) {
      this.onBattleEnd(prepared.dataUrl);
    }
    this.wasInBattle = inBattle;

    if (!inBattle) {
      logTick({
        tick,
        action: "skip",
        reason: "not_in_battle",
        inBattle: perception.inBattleProbability.toFixed(2),
        shotMs,
        perceptionMs: perception.latencyMs,
      });
      await logTickJson({
        tick,
        action: "skip",
        reason: "not_in_battle",
        perception,
        shotMs,
      });
      return;
    }

    // Keep session warm with live observations
    this.session.lastDataUrl = prepared.dataUrl;
    this.session.noteEnemyCards(this.state.enemyCardsSeen);
    this.session.noteThreat(
      this.state.threatLeft,
      this.state.threatRight,
      this.state.battleElapsedMs,
    );
    await this.refreshMatchupIfNeeded();

    const events = this.planner.detectEvents(this.state);
    this.planner.kickoff(prepared.dataUrl, this.state, events, nowMs);

    const action = decideExecution(this.state, this.planner, nowMs);

    if (action.kind === "wait" || action.cardId == null || action.slotIndex == null || !action.tile) {
      logTick({
        tick,
        action: "wait",
        reason: action.reason,
        source: action.source,
        elixir: this.state.elixir.toFixed(1),
        hand: this.state.hand.join("|"),
        threat: `${this.state.threatLeft}/${this.state.threatRight}`,
        phase: this.state.phase,
        plan: this.planner.plan?.intent ?? "none",
        enemy: this.session.enemyCards.slice(0, 4).join("|") || "?",
        shotMs,
        perceptionMs: perception.latencyMs,
      });
      await logTickJson({
        tick,
        action,
        state: this.state.toPlannerSummary(),
        plan: this.planner.plan,
        perception,
        matchup: this.session.matchup?.fingerprint ?? null,
        shotMs,
      });
      return;
    }

    const slotName = `card_${action.slotIndex + 1}` as const;
    const slotPoint = getCardSlot(slotName);
    if (!slotPoint || !this.screen) {
      throw new Error(`Unknown slot mapping: ${slotName}`);
    }

    const from = toPixels(slotPoint, this.screen);
    const to = tileToPixels(action.tile, this.screen);

    if (config.DRY_RUN) {
      logTick({
        tick,
        action: action.cardId,
        slot: slotName,
        tile: `${action.tile.x},${action.tile.y}`,
        reason: action.reason,
        source: action.source,
        dryRun: true,
        elixir: this.state.elixir.toFixed(1),
        method: config.LAUNCH_METHOD,
        from: `${from.x},${from.y}`,
        to: `${to.x},${to.y}`,
        shotMs,
        perceptionMs: perception.latencyMs,
      });
      this.state.recordPlay(action.cardId, action.slotIndex, action.tile);
      const lastPlay = this.state.recentPlays[this.state.recentPlays.length - 1];
      if (lastPlay) this.session.notePlay(lastPlay);
      await logTickJson({
        tick,
        action,
        dryRun: true,
        from,
        to,
        state: this.state.toPlannerSummary(),
        plan: this.planner.plan,
        matchup: this.session.matchup?.fingerprint ?? null,
        shotMs,
        perceptionMs: perception.latencyMs,
      });
      return;
    }

    const launchStarted = performance.now();
    await launchCard(from, to);
    const launchMs = Math.round(performance.now() - launchStarted);

    this.state.recordPlay(action.cardId, action.slotIndex, action.tile);
    const lastPlay = this.state.recentPlays[this.state.recentPlays.length - 1];
    if (lastPlay) this.session.notePlay(lastPlay);

    logTick({
      tick,
      action: action.cardId,
      slot: slotName,
      tile: `${action.tile.x},${action.tile.y}`,
      reason: action.reason,
      source: action.source,
      adjusted: action.adjusted ?? false,
      elixir: this.state.elixir.toFixed(1),
      hand: this.state.hand.join("|"),
      threat: `${this.state.threatLeft}/${this.state.threatRight}`,
      phase: this.state.phase,
      plan: this.planner.plan?.intent ?? "none",
      enemy: this.session.enemyCards.slice(0, 4).join("|") || "?",
      method: config.LAUNCH_METHOD,
      from: `${from.x},${from.y}`,
      to: `${to.x},${to.y}`,
      shotMs,
      perceptionMs: perception.latencyMs,
      launchMs,
    });

    await logTickJson({
      tick,
      action,
      from,
      to,
      state: this.state.toPlannerSummary(),
      plan: this.planner.plan,
      perception,
      matchup: this.session.matchup?.fingerprint ?? null,
      shotMs,
      perceptionMs: perception.latencyMs,
      launchMs,
    });
  }
}
