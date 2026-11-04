// End-to-end export check with the real engine: writes SVG + G-code to dev/screenshots/export/, parses each SVG
// with the browser's DOMParser and rasterizes it with Playwright.  Run: npx jiti dev/export-e2e.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { computeToolpath, prepare } from '../src/engine';
import { buildSVG } from '../src/export/svg';
import { buildGcode } from '../src/export/gcode';
import { fileBaseName } from '../src/export/filename';
import { DEFAULT_GCODE_OPTIONS, DEFAULT_SVG_OPTIONS } from '../src/export/types';
import { defaultRecipe } from '../src/state/recipe';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, 'screenshots/export');
mkdirSync(outDir, { recursive: true });

/** @typedef {{ id: string, recipe: any, outline?: boolean }} Case */

/** @type {Case[]} */
const cases = [];
cases.push({ id: 'default', recipe: defaultRecipe() });
{
  // Orientation probe: one eccentric division, offset 15 mm along +Y (work frame), colour cycle.
  const r = defaultRecipe();
  r.name = 'Orientation probe';
  r.seed = 4172;
  r.slide.passes = 9;
  r.slide.startRadius = 6;
  r.slide.endRadius = 22;
  r.eccentric = { enabled: true, offset: 15, angle: 90, divisions: 1, divisionStep: 0 };
  r.ink.colorMode = 'cycle';
  cases.push({ id: 'orientation', recipe: r, outline: true });
}
{
  const r = defaultRecipe();
  r.name = 'Eccentric rosace';
  r.mode = 'metal';
  r.slide.passes = 12;
  r.slide.startRadius = 10;
  r.slide.endRadius = 30;
  r.eccentric = { enabled: true, offset: 12, angle: 0, divisions: 6, divisionStep: 0 };
  cases.push({ id: 'metal-eccentric', recipe: r, outline: true });
}
{
  const r = defaultRecipe();
  r.name = 'Gradient';
  r.ink.colorMode = 'gradient';
  cases.push({ id: 'gradient', recipe: r });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
for (const c of cases) {
  const t0 = performance.now();
  const tp = computeToolpath(prepare(c.recipe));
  const t1 = performance.now();
  const svg = buildSVG(c.recipe, tp, { ...DEFAULT_SVG_OPTIONS, outline: !!c.outline });
  const t2 = performance.now();
  const gcode = buildGcode(c.recipe, tp, {
    ...DEFAULT_GCODE_OPTIONS,
    profile: c.recipe.mode === 'metal' ? 'cnc' : 'pen',
  });
  const t3 = performance.now();
  const svgPath = join(outDir, `${c.id}.svg`);
  writeFileSync(svgPath, svg);
  writeFileSync(join(outDir, `${c.id}.gcode`), gcode.text);

  let sx = 0;
  let sy = 0;
  for (let i = 0; i < tp.totalSamples; i++) {
    sx += tp.x[i];
    sy += tp.y[i];
  }
  // Real XML parse + layer/path count in the browser.
  const check = await page.evaluate((text) => {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const err = doc.querySelector('parsererror');
    const layers = [...doc.querySelectorAll('g')].filter(
      (g) => g.getAttributeNS('http://www.inkscape.org/namespaces/inkscape', 'groupmode') === 'layer',
    );
    return {
      error: err ? err.textContent : null,
      layers: layers.map((g) => g.getAttributeNS('http://www.inkscape.org/namespaces/inkscape', 'label')),
      paths: doc.querySelectorAll('path').length,
      width: doc.documentElement.getAttribute('width'),
    };
  }, svg);
  await page.setContent(
    `<html><body style="margin:0;background:#777"><img id="i" style="width:900px;height:900px;display:block" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`,
  );
  await page.waitForFunction(() => document.getElementById('i').complete);
  const png = join(outDir, `${c.id}.png`);
  await page.screenshot({ path: png });
  console.log(
    `${c.id} (${fileBaseName(c.recipe)}): ${tp.passes.length} passes, ${tp.totalSamples} samples, ` +
      `centroid (${(sx / tp.totalSamples).toFixed(2)}, ${(sy / tp.totalSamples).toFixed(2)}) | ` +
      `engine ${(t1 - t0).toFixed(0)} ms, svg ${(t2 - t1).toFixed(0)} ms ${(svg.length / 1024).toFixed(0)} KB, ` +
      `gcode ${(t3 - t2).toFixed(0)} ms ${gcode.stats.lines} lines ~${Math.round(gcode.stats.estimatedSeconds / 60)} min | ` +
      `parse ${check.error ? 'ERROR ' + check.error : 'ok'}, width ${check.width}, ${check.paths} paths, layers ${JSON.stringify(check.layers)}`,
  );
}
await browser.close();
console.log(`wrote ${outDir}`);
