// CONTRACT FILE — pass colour assignment shared by the ink renderer and the SVG exporter so they always agree.
import type { InkSettings } from './recipe';

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Colour of a pass. passIndex = global pass index (Pass.index), totalPasses = toolpath.passes.length. */
export function passColor(ink: InkSettings, passIndex: number, totalPasses: number): string {
  const pal = ink.palette.length ? ink.palette : ['#000000'];
  switch (ink.colorMode) {
    case 'single':
      return pal[0];
    case 'cycle':
      return pal[passIndex % pal.length];
    case 'gradient': {
      if (pal.length === 1 || totalPasses <= 1) return pal[0];
      const t = (passIndex / (totalPasses - 1)) * (pal.length - 1);
      const i = Math.min(pal.length - 2, Math.floor(t));
      const f = t - i;
      const a = hexToRgb(pal[i]);
      const b = hexToRgb(pal[i + 1]);
      return rgbToHex([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
    }
  }
}
