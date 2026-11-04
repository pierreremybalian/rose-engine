// Visual check, skipped unless PREVIEW is set:
//   PREVIEW=1 npx vitest run tests/engine/preview.test.ts
// Writes SVG + PNG files to dev/screenshots/engine/.
import { describe, it } from 'vitest';
import { PREVIEW_CASES, renderCase } from '../../dev/engine-preview';

// No @types/node in this project: reach Node APIs untyped.
const env: Record<string, string | undefined> =
  (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const enabled = !!env.PREVIEW;

describe.skipIf(!enabled)('engine preview', () => {
  it('renders preview PNGs', async () => {
    const { chromium } = await import('playwright');
    const fsName = 'node:fs';
    const fs = (await import(/* @vite-ignore */ fsName)) as {
      mkdirSync(p: string, o: { recursive: boolean }): void;
      writeFileSync(p: string, data: string): void;
    };
    const out = decodeURIComponent(new URL('../../dev/screenshots/engine', import.meta.url).pathname);
    fs.mkdirSync(out, { recursive: true });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1400 } });
      const only = env.PREVIEW_ONLY;
      for (const c of PREVIEW_CASES) {
        if (only && !c.name.includes(only)) continue;
        const { full, zoom, stats } = renderCase(c);
        console.log(stats);
        const shots: [string, string, number][] = [[c.name, full, 1400]];
        if (zoom) shots.push([`${c.name}-zoom`, zoom, 1000]);
        for (const [name, svg, px] of shots) {
          fs.writeFileSync(`${out}/${name}.svg`, svg);
          await page.setViewportSize({ width: px, height: px });
          await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
          await page.screenshot({ path: `${out}/${name}.png`, clip: { x: 0, y: 0, width: px, height: px } });
        }
      }
    } finally {
      await browser.close();
    }
  }, 120_000);
});
