import { describe, expect, it, vi } from 'vitest';
import { exportPNG, MAX_PNG_SIZE, pngSizeFromPhysical } from '../../src/export/png';
import type { IRenderApp, PngOptions } from '../../src/render/types';

function fakeApp() {
  const renderPNG = vi.fn(async (o: PngOptions) => new Blob([`${o.width}x${o.height}`], { type: 'image/png' }));
  return { app: { renderPNG } as unknown as IRenderApp, renderPNG };
}

describe('exportPNG', () => {
  it('passes validated options to app.renderPNG and returns its blob', async () => {
    const { app, renderPNG } = fakeApp();
    const blob = await exportPNG(app, { width: 2048, height: 1024, transparent: true });
    expect(renderPNG).toHaveBeenCalledWith({ width: 2048, height: 1024, transparent: true });
    expect(blob.type).toBe('image/png');
    expect(await blob.text()).toBe('2048x1024');
    await exportPNG(app, { width: MAX_PNG_SIZE, height: 1, transparent: false });
  });

  it.each([
    [0, 100],
    [-5, 100],
    [100.5, 100],
    [100, NaN],
    [100, Infinity],
    [MAX_PNG_SIZE + 1, 100],
  ])('rejects %s × %s without rendering', async (width, height) => {
    const { app, renderPNG } = fakeApp();
    await expect(exportPNG(app, { width, height, transparent: false })).rejects.toThrow(RangeError);
    expect(renderPNG).not.toHaveBeenCalled();
  });
});

describe('pngSizeFromPhysical', () => {
  it('converts mm at dpi to whole pixels', () => {
    expect(pngSizeFromPhysical(25.4, 300)).toBe(300);
    expect(pngSizeFromPhysical(100, 300)).toBe(1181);
    expect(pngSizeFromPhysical(100, 96)).toBe(378);
    expect(pngSizeFromPhysical(0.01, 72)).toBe(1);
  });
  it('rejects non-positive input', () => {
    expect(() => pngSizeFromPhysical(0, 300)).toThrow(RangeError);
    expect(() => pngSizeFromPhysical(100, -1)).toThrow(RangeError);
    expect(() => pngSizeFromPhysical(NaN, 300)).toThrow(RangeError);
  });
});
