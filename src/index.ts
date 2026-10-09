import { listDevices } from "./adb.js";
import { BattleBot } from "./bot.js";
import { assertOpenAIKey, config } from "./config.js";
import { loadDeck } from "./deck/index.js";

async function main(): Promise<void> {
  assertOpenAIKey();

  const deck = loadDeck();
  console.log(
    `Deck: ${deck.archetype} (${deck.cards.map((c) => c.name).join(", ")})`,
  );

  const devices = await listDevices();
  if (devices.length === 0) {
    throw new Error(
      "No ADB devices found. Connect a phone with USB debugging enabled (adb devices).",
    );
  }

  if (config.ADB_SERIAL && !devices.includes(config.ADB_SERIAL)) {
    throw new Error(
      `ADB_SERIAL=${config.ADB_SERIAL} not in connected devices: ${devices.join(", ")}`,
    );
  }

  if (!config.ADB_SERIAL && devices.length > 1) {
    console.warn(
      `Multiple devices connected (${devices.join(", ")}). Set ADB_SERIAL in .env to pick one.`,
    );
  }

  console.log(
    `Using device: ${config.ADB_SERIAL || devices[0]} | ` +
      `perception=${config.DECISIONS_MODEL} | planner=${config.PLANNER_MODEL}`,
  );
  console.warn(
    "Warning: automating Clash Royale may violate Supercell's Terms of Service. Prefer a side account / friendly battles.",
  );

  const bot = new BattleBot();

  const shutdown = () => {
    console.log("\nStopping battle loop...");
    bot.stop();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await bot.start();
  console.log("Battle bot stopped.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
