/**
 * Manual launch smoke test (no AI).
 * Usage:
 *   npx tsx scripts/test-launch.ts [card_1|…] [zone|tile:x,y]
 * Examples:
 *   npm run test-launch -- card_2 left_bridge
 *   npm run test-launch -- card_1 tile:9,22
 */
import { getScreenSize, launchCard } from "../src/adb.js";
import { tileToPixels } from "../src/arena.js";
import { config } from "../src/config.js";
import {
  CARD_SLOTS,
  DEFAULT_FALLBACK_ZONE,
  getCardSlot,
  getPlacementZone,
  toPixels,
} from "../src/layout.js";

async function main(): Promise<void> {
  const slotName = process.argv[2] ?? "card_1";
  const target = process.argv[3] ?? DEFAULT_FALLBACK_ZONE;

  const slot = getCardSlot(slotName);
  if (!slot) {
    console.error(
      `Unknown slot. slots=${CARD_SLOTS.map((s) => s.name).join(",")}`,
    );
    process.exitCode = 1;
    return;
  }

  const screen = await getScreenSize();
  const from = toPixels(slot, screen);

  let to: { x: number; y: number };
  let label: string;

  const tileMatch = /^tile:(\d+),(\d+)$/i.exec(target);
  if (tileMatch) {
    const tile = { x: Number(tileMatch[1]), y: Number(tileMatch[2]) };
    to = tileToPixels(tile, screen);
    label = `tile(${tile.x},${tile.y})`;
  } else {
    const zone = getPlacementZone(target);
    if (!zone) {
      console.error(`Unknown zone "${target}". Use a named zone or tile:x,y`);
      process.exitCode = 1;
      return;
    }
    to = toPixels(zone, screen);
    label = target;
  }

  console.log(
    `Launch ${slotName} -> ${label} via ${config.LAUNCH_METHOD} ` +
      `(${from.x},${from.y}) -> (${to.x},${to.y}) delay=${config.CARD_SELECT_DELAY_MS}ms`,
  );

  await launchCard(from, to);
  console.log("Done. Check the phone — card should deploy.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
