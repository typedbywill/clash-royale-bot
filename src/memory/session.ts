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

  noteEnemyCards(ids: string[]): void {
    for (const id of ids) {
      const cleaned = id.trim();
      if (cleaned && !this.enemyCards.includes(cleaned)) {
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
