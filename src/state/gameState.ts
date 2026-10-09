import type { Deck, DeckCard } from "../deck/index.js";
import { getCard } from "../deck/index.js";
import type { Tile } from "../arena.js";

export type BattlePhase = "single_elixir" | "double_elixir" | "overtime" | "unknown";

export type PlayRecord = {
  atMs: number;
  cardId: string;
  slot: number;
  tile: Tile;
  elixirBefore: number;
};

export type PerceptionSnapshot = {
  inBattle: boolean;
  inBattleProbability: number;
  elixirVisual: number | null;
  elixirConfidence: number | null;
  /** Card ids in hand slots 0..3, or null if unknown */
  hand: Array<string | null>;
  handConfidence: number[];
  phase: BattlePhase;
  threatLeft: number;
  threatRight: number;
  enemyPushCell: string | null;
  enemyClusterCell: string | null;
  ourTowerDamagedLeft: boolean;
  ourTowerDamagedRight: boolean;
  enemyTowerDestroyedLeft: boolean;
  enemyTowerDestroyedRight: boolean;
  latencyMs: number;
};

const SINGLE_ELIXIR_PERIOD_MS = 2800;
const DOUBLE_ELIXIR_PERIOD_MS = 1400;
const DOUBLE_ELIXIR_START_MS = 2 * 60 * 1000; // ~2:00 remaining → double starts at ~1:00 left of 3min; use battle clock
const OVERTIME_START_MS = 3 * 60 * 1000;

export class GameState {
  readonly deck: Deck;
  /** Monotonic battle clock (ms since first in-battle tick). */
  battleElapsedMs = 0;
  private lastTickAtMs: number | null = null;
  private inBattle = false;

  /** Modeled elixir 0..10 */
  elixir = 5;
  private elixirAccumulatorMs = 0;

  phase: BattlePhase = "unknown";

  /** Ordered cycle: first 4 are the current hand guess; remaining are queue. */
  cycle: string[];
  hand: Array<string | null> = [null, null, null, null];

  threatLeft = 0;
  threatRight = 0;
  enemyPushCell: string | null = null;
  enemyClusterCell: string | null = null;

  ourTowerDamagedLeft = false;
  ourTowerDamagedRight = false;
  enemyTowerDestroyedLeft = false;
  enemyTowerDestroyedRight = false;

  enemyCardsSeen: string[] = [];
  /** Sightings before a card is promoted to enemyCardsSeen (anti-hallucination). */
  private enemyCardHits = new Map<string, number>();
  recentPlays: PlayRecord[] = [];

  constructor(deck: Deck) {
    this.deck = deck;
    // Unknown order until perception fills hand; keep deck order as cycle seed.
    this.cycle = deck.cards.map((c) => c.id);
  }

  get isInBattle(): boolean {
    return this.inBattle;
  }

  elixirPeriodMs(): number {
    if (this.phase === "double_elixir" || this.phase === "overtime") {
      return DOUBLE_ELIXIR_PERIOD_MS;
    }
    return SINGLE_ELIXIR_PERIOD_MS;
  }

  /**
   * Advance clocks and blend visual perception into model state.
   */
  applyPerception(perception: PerceptionSnapshot, nowMs: number = Date.now()): void {
    if (!perception.inBattle) {
      if (this.inBattle) {
        this.resetBattle();
      }
      this.inBattle = false;
      return;
    }

    if (!this.inBattle) {
      this.startBattle(nowMs);
    } else if (this.lastTickAtMs != null) {
      const dt = Math.max(0, nowMs - this.lastTickAtMs);
      this.battleElapsedMs += dt;
      this.tickElixir(dt);
    }
    this.lastTickAtMs = nowMs;
    this.inBattle = true;

    // Phase: prefer visual, else clock heuristic.
    if (perception.phase !== "unknown") {
      this.phase = perception.phase;
    } else if (this.battleElapsedMs >= OVERTIME_START_MS) {
      this.phase = "overtime";
    } else if (this.battleElapsedMs >= DOUBLE_ELIXIR_START_MS) {
      this.phase = "double_elixir";
    } else {
      this.phase = "single_elixir";
    }

    if (perception.elixirVisual != null && (perception.elixirConfidence ?? 0) >= 0.25) {
      // Soft blend so OCR noise doesn't yank the model.
      this.elixir = clampElixir(
        this.elixir * 0.35 + perception.elixirVisual * 0.65,
      );
    }

    this.threatLeft = perception.threatLeft;
    this.threatRight = perception.threatRight;
    this.enemyPushCell = perception.enemyPushCell;
    this.enemyClusterCell = perception.enemyClusterCell;
    this.ourTowerDamagedLeft = perception.ourTowerDamagedLeft;
    this.ourTowerDamagedRight = perception.ourTowerDamagedRight;
    this.enemyTowerDestroyedLeft = perception.enemyTowerDestroyedLeft;
    this.enemyTowerDestroyedRight = perception.enemyTowerDestroyedRight;

    this.mergeHand(perception.hand, perception.handConfidence);
  }

