import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { config } from "./config.js";

export type PreparedScreenshot = {
  /** JPEG bytes after resize/compress */
  jpeg: Buffer;
  /** data:image/jpeg;base64,... for Decisions API */
  dataUrl: string;
  width: number;
  height: number;
};

/**
 * Resize a PNG screencap to SCREENSHOT_MAX_WIDTH and encode as JPEG data URL.
 */
export async function prepareScreenshot(
  png: Buffer,
  options?: { saveDebug?: boolean; label?: string },
): Promise<PreparedScreenshot> {
  const image = sharp(png).rotate(); // honor EXIF orientation if present
  const meta = await image.metadata();
  const maxWidth = config.SCREENSHOT_MAX_WIDTH;

  const pipeline =
    meta.width && meta.width > maxWidth
      ? image.resize({ width: maxWidth, withoutEnlargement: true })
      : image;

  const jpeg = await pipeline.jpeg({ quality: 75, mozjpeg: true }).toBuffer();
  const outMeta = await sharp(jpeg).metadata();
  const width = outMeta.width ?? maxWidth;
  const height = outMeta.height ?? Math.round(maxWidth * 1.5);
  const dataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;

  const saveDebug = options?.saveDebug ?? config.DEBUG_SAVE_FRAMES;
  if (saveDebug) {
    const dir = path.join(process.cwd(), "debug", "frames");
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const label = options?.label ? `-${options.label}` : "";
    await writeFile(path.join(dir, `${stamp}${label}.jpg`), jpeg);
  }

  return { jpeg, dataUrl, width, height };
}
