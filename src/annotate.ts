import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { PNG } from "pngjs";
import type { Action, BoundingBox, DomSnapshot } from "./types.js";

export async function annotateActionScreenshot(options: {
  screenshotPath: string;
  action: Action;
  resolvedNodeId?: string;
  resolvedBoundingBox?: BoundingBox;
  snapshot: DomSnapshot;
}): Promise<string | undefined> {
  const { screenshotPath, action, resolvedNodeId, resolvedBoundingBox, snapshot } = options;

  const node = resolvedNodeId ? snapshot.nodes.find((candidate) => candidate.id === resolvedNodeId) : undefined;
  const box = resolvedBoundingBox ?? node?.boundingBox;

  if (!box || box.width <= 0 || box.height <= 0) {
    return undefined;
  }

  const raw = await readFile(screenshotPath);
  const png = PNG.sync.read(raw);
  const color = colorForAction(action.type);

  drawBoundingBox(png, box, color);
  drawCenterMarker(png, box, color);

  const parsedExt = extname(screenshotPath);
  const annotatedPath = join(
    dirname(screenshotPath),
    `${basename(screenshotPath, parsedExt)}.annotated${parsedExt || ".png"}`
  );
  await writeFile(annotatedPath, PNG.sync.write(png));
  return annotatedPath;
}

function colorForAction(actionType: Action["type"]): [number, number, number, number] {
  if (actionType === "click") {
    return [236, 72, 153, 255];
  }
  if (actionType === "fill" || actionType === "select") {
    return [14, 116, 144, 255];
  }
  if (actionType === "assert") {
    return [22, 163, 74, 255];
  }
  if (actionType === "handleConsent") {
    return [202, 138, 4, 255];
  }
  return [59, 130, 246, 255];
}

function drawBoundingBox(
  png: PNG,
  box: BoundingBox,
  color: [number, number, number, number],
  thickness = 3
): void {
  const x0 = clamp(Math.floor(box.x), 0, png.width - 1);
  const y0 = clamp(Math.floor(box.y), 0, png.height - 1);
  const x1 = clamp(Math.floor(box.x + box.width), 0, png.width - 1);
  const y1 = clamp(Math.floor(box.y + box.height), 0, png.height - 1);

  for (let t = 0; t < thickness; t += 1) {
    horizontalLine(png, x0, x1, clamp(y0 + t, 0, png.height - 1), color);
    horizontalLine(png, x0, x1, clamp(y1 - t, 0, png.height - 1), color);
    verticalLine(png, clamp(x0 + t, 0, png.width - 1), y0, y1, color);
    verticalLine(png, clamp(x1 - t, 0, png.width - 1), y0, y1, color);
  }
}

function drawCenterMarker(png: PNG, box: BoundingBox, color: [number, number, number, number]): void {
  const centerX = clamp(Math.floor(box.x + box.width / 2), 0, png.width - 1);
  const centerY = clamp(Math.floor(box.y + box.height / 2), 0, png.height - 1);
  const radius = 6;

  for (let y = -radius; y <= radius; y += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      if (x * x + y * y > radius * radius) {
        continue;
      }
      const px = centerX + x;
      const py = centerY + y;
      if (px < 0 || py < 0 || px >= png.width || py >= png.height) {
        continue;
      }
      setPixel(png, px, py, color);
    }
  }
}

function horizontalLine(
  png: PNG,
  startX: number,
  endX: number,
  y: number,
  color: [number, number, number, number]
): void {
  for (let x = startX; x <= endX; x += 1) {
    setPixel(png, x, y, color);
  }
}

function verticalLine(
  png: PNG,
  x: number,
  startY: number,
  endY: number,
  color: [number, number, number, number]
): void {
  for (let y = startY; y <= endY; y += 1) {
    setPixel(png, x, y, color);
  }
}

function setPixel(png: PNG, x: number, y: number, color: [number, number, number, number]): void {
  const index = (png.width * y + x) * 4;
  png.data[index] = color[0];
  png.data[index + 1] = color[1];
  png.data[index + 2] = color[2];
  png.data[index + 3] = color[3];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
