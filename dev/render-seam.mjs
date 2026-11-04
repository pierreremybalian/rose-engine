import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://127.0.0.1:5173/');
await page.waitForFunction(() => window.__rose && window.__rose.store);
await page.waitForTimeout(1500);
const info = await page.evaluate(async () => {
  const { randomRecipe } = await import('/src/engine/random.ts');
  const eng = await import('/src/engine/index.ts');
  const { store } = window.__rose;
  const cur = structuredClone(store.get().recipe); cur.mode = 'metal';
  const r = randomRecipe(1186653558, cur, []);
  store.set({ layout: 'work', frame: 'work' });
  store.setRecipe(r);
  const tp = eng.computeToolpath(eng.prepare(r));
  return { rosettes: r.rosettes, slide: r.slide, ecc: r.eccentric, ell: r.elliptical, metal: r.metal,
    passes: tp.passes.length, spr: tp.samplesPerRev, first: tp.passes.slice(0, 3), closed: tp.passes.every(p => p.closed) };
});
console.log(JSON.stringify(info, null, 1));
await page.evaluate(() => { const { store } = window.__rose; store.set({ playback: { ...store.get().playback, playing: false, progress: 1e12 } }); });
await page.waitForTimeout(800);
const box = await page.locator('.rose-work-view').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const R = await page.evaluate(() => 50 / window.__rose.app.workView.mmPerPx);
console.log('R px', R);
// seam point in crop coords relative to centre: (164, 52) of R=355
const px = cx + 164 / 355 * R, py = cy + 47 / 355 * R;
await page.evaluate(([x, y, bx, by]) => window.__rose.app.workView.zoom(1, x - bx, y - by), [px, py, box.x, box.y]);
await page.waitForTimeout(600);
await page.screenshot({ path: 'dev/screenshots/render/live-enamel.png', clip: { x: box.x + (box.width - box.height) / 2, y: box.y, width: box.height, height: box.height } });
// ink mode at same view
await page.evaluate(() => window.__rose.store.setRecipe((d) => { d.mode = 'ink'; }));
await page.evaluate(() => { const { store } = window.__rose; store.set({ playback: { ...store.get().playback, playing: false, progress: 1e12 } }); });
await page.waitForTimeout(800);
await page.screenshot({ path: 'dev/screenshots/render/live-enamel-ink.png', clip: { x: box.x + (box.width - box.height) / 2, y: box.y, width: box.height, height: box.height } });
await browser.close();
