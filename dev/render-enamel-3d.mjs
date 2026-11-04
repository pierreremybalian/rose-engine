// Compiles/inspects the 3D-disc enamel variant in the running app (split layout); logs shader errors.
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errs.push(m.text()));
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(process.argv[2] ?? 'http://127.0.0.1:5173/');
await page.waitForFunction(() => window.__rose && window.__rose.store);
await page.waitForTimeout(1500);
await page.evaluate(async () => {
  const { randomRecipe } = await import('/src/engine/random.ts');
  const { store } = window.__rose;
  const cur = structuredClone(store.get().recipe); cur.mode = 'metal';
  const r = randomRecipe(1186653558, cur, []);
  store.set({ layout: 'split', camera: 'tool' });
  store.setRecipe(r);
});
await page.waitForTimeout(800);
await page.evaluate(() => { const { store } = window.__rose; store.set({ playback: { ...store.get().playback, playing: false, progress: 1e12 } }); });
await page.waitForTimeout(2500);
await page.screenshot({ path: 'dev/screenshots/render/live-enamel-split.png' });
console.log(errs.length ? errs.slice(0, 8).join('\n') : 'console: clean');
await browser.close();
