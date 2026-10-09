import {
  getScreenSize,
  launchCard,
  screencap,
  type ScreenSize,
} from "./adb.js";
import { config } from "./config.js";
import { decideAction, decidePlacement } from "./decisions.js";
import { prepareScreenshot } from "./image.js";
import {
  getCardSlot,
  getPlacementZone,
  toPixels,
  WAIT_ACTION,
  type CardSlotName,
} from "./layout.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCardAction(action: string): action is CardSlotName {
  return action.startsWith("card_");
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

  async start(): Promise<void> {
    this.running = true;
    this.screen = await getScreenSize();
    console.log(
      `Battle bot started — screen ${this.screen.width}x${this.screen.height}, ` +
        `loop=${config.BATTLE_LOOP_TOOL_CALL_MS}ms, dryRun=${config.DRY_RUN}`,
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

  private async runTick(): Promise<void> {
    this.tick += 1;
    const tick = this.tick;

    const shotStarted = performance.now();
    const png = await screencap();
    const shotMs = Math.round(performance.now() - shotStarted);

    const prepared = await prepareScreenshot(png, {
      label: `tick-${tick}`,
    });

    const actionDecision = await decideAction(prepared.dataUrl);

    if (!actionDecision.inBattle) {
      logTick({
        tick,
        action: "skip",
        reason: "not_in_battle",
        inBattle: actionDecision.inBattleProbability.toFixed(2),
        shotMs,
        decisionsMs: actionDecision.latencyMs,
      });
      return;
    }

    if (actionDecision.action === WAIT_ACTION.name || !isCardAction(actionDecision.action)) {
      logTick({
        tick,
        action: WAIT_ACTION.name,
        raw: actionDecision.rawChoice ?? "n/a",
        confidence: actionDecision.confidence.toFixed(2),
        p: actionDecision.choiceProbability.toFixed(2),
        inBattle: actionDecision.inBattleProbability.toFixed(2),
        elixir: actionDecision.elixirScore?.toFixed(1) ?? "n/a",
        refused: actionDecision.refused,
        shotMs,
        decisionsMs: actionDecision.latencyMs,
      });
      return;
    }

    const slot = actionDecision.action;
    const placement = await decidePlacement(prepared.dataUrl, slot);

    if (placement.cancelled) {
      logTick({
        tick,
        action: slot,
        placement: "cancelled",
        confidence: placement.confidence.toFixed(2),
        shotMs,
        actionMs: actionDecision.latencyMs,
        placementMs: placement.latencyMs,
      });
      return;
    }

    const slotPoint = getCardSlot(slot);
    const zonePoint = getPlacementZone(placement.zone);
    if (!slotPoint || !zonePoint || !this.screen) {
      throw new Error(`Unknown slot/zone mapping: ${slot} -> ${placement.zone}`);
    }

    const from = toPixels(slotPoint, this.screen);
    const to = toPixels(zonePoint, this.screen);

    if (config.DRY_RUN) {
      logTick({
        tick,
        action: slot,
        zone: placement.zone,
        confidence: placement.confidence.toFixed(2),
        usedFallback: placement.usedFallback,
        dryRun: true,
        method: config.LAUNCH_METHOD,
        from: `${from.x},${from.y}`,
        to: `${to.x},${to.y}`,
        shotMs,
        actionMs: actionDecision.latencyMs,
        placementMs: placement.latencyMs,
      });
      return;
    }

    const launchStarted = performance.now();
    await launchCard(from, to);
    const launchMs = Math.round(performance.now() - launchStarted);

    logTick({
      tick,
      action: slot,
      zone: placement.zone,
      rawZone: placement.rawZone ?? "n/a",
      actionP: actionDecision.choiceProbability.toFixed(2),
      placeP: placement.choiceProbability.toFixed(2),
      placeConf: placement.confidence.toFixed(2),
      usedFallback: placement.usedFallback,
      elixir: actionDecision.elixirScore?.toFixed(1) ?? "n/a",
      method: config.LAUNCH_METHOD,
      from: `${from.x},${from.y}`,
      to: `${to.x},${to.y}`,
      shotMs,
      actionMs: actionDecision.latencyMs,
      placementMs: placement.latencyMs,
      launchMs,
    });
  }
}
