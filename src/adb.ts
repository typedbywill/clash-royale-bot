import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
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

/**
 * Capture the current screen as a PNG buffer.
 * Prefer raw RGBA screencap (faster — no on-device PNG compress), fallback to -p.
 */
export async function screencap(): Promise<Buffer> {
  if (config.SCREENCAP_FORMAT === "png") {
    return screencapPng();
  }
  try {
    return await screencapRaw();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[adb] raw screencap failed (${message}); falling back to png`);
    return screencapPng();
  }
}

async function screencapPng(): Promise<Buffer> {
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

/**
 * `adb exec-out screencap` (no -p) returns:
 *   uint32 width, height, format (little-endian) + pixel data
 * Format 1 = RGBA_8888 on most devices.
 */
async function screencapRaw(): Promise<Buffer> {
  const { stdout } = await runAdb(["exec-out", "screencap"], {
    encoding: "buffer",
  });
  const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  if (buffer.length < 12) {
    throw new Error("raw screencap too short");
  }

  const width = buffer.readUInt32LE(0);
  const height = buffer.readUInt32LE(4);
  const format = buffer.readUInt32LE(8);

  // Some Android versions include a 4-byte unused field after format (16-byte header).
  let headerSize = 12;
  const pixels12 = buffer.length - 12;
  const pixels16 = buffer.length - 16;
  const expected = width * height * 4;

  if (pixels16 === expected) {
    headerSize = 16;
  } else if (pixels12 !== expected) {
    throw new Error(
      `raw screencap size mismatch: ${width}x${height} fmt=${format} ` +
        `bytes=${buffer.length} expectedPixels=${expected}`,
    );
  }

  if (format !== 1 && format !== 0) {
    // 1 = RGBA_8888; 0 sometimes reported — still treat as RGBA
    console.warn(`[adb] unexpected screencap format ${format}, assuming RGBA`);
  }

  const rgba = buffer.subarray(headerSize);
  return sharp(rgba, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();
}

/** Read physical display size from `adb shell wm size`. */
export async function getScreenSize(): Promise<ScreenSize> {
  const { stdout } = await runAdb(["shell", "wm", "size"]);
  const text = String(stdout);
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
 * Precise drag via motionevent DOWN → MOVE → UP.
 * More reliable for mid-drag placement than a single swipe on some devices.
 */
export async function dragCard(
  from: { x: number; y: number },
  to: { x: number; y: number },
  durationMs: number = config.SWIPE_DURATION_MS,
): Promise<void> {
  const x1 = Math.round(from.x);
  const y1 = Math.round(from.y);
  const x2 = Math.round(to.x);
  const y2 = Math.round(to.y);
  const steps = Math.max(3, Math.round(durationMs / 16));
  const stepDelay = Math.max(8, Math.round(durationMs / steps));

  await runAdb([
    "shell",
    "input",
    "motionevent",
    "DOWN",
    String(x1),
    String(y1),
  ]);
  await sleep(30);

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(x1 + (x2 - x1) * t);
    const y = Math.round(y1 + (y2 - y1) * t);
    await runAdb([
      "shell",
      "input",
      "motionevent",
      "MOVE",
      String(x),
      String(y),
    ]);
    await sleep(stepDelay);
  }

  await runAdb([
    "shell",
    "input",
    "motionevent",
    "UP",
    String(x2),
    String(y2),
  ]);
}

/**
 * Deploy a card: select then place.
 * Clash Royale often ignores short swipes; tap→delay→tap is the default.
 */
export async function launchCard(
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  if (config.LAUNCH_METHOD === "swipe") {
    await swipe(from.x, from.y, to.x, to.y, config.SWIPE_DURATION_MS);
    return;
  }

  if (config.LAUNCH_METHOD === "drag") {
    await dragCard(from, to, config.SWIPE_DURATION_MS);
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
