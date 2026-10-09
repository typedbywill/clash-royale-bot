import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { getScreenSize, screencap } from "../src/adb.js";
import {
  CARD_SLOTS,
  PLACEMENT_ZONES,
  toPixels,
  type NamedPoint,
} from "../src/layout.js";

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function printTable(
  title: string,
  points: NamedPoint[],
  screen: { width: number; height: number },
): void {
  console.log(`\n${title}`);
  console.log(
    `${"name".padEnd(24)} ${"x".padStart(6)} ${"y".padStart(6)} ${"px".padStart(12)}`,
  );
  console.log("-".repeat(52));
  for (const point of points) {
    const px = toPixels(point, screen);
    console.log(
      `${point.name.padEnd(24)} ${point.x.toFixed(3).padStart(6)} ${point.y
        .toFixed(3)
        .padStart(6)} ${(px.x + "," + px.y).padStart(12)}`,
    );
  }
}

async function main(): Promise<void> {
  console.log("Capturing screenshot for calibration...");
  const screen = await getScreenSize();
  const png = await screencap();

  printTable("CARD SLOTS (edit in src/layout.ts → CARD_SLOTS)", CARD_SLOTS, screen);
  printTable(
    "PLACEMENT ZONES (edit in src/layout.ts → PLACEMENT_ZONES)",
    PLACEMENT_ZONES,
    screen,
  );

  const markers = [
    ...CARD_SLOTS.map((slot) => ({ ...slot, color: "#22c55e", kind: "slot" })),
    ...PLACEMENT_ZONES.map((zone) => ({
      ...zone,
      color: "#3b82f6",
      kind: "zone",
    })),
  ];

  const circles = markers
    .map((marker) => {
      const { x, y } = toPixels(marker, screen);
      const r = marker.kind === "slot" ? 28 : 22;
      return `
        <circle cx="${x}" cy="${y}" r="${r}" fill="${marker.color}" fill-opacity="0.45" stroke="#fff" stroke-width="3"/>
        <text x="${x}" y="${y - r - 8}" text-anchor="middle" font-size="28" font-family="sans-serif" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">${escapeXml(marker.name)}</text>
      `;
    })
    .join("\n");

  const svg = `
    <svg width="${screen.width}" height="${screen.height}" xmlns="http://www.w3.org/2000/svg">
      ${circles}
      <text x="40" y="60" font-size="36" font-family="sans-serif" fill="#22c55e" stroke="#000" stroke-width="3" paint-order="stroke">green = card slots</text>
      <text x="40" y="110" font-size="36" font-family="sans-serif" fill="#3b82f6" stroke="#000" stroke-width="3" paint-order="stroke">blue = placement zones</text>
      <text x="40" y="160" font-size="28" font-family="sans-serif" fill="#fff" stroke="#000" stroke-width="2" paint-order="stroke">${screen.width}x${screen.height}</text>
    </svg>
  `;

  const overlay = await sharp(png)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();

  const outDir = path.join(process.cwd(), "debug");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "calibration.png");
  await writeFile(outPath, overlay);

  console.log(`\nWrote ${outPath}`);
  console.log(`
How to adjust card slots:
  1. Open debug/calibration.png
  2. Green dots must sit in the CENTER of each hand card
  3. Edit src/layout.ts → CARD_SLOTS (values are 0..1 of the screen)
       dot too HIGH  → increase y   (e.g. 0.91 → 0.92)
       dot too LOW   → decrease y
       dot too LEFT  → increase x
       dot too RIGHT → decrease x
  4. Re-run: npm run calibrate
  5. Smoke test: npm run test-launch -- card_2 left_bridge
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
