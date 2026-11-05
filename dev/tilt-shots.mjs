// Tilt QA: before/after flat-view captures, tilted shots, shimmer frame timing.
// node dev/tilt-shots.mjs before   → canvas captures of the flat view (run before the tilt change)
// node dev/tilt-shots.mjs after    → same captures at tilt 0 + diff, tilted shots, mobile, timing
import { chromium } from 'playwright';
import fs from 'node:fs';
import zlib from 'node:zlib';

const MODE = process.argv[2] || 'after';
const URL = process.argv[3] || 'http://127.0.0.1:5173/';
const OUT = 'dev/screenshots/tilt';
const RECIPES = `${OUT}/recipes.json`;
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu'] });
const errors = [];

async function open(viewport = { width: 1440, height: 900 }, opts = {}) {
  const ctx = await browser.newContext({ viewport, ...opts });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.addInitScript(() => {
    // live WebGL object counts, to catch leaks
    const live = { texture: 0, framebuffer: 0, renderbuffer: 0 };
    window.__glLive = live;
    const P = WebGL2RenderingContext.prototype;
    for (const k of Object.keys(live)) {
      const cap = k[0].toUpperCase() + k.slice(1);
      const cr = P['create' + cap];
      const de = P['delete' + cap];
      P['create' + cap] = function (...a) { const o = cr.apply(this, a); if (o) live[k]++; return o; };
      P['delete' + cap] = function (o) { if (o) live[k]--; return de.call(this, o); };
    }
  });
  await page.goto(URL);
  await page.waitForFunction(() => window.__rose);
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const { store } = window.__rose;
    store.set({ layout: 'work', playback: { ...store.get().playback, playing: false } });
  });
  return { ctx, page };
}

async function load(page, recipe, extra = {}) {
  await page.evaluate(async ({ recipe, extra }) => {
    const { store } = window.__rose;
    store.setRecipe(recipe);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    store.set({ ...extra, playback: { ...store.get().playback, playing: false, progress: 1e12 } });
    await new Promise((r) => setTimeout(r, 500));
  }, { recipe, extra });
}

/** Exact flat-view pixels: render synchronously and read the drawing buffer before it is presented. */
async function grab(page, path) {
  const url = await page.evaluate(() => {
    const { app } = window.__rose;
    app.renderFrame();
    return app.gl.domElement.toDataURL('image/png');
  });
  fs.writeFileSync(path, Buffer.from(url.split(',')[1], 'base64'));
}

async function getRecipes(page) {
  if (fs.existsSync(RECIPES)) return JSON.parse(fs.readFileSync(RECIPES, 'utf8'));
  const r = await page.evaluate(async () => {
    const { presetRecipe } = await import('/src/presets/index.ts');
    const b = presetRecipe('barleycorn');
    return { barleycornMetal: { ...b, mode: 'metal' }, barleycornInk: b, enamel: presetRecipe('enamel-dial') };
  });
  fs.writeFileSync(RECIPES, JSON.stringify(r));
  return r;
}

const CASES = [
  ['barleycorn-metal', 'barleycornMetal', 1],
  ['enamel-dial', 'enamel', 1],
  ['barleycorn-ink', 'barleycornInk', 1],
  ['barleycorn-metal-zoom6', 'barleycornMetal', 6],
];

async function flatCaptures(page, R, suffix) {
  for (const [name, key, zoom] of CASES) {
    await load(page, R[key]);
    await page.evaluate((z) => {
      const { app } = window.__rose;
      app.resetWorkView();
      if (z !== 1) app.workView.zoom(z, app.workView.width * 0.62, app.workView.height * 0.4);
    }, zoom);
    await page.waitForTimeout(200);
    await grab(page, `${OUT}/${suffix}-${name}.png`);
  }
}

if (MODE === 'before') {
  const { page, ctx } = await open();
  const R = await getRecipes(page);
  await flatCaptures(page, R, 'before');
  await ctx.close();
} else {
  // imported lazily so `before` runs with no extra deps
  const { runAfter } = await import('./tilt-after.mjs');
  await runAfter({ open, load, grab, getRecipes, flatCaptures, OUT, errors, browser, zlib, fs });
}
console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close();
