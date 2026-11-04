// PNG export: thin validated wrapper around IRenderApp.renderPNG (the render module owns the GPU work).
import type { IRenderApp, PngOptions } from '../render/types';

/** Largest PNG edge we ask the renderer for, px. The renderer may cap lower (MAX_RENDERBUFFER_SIZE). */
export const MAX_PNG_SIZE = 16384;

/** Throws a RangeError unless width and height are integers in 1..MAX_PNG_SIZE. */
export function validatePngOptions(opts: PngOptions): void {
  for (const key of ['width', 'height'] as const) {
    const v = opts[key];
    if (!Number.isInteger(v) || v < 1 || v > MAX_PNG_SIZE) {
      throw new RangeError(`PNG ${key} must be an integer from 1 to ${MAX_PNG_SIZE} px (got ${v})`);
    }
  }
}

export async function exportPNG(app: IRenderApp, opts: PngOptions): Promise<Blob> {
  validatePngOptions(opts);
  return app.renderPNG({ width: opts.width, height: opts.height, transparent: !!opts.transparent });
}

/** Pixels for a physical size: round(mm / 25.4 × dpi), at least 1. Throws on non-positive input. */
export function pngSizeFromPhysical(mm: number, dpi: number): number {
  if (!(mm > 0) || !(dpi > 0) || !Number.isFinite(mm) || !Number.isFinite(dpi)) {
    throw new RangeError(`PNG size needs positive mm and dpi (got ${mm} mm at ${dpi} dpi)`);
  }
  return Math.max(1, Math.round((mm / 25.4) * dpi));
}
