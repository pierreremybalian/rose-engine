// Screens every built-in preset, finished, in the work view.
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://127.0.0.1:5173/';
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu'] });
const p = await b.newPage({ viewport: { width: 1200, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
await p.goto(url);
await p.waitForTimeout(3000);
await p.evaluate(() => window.__rose.store.set({ layout: 'work' }));
const ids = await p.evaluate(async () => (await import('/src/presets/index.ts')).PRESETS.map((x) => x.id));
for (const id of ids) {
  await p.evaluate(async (id) => {
    const { presetRecipe } = await import('/src/presets/index.ts');
    const { store } = window.__rose;
    store.setRecipe(presetRecipe(id));
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    store.set({ playback: { ...store.get().playback, playing: false, progress: 1e12 } });
    await new Promise((res) => setTimeout(res, 400));
  }, id);
  await p.screenshot({ path: `dev/screenshots/centre/preset-${id}.png`, clip: { x: 360, y: 56, width: 840, height: 776 } });
}
console.log(ids.join(' '), errs.join('\n') || 'no errors');
await b.close();
