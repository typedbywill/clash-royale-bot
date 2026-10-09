import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

let sessionFile: string | null = null;

async function ensureSessionFile(): Promise<string | null> {
  if (!config.DEBUG_TICK_LOG) return null;
  if (sessionFile) return sessionFile;
  const dir = path.join(process.cwd(), "debug", "ticks");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  sessionFile = path.join(dir, `${stamp}.jsonl`);
  return sessionFile;
}

export async function logTickJson(
  record: Record<string, unknown>,
): Promise<void> {
  const file = await ensureSessionFile();
  if (!file) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...record,
  });
  await appendFile(file, line + "\n", "utf8");
}
