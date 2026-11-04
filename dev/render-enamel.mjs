// Enamel look check against the running app (does not start/stop servers).
//   node dev/render-enamel.mjs [url]   → dev/screenshots/render/enamel-<metal>-<hue>.png (+ a contact sheet)
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL = process.argv[2] ?? 'http://127.0.0.1:5173/';
const OUT = 'dev/screenshots/render';
mkdirSync(OUT, { recursive: true });
const SEED = 1186653558;
const HUES = { teal: '#1fb5ad', blue: '#1b3fa0', red: '#b0202e', green: '#1f8a3a', purple: '#6a2a9a' };
const METALS = ['silver', 'gold'];
const only = process.argv[3]; // optional "teal" etc.

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(m.text()));
await page.goto(URL);
await page.waitForFunction(() => window.__rose && window.__rose.store, null, { timeout: 30000 });
await page.waitForTimeout(1500);

await page.evaluate(async (seed) => {
  const { randomRecipe } = await import('/src/engine/random.ts');
  const { store } = window.__rose;
  const cur = structuredClone(store.get().recipe);
  cur.mode = 'metal';
  const r = randomRecipe(seed, cur, []);
  r.mode = 'metal';
  store.set({ layout: 'work', frame: 'work' });
  store.setRecipe(r);
  const tp = window.__rose.app;
  void tp;
}, SEED);
await page.waitForTimeout(1500);
// reveal everything
await page.evaluate(() => {
  const { store } = window.__rose;
  store.set({ playback: { ...store.get().playback, playing: false, progress: 1e12 } });
});
await page.waitForTimeout(800);
const name = await page.evaluate(() => window.__rose.store.get().recipe.name);
console.log('recipe:', name);

const box = await page.locator('.rose-work-view').boundingBox();
const clip = { x: box.x + (box.width - box.height) / 2, y: box.y, width: box.height, height: box.height };
const files = [];
async function shot(file) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: file, clip });
  files.push(file);
  console.log('saved', file);
}

for (const metal of METALS) {
  await page.evaluate((m) => window.__rose.store.setRecipe((d) => { d.metal.material = m; d.metal.enamel = false; }), metal);
  await shot(`${OUT}/enamel-${metal}-bare.png`);
  for (const [hue, color] of Object.entries(HUES)) {
    if (only && hue !== only) continue;
    for (const op of [0.35, 0.6]) {
      await page.evaluate(([m, c, o]) => window.__rose.store.setRecipe((d) => {
        d.metal.material = m; d.metal.enamel = true; d.metal.enamelColor = c; d.metal.enamelOpacity = o;
      }), [metal, color, op]);
      await page.evaluate(() => {
        const { store } = window.__rose;
        store.set({ playback: { ...store.get().playback, playing: false, progress: 1e12 } });
      });
      await shot(`${OUT}/enamel-${metal}-${hue}-${Math.round(op * 100)}.png`);
    }
  }
}

// contact sheet
const sheet = `<html><body style="margin:0;background:#111;display:grid;grid-template-columns:repeat(6,1fr);gap:2px">${files
  .map((f) => `<div style="position:relative"><img src="file://${process.cwd()}/${f}" style="width:100%;display:block"><span style="position:absolute;left:4px;top:2px;color:#fff;font:11px sans-serif;text-shadow:0 0 3px #000">${f.split('/').pop().replace('.png', '').replace('enamel-', '')}</span></div>`)
  .join('')}</body></html>`;
writeFileSync('/private/tmp/claude-502/-Users-pierre-Code-rose-engine/6ca9f681-deec-4446-8c3b-265071b6c838/scratchpad/enamel-sheet.html', sheet);
const sp = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
await sp.goto('file:///private/tmp/claude-502/-Users-pierre-Code-rose-engine/6ca9f681-deec-4446-8c3b-265071b6c838/scratchpad/enamel-sheet.html');
await sp.waitForTimeout(500);
await sp.screenshot({ path: `${OUT}/enamel-sheet.png`, fullPage: true });
console.log('saved', `${OUT}/enamel-sheet.png`);
await browser.close();
const rel = errors.filter((e) => !/DevTools|favicon/.test(e));
console.log(rel.length ? 'console problems:\n' + [...new Set(rel)].slice(0, 10).join('\n') : 'console: clean');
