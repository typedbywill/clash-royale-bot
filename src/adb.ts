import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);

export type ScreenSize = {
  width: number;
  height: number;
};

function adbArgs(args: string[]): string[] {
  if (config.ADB_SERIAL) {
    return ["-s", config.ADB_SERIAL, ...args];
  }
  return args;
}

async function runAdb(
  args: string[],
  options: { encoding?: "buffer" | "utf8"; maxBuffer?: number } = {},
): Promise<{ stdout: Buffer | string; stderr: string }> {
  const encoding = options.encoding ?? "utf8";
  try {
    const result = await execFileAsync("adb", adbArgs(args), {
      encoding,
      maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    });
    return {
      stdout: result.stdout as Buffer | string,
      stderr: String(result.stderr ?? ""),
    };
  } catch (error) {
    const err = error as Error & { stderr?: string; stdout?: string };
    throw new Error(
      `adb ${args.join(" ")} failed: ${err.message}${
        err.stderr ? `\n${err.stderr}` : ""
      }`,
    );
  }
}

/** Capture the current screen as a PNG buffer via `adb exec-out screencap -p`. */
export async function screencap(): Promise<Buffer> {
  const { stdout } = await runAdb(["exec-out", "screencap", "-p"], {
    encoding: "buffer",
  });
  const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  if (buffer.length < 8 || buffer[0] !== 0x89 || buffer[1] !== 0x50) {
    throw new Error(
      "screencap did not return a PNG (is a device connected and unlocked?)",
    );
  }
  return buffer;
}

/** Read physical display size from `adb shell wm size`. */
export async function getScreenSize(): Promise<ScreenSize> {
  const { stdout } = await runAdb(["shell", "wm", "size"]);
  const text = String(stdout);
  // Prefer "Override size" when present (e.g. some OEMs / scrcpy), else Physical.
  const override = text.match(/Override size:\s*(\d+)x(\d+)/i);
  const physical = text.match(/Physical size:\s*(\d+)x(\d+)/i);
  const plain = text.match(/(\d+)x(\d+)/);
  const match = override ?? physical ?? plain;
  if (!match) {
    throw new Error(`Could not parse wm size output: ${text.trim()}`);
  }
  return {
    width: Number(match[1]),
    height: Number(match[2]),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function tap(x: number, y: number): Promise<void> {
  const xi = Math.round(x);
  const yi = Math.round(y);
  // touchscreen source is more reliable for Unity games than plain "input tap"
  await runAdb([
    "shell",
    "input",
    "touchscreen",
    "tap",
    String(xi),
    String(yi),
  ]);
}

export async function swipe(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs: number = config.SWIPE_DURATION_MS,
): Promise<void> {
  await runAdb([
    "shell",
    "input",
    "touchscreen",
    "swipe",
    String(Math.round(x1)),
    String(Math.round(y1)),
    String(Math.round(x2)),
    String(Math.round(y2)),
    String(Math.round(durationMs)),
  ]);
}

/**
 * Deploy a card: select then place.
 * Clash Royale often ignores short swipes; tap→delay→tap is more reliable.
 */
export async function launchCard(
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  if (config.LAUNCH_METHOD === "swipe") {
    await swipe(from.x, from.y, to.x, to.y, config.SWIPE_DURATION_MS);
    return;
  }

  await tap(from.x, from.y);
  await sleep(config.CARD_SELECT_DELAY_MS);
  await tap(to.x, to.y);
}

export async function listDevices(): Promise<string[]> {
  const { stdout } = await runAdb(["devices"]);
  return String(stdout)
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.endsWith("\tdevice"))
    .map((line) => line.split("\t")[0]!);
}
