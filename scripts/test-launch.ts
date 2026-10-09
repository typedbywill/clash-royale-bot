/**
 * Manual launch smoke test (no Decisions API).
 * Usage: npx tsx scripts/test-launch.ts [card_1|card_2|card_3|card_4] [zone]
 */
import { getScreenSize, launchCard } from "../src/adb.js";
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
  const zoneName = process.argv[3] ?? DEFAULT_FALLBACK_ZONE;

  const slot = getCardSlot(slotName);
  const zone = getPlacementZone(zoneName);
  if (!slot || !zone) {
    console.error(
      `Unknown slot/zone. slots=${CARD_SLOTS.map((s) => s.name).join(",")} zone=${zoneName}`,
    );
    process.exitCode = 1;
    return;
  }

  const screen = await getScreenSize();
  const from = toPixels(slot, screen);
  const to = toPixels(zone, screen);

  console.log(
    `Launch ${slotName} -> ${zoneName} via ${config.LAUNCH_METHOD} ` +
      `(${from.x},${from.y}) -> (${to.x},${to.y}) delay=${config.CARD_SELECT_DELAY_MS}ms`,
  );

  await launchCard(from, to);
  console.log("Done. Check the phone — card should deploy.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
