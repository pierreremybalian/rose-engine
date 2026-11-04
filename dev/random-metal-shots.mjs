// Metal coverage check through the real RenderApp (dev/render.html).
//   npx vite --port 5175 --strictPort   (in another shell)
//   node dev/random-metal-shots.mjs [preset ids...]   default: the metal presets + 4 random metal seeds
// Output: dev/screenshots/random/metal-<name>.png (+ a 4× zoom crop of the centre-right of the dial)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:5175/dev/render.html';
const OUT = 'dev/screenshots/random';
mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const presets = args.length ? args : ['basket-weave', 'sunray', 'cartouche', 'enamel-dial', 'blued-flame'];
const seeds = args.length ? [] : [3, 8, 11, 19];

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const errors = [];

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${BASE}?${query}`);
  await page.waitForFunction(() => window.__rose && window.__rose.toolpath, null, { timeout: 60000 });
  await page.waitForTimeout(1200);
  return page;
}

async function snap(page, name) {
  await page.screenshot({ path: `${OUT}/metal-${name}.png` });
  // Zoomed detail: does the surface read as touching grooves?
  const box = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.screenshot({
    path: `${OUT}/metal-${name}-detail.png`,
    clip: { x: box.x + box.w * 0.62, y: box.y + box.h * 0.42, width: Math.min(220, box.w * 0.25), height: Math.min(220, box.h * 0.25) },
    scale: 'device',
  });
  console.log('saved', `${OUT}/metal-${name}.png`);
}

for (const id of presets) {
  const page = await open(`layout=work&preset=${id}&mode=metal`);
  await snap(page, id);
  await page.close();
}
for (const seed of seeds) {
  const page = await open('layout=work&mode=metal');
  await page.evaluate(async (s) => {
    const m = await import('/src/engine/random.ts');
    const { store } = window.__rose;
    store.setRecipe(m.randomRecipe(s, { ...store.get().recipe, mode: 'metal' }, []));
  }, seed);
  await page.waitForTimeout(1500);
  await snap(page, `seed-${seed}`);
  await page.close();
}
await browser.close();
if (errors.length) console.log('errors:\n' + errors.slice(0, 10).join('\n'));
