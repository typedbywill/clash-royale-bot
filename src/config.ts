import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const boolFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === "boolean") return value;
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  });

const envSchema = z.object({
  // Optional here so `npm run calibrate` works without a key; bot entry requires it.
  OPENAI_API_KEY: z.string().optional().default(""),
  DECISIONS_MODEL: z.string().default("gpt-6-luna"),
  BATTLE_LOOP_TOOL_CALL_MS: z.coerce.number().int().positive().default(1500),
  ADB_SERIAL: z.string().optional().default(""),
  MIN_ACTION_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.3),
  MIN_PLACEMENT_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.3),
  SCREENSHOT_MAX_WIDTH: z.coerce.number().int().positive().default(720),
  SWIPE_DURATION_MS: z.coerce.number().int().positive().default(350),
  /** tap = select card then tap arena (recommended); swipe = drag gesture */
  LAUNCH_METHOD: z.enum(["tap", "swipe"]).default("tap"),
  /** Delay between selecting a card and tapping the arena */
  CARD_SELECT_DELAY_MS: z.coerce.number().int().nonnegative().default(220),
  DRY_RUN: boolFromEnv.default(false),
  DEBUG_SAVE_FRAMES: boolFromEnv.default(false),
  LOW_CONFIDENCE_PLACEMENT: z.enum(["fallback", "cancel"]).default("fallback"),
});

export type Config = z.infer<typeof envSchema>;

function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return parsed.data;
}

export const config = loadConfig();

export function assertOpenAIKey(): void {
  if (!config.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is required. Copy .env.example to .env and set your key.",
    );
  }
}
