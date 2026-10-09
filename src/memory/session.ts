import type { BattlePlan } from "../planner.js";
import type { PlayRecord } from "../state/gameState.js";
import type { MatchupMemory } from "./schema.js";
import { fingerprint } from "./store.js";

export type PlanSnapshot = {
  atMs: number;
  intent: string;
  note: string;
  cards: string[];
};

export type ThreatSpike = {
  atMs: number;
  left: number;
  right: number;
};

/**
 * In-memory buffer for a single battle, cleared on battle end after debrief.
 */
export class BattleSession {
  startedAt: string | null = null;
  startedAtMs = 0;
  active = false;

  enemyCards: string[] = [];
  ourPlays: PlayRecord[] = [];
  planSnapshots: PlanSnapshot[] = [];
  threatSpikes: ThreatSpike[] = [];
  intents: string[] = [];

  /** Cached matchup loaded at battle start / when cards accumulate. */
  matchup: MatchupMemory | null = null;

  /** Last screenshot data URL at battle end (for debrief). */
  lastDataUrl: string | null = null;

  ourDeckArchetype = "";

  start(ourDeckArchetype: string, nowMs: number): void {
    this.active = true;
    this.startedAt = new Date(nowMs).toISOString();
    this.startedAtMs = nowMs;
    this.ourDeckArchetype = ourDeckArchetype;
    this.enemyCards = [];
    this.enemyHits = new Map();
    this.ourPlays = [];
    this.planSnapshots = [];
    this.threatSpikes = [];
    this.intents = [];
    this.matchup = null;
    this.lastDataUrl = null;
  }

  end(): void {
    this.active = false;
  }

  /** Snapshot for async debrief so a new battle can start without wiping data mid-call. */
  cloneForDebrief(): BattleSession {
    const copy = new BattleSession();
    copy.active = false;
    copy.startedAt = this.startedAt;
    copy.startedAtMs = this.startedAtMs;
    copy.ourDeckArchetype = this.ourDeckArchetype;
    copy.enemyCards = [...this.enemyCards];
    copy.enemyHits = new Map(this.enemyHits);
    copy.ourPlays = [...this.ourPlays];
    copy.planSnapshots = [...this.planSnapshots];
    copy.threatSpikes = [...this.threatSpikes];
    copy.intents = [...this.intents];
    copy.matchup = this.matchup;
    copy.lastDataUrl = this.lastDataUrl;
    return copy;
  }

  private enemyHits = new Map<string, number>();

  /**
   * Require 2 sightings before recording (same anti-hallucination rule as GameState).
   */
  noteEnemyCards(ids: string[], opts?: { confirmed?: boolean }): void {
    for (const raw of ids) {
      const cleaned = raw.trim().toLowerCase().replace(/\s+/g, "_");
      if (!cleaned || cleaned === "unknown" || cleaned === "none") continue;

      if (opts?.confirmed) {
        if (!this.enemyCards.includes(cleaned)) this.enemyCards.push(cleaned);
        this.enemyHits.set(cleaned, 99);
        continue;
      }

      const hits = (this.enemyHits.get(cleaned) ?? 0) + 1;
      this.enemyHits.set(cleaned, hits);
      if (hits >= 2 && !this.enemyCards.includes(cleaned)) {
        this.enemyCards.push(cleaned);
      }
    }
  }

  notePlay(play: PlayRecord): void {
    this.ourPlays.push(play);
    if (this.ourPlays.length > 48) this.ourPlays.shift();
  }

  notePlan(plan: BattlePlan, battleElapsedMs: number): void {
    if (this.intents[this.intents.length - 1] !== plan.intent) {
      this.intents.push(plan.intent);
    }
    this.planSnapshots.push({
      atMs: battleElapsedMs,
      intent: plan.intent,
      note: plan.note,
      cards: plan.steps.map((s) => s.card),
    });
    if (this.planSnapshots.length > 24) this.planSnapshots.shift();
  }

  noteThreat(left: number, right: number, battleElapsedMs: number): void {
    const max = Math.max(left, right);
    if (max < 6) return;
    const last = this.threatSpikes[this.threatSpikes.length - 1];
    if (last && battleElapsedMs - last.atMs < 3000) {
      last.left = left;
      last.right = right;
      return;
    }
    this.threatSpikes.push({ atMs: battleElapsedMs, left, right });
    if (this.threatSpikes.length > 16) this.threatSpikes.shift();
  }

  currentFingerprint(): string {
    return fingerprint(this.enemyCards);
  }

  toDebriefSummary(): Record<string, unknown> {
    return {
      startedAt: this.startedAt,
      ourDeckArchetype: this.ourDeckArchetype,
      enemyCards: this.enemyCards,
      enemyFingerprint: this.currentFingerprint(),
      intents: this.intents,
      recentPlans: this.planSnapshots.slice(-8),
      ourPlays: this.ourPlays.slice(-16).map((p) => ({
        cardId: p.cardId,
        tile: p.tile,
        atMs: p.atMs,
        elixirBefore: p.elixirBefore,
      })),
      threatSpikes: this.threatSpikes.slice(-8),
      priorMatchup: this.matchup
        ? {
            fingerprint: this.matchup.fingerprint,
            record: `${this.matchup.wins}W-${this.matchup.losses}L`,
            styleSummary: this.matchup.styleSummary,
            counterStrategy: this.matchup.counterStrategy,
            lessons: this.matchup.lessons.slice(-6),
          }
        : null,
    };
  }
}