  private startBattle(nowMs: number): void {
    this.battleElapsedMs = 0;
    this.lastTickAtMs = nowMs;
    this.elixir = 5;
    this.elixirAccumulatorMs = 0;
    this.phase = "single_elixir";
    this.recentPlays = [];
    this.enemyCardsSeen = [];
    this.enemyCardHits.clear();
  }

  private resetBattle(): void {
    this.battleElapsedMs = 0;
    this.lastTickAtMs = null;
    this.elixir = 5;
    this.elixirAccumulatorMs = 0;
    this.phase = "unknown";
    this.hand = [null, null, null, null];
    this.cycle = this.deck.cards.map((c) => c.id);
    this.threatLeft = 0;
    this.threatRight = 0;
    this.enemyPushCell = null;
    this.enemyClusterCell = null;
    this.recentPlays = [];
    this.enemyCardsSeen = [];
    this.enemyCardHits.clear();
  }

  private tickElixir(dtMs: number): void {
    const period = this.elixirPeriodMs();
    this.elixirAccumulatorMs += dtMs;
    while (this.elixirAccumulatorMs >= period && this.elixir < 10) {
      this.elixirAccumulatorMs -= period;
      this.elixir = clampElixir(this.elixir + 1);
    }
    if (this.elixir >= 10) {
      this.elixirAccumulatorMs = 0;
      this.elixir = 10;
    }
  }

  /**
   * Merge perceived hand with cycle model. High-confidence slots win;
   * unknown slots keep previous / cycle guess.
   * Enforces uniqueness: a card can occupy at most one hand slot.
   */
  private mergeHand(
    perceived: Array<string | null>,
    confidence: number[],
  ): void {
    const MIN_CONF = 0.38;
    const next: Array<string | null> = [null, null, null, null];

    // Assign by descending confidence so strong reads win duplicate fights.
    const ranked = [0, 1, 2, 3]
      .map((i) => ({
        i,
        id: perceived[i] ?? null,
        conf: confidence[i] ?? 0,
      }))
      .filter(
        (s) =>
          s.id &&
          this.deck.cards.some((c) => c.id === s.id) &&
          s.conf >= MIN_CONF,
      )
      .sort((a, b) => b.conf - a.conf);

    const used = new Set<string>();
    for (const slot of ranked) {
      const id = slot.id!;
      if (used.has(id)) continue;
      used.add(id);
      next[slot.i] = id;
    }

    // Keep previous unique cards in empty slots if still plausible (cycle).
    for (let i = 0; i < 4; i++) {
      if (next[i]) continue;
      const prev = this.hand[i];
      if (prev && !used.has(prev)) {
        next[i] = prev;
        used.add(prev);
      }
    }

    this.hand = next;

    const known = next.filter((id): id is string => id != null);
    const knownSet = new Set(known);
    const rest = this.cycle.filter((id) => !knownSet.has(id));
    for (const card of this.deck.cards) {
      if (!knownSet.has(card.id) && !rest.includes(card.id)) {
        rest.push(card.id);
      }
    }
    this.cycle = [...known, ...rest];
  }

  cardInSlot(slotIndex: number): DeckCard | null {
    const id = this.hand[slotIndex];
    if (!id) return null;
    return getCard(this.deck, id) ?? null;
  }

