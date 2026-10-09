import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { getScreenSize, screencap } from "../src/adb.js";
import {
  ARENA_COLS,
  ARENA_ROWS,
  sampleGridTiles,
  tileToNormalized,
  tileToPixels,
  TILE_SHORTCUTS,
} from "../src/arena.js";
import { config } from "../src/config.js";
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
  const bounds = config.ARENA_BOUNDS;

  printTable("CARD SLOTS (edit in src/layout.ts → CARD_SLOTS)", CARD_SLOTS, screen);
  printTable(
    "LEGACY PLACEMENT ZONES (kept as named shortcuts)",
    PLACEMENT_ZONES,
    screen,
  );

  console.log("\nARENA BOUNDS (edit ARENA_BOUNDS in .env as left,top,right,bottom)");
  console.log(
    `  left=${bounds.left} top=${bounds.top} right=${bounds.right} bottom=${bounds.bottom}`,
  );
  console.log(
    `  grid=${ARENA_COLS}x${ARENA_ROWS}  corners(px): ` +
      `TL=${JSON.stringify(tileToPixels({ x: 0, y: 0 }, screen))} ` +
      `TR=${JSON.stringify(tileToPixels({ x: ARENA_COLS - 1, y: 0 }, screen))} ` +
      `BL=${JSON.stringify(tileToPixels({ x: 0, y: ARENA_ROWS - 1 }, screen))} ` +
      `BR=${JSON.stringify(tileToPixels({ x: ARENA_COLS - 1, y: ARENA_ROWS - 1 }, screen))}`,
  );

  const corners = [
    { name: "arena_TL", ...tileToNormalized({ x: 0, y: 0 }) },
    { name: "arena_TR", ...tileToNormalized({ x: ARENA_COLS - 1, y: 0 }) },
    { name: "arena_BL", ...tileToNormalized({ x: 0, y: ARENA_ROWS - 1 }) },
    { name: "arena_BR", ...tileToNormalized({ x: ARENA_COLS - 1, y: ARENA_ROWS - 1 }) },
  ];

  const shortcutPoints: NamedPoint[] = Object.entries(TILE_SHORTCUTS).map(
    ([name, tile]) => ({
      name,
      description: `tile (${tile.x},${tile.y})`,
      ...tileToNormalized(tile),
    }),
  );

  const gridDots = sampleGridTiles(2)
    .map((tile) => {
      const { x, y } = tileToPixels(tile, screen);
      return `<circle cx="${x}" cy="${y}" r="4" fill="#f59e0b" fill-opacity="0.55"/>`;
    })
    .join("\n");

  const cornerMarks = corners
    .map((c) => {
      const { x, y } = toPixels(c, screen);
      return `
        <circle cx="${x}" cy="${y}" r="18" fill="#ef4444" fill-opacity="0.7" stroke="#fff" stroke-width="3"/>
        <text x="${x}" y="${y - 26}" text-anchor="middle" font-size="26" font-family="sans-serif" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">${escapeXml(c.name)}</text>
      `;
    })
    .join("\n");

  const slotMarks = CARD_SLOTS.map((slot) => {
    const { x, y } = toPixels(slot, screen);
    return `
      <circle cx="${x}" cy="${y}" r="28" fill="#22c55e" fill-opacity="0.45" stroke="#fff" stroke-width="3"/>
      <text x="${x}" y="${y - 36}" text-anchor="middle" font-size="28" font-family="sans-serif" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">${escapeXml(slot.name)}</text>
    `;
  }).join("\n");

  const shortcutMarks = shortcutPoints
    .map((point) => {
      const { x, y } = toPixels(point, screen);
      return `
        <circle cx="${x}" cy="${y}" r="14" fill="#3b82f6" fill-opacity="0.5" stroke="#fff" stroke-width="2"/>
        <text x="${x}" y="${y - 18}" text-anchor="middle" font-size="18" font-family="sans-serif" fill="#fff" stroke="#000" stroke-width="2" paint-order="stroke">${escapeXml(point.name)}</text>
      `;
    })
    .join("\n");

  // Arena rectangle outline
  const tl = tileToPixels({ x: 0, y: 0 }, screen);
  const br = tileToPixels({ x: ARENA_COLS - 1, y: ARENA_ROWS - 1 }, screen);
  const arenaRect = `
    <rect x="${tl.x}" y="${tl.y}" width="${br.x - tl.x}" height="${br.y - tl.y}"
      fill="none" stroke="#ef4444" stroke-width="4" stroke-dasharray="12 8"/>
  `;

  const svg = `
    <svg width="${screen.width}" height="${screen.height}" xmlns="http://www.w3.org/2000/svg">
      ${arenaRect}
      ${gridDots}
      ${shortcutMarks}
      ${cornerMarks}
      ${slotMarks}
      <text x="40" y="60" font-size="36" font-family="sans-serif" fill="#22c55e" stroke="#000" stroke-width="3" paint-order="stroke">green = card slots</text>
      <text x="40" y="110" font-size="36" font-family="sans-serif" fill="#ef4444" stroke="#000" stroke-width="3" paint-order="stroke">red = arena bounds / corners</text>
      <text x="40" y="160" font-size="36" font-family="sans-serif" fill="#f59e0b" stroke="#000" stroke-width="3" paint-order="stroke">orange = ${ARENA_COLS}x${ARENA_ROWS} grid (step 2)</text>
      <text x="40" y="210" font-size="36" font-family="sans-serif" fill="#3b82f6" stroke="#000" stroke-width="3" paint-order="stroke">blue = named tile shortcuts</text>
      <text x="40" y="260" font-size="28" font-family="sans-serif" fill="#fff" stroke="#000" stroke-width="2" paint-order="stroke">${screen.width}x${screen.height} ARENA_BOUNDS=${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}</text>
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
How to adjust:
  1. Open debug/calibration.png
  2. Green dots → CENTER of each hand card (edit src/layout.ts CARD_SLOTS)
  3. Red rectangle → should hug the playable arena (grass), not the UI
       Edit ARENA_BOUNDS=left,top,right,bottom in .env (normalized 0..1)
       too narrow left  → decrease left
       too high top     → decrease top
       too short bottom → increase bottom
  4. Re-run: npm run calibrate
  5. Smoke test: npm run test-launch -- card_2 left_bridge
     Or tile: npm run test-launch -- card_1 tile:9,22
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
