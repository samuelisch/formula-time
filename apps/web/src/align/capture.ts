// Thin wrappers around media, canvas, the OCR worker, and localStorage --
// isolated from useAligner.ts so tests can stub every DOM/media/network
// touchpoint (`vi.mock` or a direct override) without mocking the whole
// hook. No policy here: this file only talks to the browser.
import type { OcrLine } from "./core.ts";
import { isValidCrop, type Crop } from "./policy.ts";

export interface OcrResult {
  text: string;
  lines: OcrLine[];
}

export interface OcrWorker {
  setParameters(params: Record<string, string>): Promise<void>;
  recognize(image: HTMLCanvasElement): Promise<{ data: OcrResult }>;
  terminate(): Promise<void>;
}

export interface TesseractModule {
  createWorker(lang: string): Promise<OcrWorker>;
}

/** Dynamic import so ordinary viewers never download tesseract.js (issue
 * #50: worker and core paths left at the library's CDN defaults). */
export async function loadTesseract(): Promise<TesseractModule> {
  return (await import("tesseract.js")) as unknown as TesseractModule;
}

export async function createOcrWorker(tesseract: TesseractModule): Promise<OcrWorker> {
  const worker = await tesseract.createWorker("eng");
  await worker.setParameters({ tessedit_char_whitelist: "LAP0123456789/ " });
  return worker;
}

/** Low frame rate: the pixel-diff gate keeps OCR rare regardless. */
export async function captureDisplayMedia(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 } });
}

const CROP_STORAGE_KEY = "align-crop";

/** One read decides whether to trust a remembered box -- it may be from
 * another window, resolution, or session (POC: isValidCrop). */
export function readStoredCrop(): Crop | null {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(CROP_STORAGE_KEY) ?? "null");
    return isValidCrop(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function writeStoredCrop(crop: Crop): void {
  try {
    localStorage.setItem(CROP_STORAGE_KEY, JSON.stringify(crop));
  } catch {
    /* cosmetic */
  }
}

export function clearStoredCrop(): void {
  try {
    localStorage.removeItem(CROP_STORAGE_KEY);
  } catch {
    /* cosmetic */
  }
}

/** Resizes `canvas` to (dw, dh) and draws the (sx, sy, sw, sh) region of
 * `source` into it. A no-op (never throws) when the canvas has no 2D
 * context, e.g. jsdom in tests. */
export function drawInto(
  canvas: HTMLCanvasElement,
  source: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): void {
  canvas.width = Math.max(1, Math.round(dw));
  canvas.height = Math.max(1, Math.round(dh));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
}

/** Reads back `canvas`'s current pixels. Returns an empty array (never
 * throws) when the canvas has no 2D context. */
export function readPixels(canvas: HTMLCanvasElement): Uint8ClampedArray {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return new Uint8ClampedArray(0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

/** Draws a rect outline into `canvas` (the crop overlay on the preview). */
export function strokeRect(canvas: HTMLCanvasElement, x: number, y: number, w: number, h: number, color: string): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
}