  findSlotForCard(cardId: string): number | null {
    const idx = this.hand.findIndex((id) => id === cardId);
    return idx >= 0 ? idx : null;
  }

  canAfford(cardId: string): boolean {
    const card = getCard(this.deck, cardId);
    if (!card) return false;
    return this.elixir + 1e-6 >= card.elixir;
  }

  /**
   * Record a successful play: spend elixir and rotate cycle into that slot.
   */
  recordPlay(cardId: string, slotIndex: number, tile: Tile): void {
    const card = getCard(this.deck, cardId);
    if (!card) return;
    const elixirBefore = this.elixir;
    this.elixir = clampElixir(this.elixir - card.elixir);

    // Rotate: card leaves hand → end of cycle; next next-card fills the slot.
    const inCycle = this.cycle.indexOf(cardId);
    if (inCycle >= 0) {
      this.cycle.splice(inCycle, 1);
    }
    this.cycle.push(cardId);
    const nextId = this.cycle[4] ?? this.cycle[this.cycle.length - 1] ?? null;
    // After play, first 4 of cycle are the new hand guess.
    // Rebuild hand: replace played slot with the card that was at position 4.
    const newHand = [...this.hand];
    newHand[slotIndex] = nextId && nextId !== cardId ? nextId : this.cycle.find(
      (id) => !newHand.includes(id) && id !== cardId,
    ) ?? null;
    // Sync cycle head with hand
    const handIds = newHand.filter((id): id is string => id != null);
    const rest = this.cycle.filter((id) => !handIds.includes(id));
    this.cycle = [...handIds, ...rest];
    this.hand = newHand;

    this.recentPlays.push({
      atMs: this.battleElapsedMs,
      cardId,
      slot: slotIndex,
      tile,
      elixirBefore,
    });
    if (this.recentPlays.length > 32) {
      this.recentPlays.shift();
    }
  }

  /**
   * Record possible enemy cards. Requires 2 independent sightings before
   * promoting to enemyCardsSeen (stops one-shot planner hallucinations like fake X-Bow).
   */
  noteEnemyCards(ids: string[], opts?: { confirmed?: boolean }): void {
    for (const raw of ids) {
      const id = raw.trim().toLowerCase().replace(/\s+/g, "_");
      if (!id || id === "unknown" || id === "none") continue;

      if (opts?.confirmed) {
        if (!this.enemyCardsSeen.includes(id)) this.enemyCardsSeen.push(id);
        this.enemyCardHits.set(id, 99);
        continue;
      }

      const hits = (this.enemyCardHits.get(id) ?? 0) + 1;
      this.enemyCardHits.set(id, hits);
      if (hits >= 2 && !this.enemyCardsSeen.includes(id)) {
        this.enemyCardsSeen.push(id);
      }
    }
  }

  threatenedLane(): "left" | "right" | "none" {
    if (this.threatLeft >= this.threatRight && this.threatLeft >= 4) {
      return "left";
    }
    if (this.threatRight > this.threatLeft && this.threatRight >= 4) {
      return "right";
    }
    return "none";
  }

  toPlannerSummary(): Record<string, unknown> {
    return {
      battleElapsedMs: this.battleElapsedMs,
      phase: this.phase,
      elixir: Number(this.elixir.toFixed(2)),
      hand: this.hand,
      cycle: this.cycle,
      threatLeft: this.threatLeft,
      threatRight: this.threatRight,
      enemyPushCell: this.enemyPushCell,
      enemyClusterCell: this.enemyClusterCell,
      ourTowerDamagedLeft: this.ourTowerDamagedLeft,
      ourTowerDamagedRight: this.ourTowerDamagedRight,
      enemyTowerDestroyedLeft: this.enemyTowerDestroyedLeft,
      enemyTowerDestroyedRight: this.enemyTowerDestroyedRight,
      enemyCardsSeen: this.enemyCardsSeen,
      recentPlays: this.recentPlays.slice(-8),
    };
  }
}

function clampElixir(value: number): number {
  return Math.max(0, Math.min(10, value));
}
