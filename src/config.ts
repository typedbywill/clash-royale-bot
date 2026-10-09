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

/** Parsed as "left,top,right,bottom" normalized 0..1 arena bounds. */
const arenaBoundsSchema = z
  .string()
  .default("0.08,0.12,0.92,0.78")
  .transform((raw) => {
    const parts = raw.split(",").map((p) => Number(p.trim()));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
      throw new Error(
        'ARENA_BOUNDS must be "left,top,right,bottom" normalized floats (e.g. 0.08,0.12,0.92,0.78)',
      );
    }
    const [left, top, right, bottom] = parts as [number, number, number, number];
    if (left >= right || top >= bottom) {
      throw new Error("ARENA_BOUNDS: left < right and top < bottom required");
    }
    return { left, top, right, bottom };
  });

const envSchema = z.object({
  // Optional here so `npm run calibrate` works without a key; bot entry requires it.
  OPENAI_API_KEY: z.string().optional().default(""),
  DECISIONS_MODEL: z.string().default("gpt-6-luna"),
  PLANNER_MODEL: z.string().default("gpt-5.4-mini"),
  PLANNER_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  DECK_FILE: z.string().default("deck.json"),
  /** Local dir for battle reports + matchup memory (relative to cwd). */
  MEMORY_DIR: z.string().default("memory"),
  ARENA_BOUNDS: arenaBoundsSchema,
  SCREENCAP_FORMAT: z.enum(["raw", "png"]).default("raw"),
  BATTLE_LOOP_TOOL_CALL_MS: z.coerce.number().int().positive().default(1500),
  ADB_SERIAL: z.string().optional().default(""),
  MIN_ACTION_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.3),
  MIN_PLACEMENT_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.3),
  SCREENSHOT_MAX_WIDTH: z.coerce.number().int().positive().default(720),
  SWIPE_DURATION_MS: z.coerce.number().int().positive().default(350),
  /** tap = select card then tap arena; swipe = drag gesture; drag = motionevent */
  LAUNCH_METHOD: z.enum(["tap", "swipe", "drag"]).default("tap"),
  /** Delay between selecting a card and tapping the arena */
  CARD_SELECT_DELAY_MS: z.coerce.number().int().nonnegative().default(220),
  DRY_RUN: boolFromEnv.default(false),
  DEBUG_SAVE_FRAMES: boolFromEnv.default(false),
  DEBUG_TICK_LOG: boolFromEnv.default(true),
  LOW_CONFIDENCE_PLACEMENT: z.enum(["fallback", "cancel"]).default("fallback"),
  /** Threat score (0-9) above which reactive counters may fire. */
  REACTIVE_THREAT_THRESHOLD: z.coerce.number().min(0).max(9).default(5),
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
