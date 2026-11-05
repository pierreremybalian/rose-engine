// 3D machine view of a preset (the 4096² disc surface), and a mid-playback zoom on the tool.
//   node dev/groove-3d.mjs <out> <preset> [patchJSON] [camera] [progress]
import { chromium } from 'playwright';
const [out, id, patch = '{}', camera = 'work', progress = '1'] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errs.push(m.text()));
await p.goto('http://127.0.0.1:5173/');
await p.waitForFunction(() => window.__rose);
await p.waitForTimeout(1200);
await p.evaluate(async ([id, patch, camera, progress]) => {
  const { presetRecipe } = await import('/src/presets/index.ts');
  const { store, app } = window.__rose;
  store.set({ layout: 'machine', shimmer: false, tilt: { x: 0, y: 0 }, camera });
  const r = presetRecipe(id);
  for (const [k, v] of Object.entries(patch)) {
    const path = k.split('.');
    let o = r;
    for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
    o[path[path.length - 1]] = v;
  }
  store.setRecipe(r);
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  const total = app.toolpath.totalSamples;
  store.set({ playback: { ...store.get().playback, playing: false, progress: Math.round(total * progress) } });
}, [id, JSON.parse(patch), camera, +progress]);
await p.waitForTimeout(2500);
const r = await p.evaluate(() => document.querySelector('.rose-machine-view').getBoundingClientRect().toJSON());
await p.screenshot({ path: `dev/screenshots/grooves/${out}.png`, clip: { x: r.x, y: r.y, width: r.width, height: r.height } });
if (errs.length) console.log(errs.join('\n'));
await b.close();
