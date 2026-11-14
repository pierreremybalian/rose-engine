// Screens the straight-line / circular presets, finished, in the work view (plus an ink variant and a zoom).
//   node dev/new-preset-shots.mjs <outDir> [ids...]
import { chromium } from 'playwright';
const out = process.argv[2];
const only = process.argv.slice(3);
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1200, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => m.type() === 'error' && errs.push('console: ' + m.text()));
await p.goto('http://127.0.0.1:5173/');
await p.waitForFunction(() => window.__rose);
await p.waitForTimeout(2500);
await p.evaluate(() => window.__rose.store.set({ layout: 'work', shimmer: false }));
const ids = only.length ? only : ['clous-de-paris', 'tapisserie', 'pinstripe', 'wave', 'ecailles-de-poisson', 'circular'];
for (const id of ids) {
  for (const mode of ['preset', 'ink', 'metal']) {
    await p.evaluate(async ([id, mode]) => {
      const { presetRecipe } = await import('/src/presets/index.ts');
      const { store } = window.__rose;
      const r = presetRecipe(id);
      if (mode !== 'preset') r.mode = mode;
      store.set({ tilt: { x: 0, y: 0 }, shimmer: false });
      store.setRecipe(r);
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      store.set({ playback: { ...store.get().playback, playing: false, progress: 1e12 } });
      await new Promise((res) => setTimeout(res, 700));
    }, [id, mode]);
    await p.screenshot({ path: `${out}/${id}-${mode}.png`, clip: { x: 360, y: 56, width: 840, height: 776 } });
  }
}
console.log(errs.join('\n') || 'no errors');
await b.close();
