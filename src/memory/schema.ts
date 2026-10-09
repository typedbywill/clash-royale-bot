import { z } from "zod";

export const battleResultSchema = z.enum(["win", "loss", "unknown"]);

export const battleReportSchema = z.object({
  id: z.string().min(1),
  startedAt: z.string().min(1),
  endedAt: z.string().min(1),
  result: battleResultSchema,
  ourDeckArchetype: z.string().min(1),
  enemyCards: z.array(z.string()).default([]),
  enemyFingerprint: z.string().min(1),
  enemyStyle: z.string().default(""),
  ourStrategy: z.string().default(""),
  keyLessons: z.array(z.string()).default([]),
  notablePlays: z.array(z.string()).default([]),
});

export const matchupMemorySchema = z.object({
  fingerprint: z.string().min(1),
  enemyCards: z.array(z.string()).default([]),
  gamesPlayed: z.number().int().nonnegative().default(0),
  wins: z.number().int().nonnegative().default(0),
  losses: z.number().int().nonnegative().default(0),
  styleSummary: z.string().default(""),
  counterStrategy: z.string().default(""),
  lessons: z.array(z.string()).default([]),
  updatedAt: z.string().min(1),
});

/** Structured output from the post-battle debrief call. */
export const debriefOutputSchema = z.object({
  result: battleResultSchema.default("unknown"),
  enemyCards: z.array(z.string()).default([]),
  enemyStyle: z.string().default(""),
  ourStrategy: z.string().default(""),
  keyLessons: z.array(z.string()).max(8).default([]),
  notablePlays: z.array(z.string()).max(8).default([]),
});

export type BattleResult = z.infer<typeof battleResultSchema>;
export type BattleReport = z.infer<typeof battleReportSchema>;
export type MatchupMemory = z.infer<typeof matchupMemorySchema>;
export type DebriefOutput = z.infer<typeof debriefOutputSchema>;
