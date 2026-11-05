// One view of a preset (+ patch) at zoom z centred on work point (x, y), optional tilt and frame.
//   node dev/groove-spot.mjs <out> <preset> <z> <x> <y> [patchJSON] [extraJSON: {tilt, frame, progress, mode}]
import { chromium } from 'playwright';
const [out, id, z, x, y, patch = '{}', extra = '{}'] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errs.push(m.text()));
await p.goto('http://127.0.0.1:5173/');
await p.waitForFunction(() => window.__rose);
await p.waitForTimeout(1200);
await p.evaluate(async ([id, z, x0, y0, patch, extra]) => {
  let x = x0;
  let y = y0;
  const { presetRecipe } = await import('/src/presets/index.ts');
  const { store, app } = window.__rose;
  store.set({ layout: 'work', shimmer: false, tilt: { x: 0, y: 0 }, frame: extra.frame ?? 'work' });
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
  store.set({ playback: { ...store.get().playback, playing: false, progress: extra.progress != null ? Math.round(total * extra.progress) : 1e12 } });
  app.resetWorkView();
  const v = app.workView;
  if (extra.atTool) {
    // centre on the tool point (work frame) at this progress
    const { pointAtSample } = await import('/src/render/strokeMesh.ts');
    const q = { x: 0, y: 0 };
    pointAtSample(app.toolpath, app.passStart, store.get().playback.progress, q);
    x = q.x;
    y = q.y;
  }
  if (z > 1) {
    v.mmPerPx /= z;
    v.cx = x;
    v.cy = y;
    v.fitted = false;
    v.updateCamera();
    v.onChange();
  }
  if (extra.tilt) store.set({ tilt: extra.tilt });
}, [id, +z, +x, +y, JSON.parse(patch), JSON.parse(extra)]);
await p.waitForTimeout(700);
const r = await p.evaluate(() => document.querySelector('.rose-work-view').getBoundingClientRect().toJSON());
await p.screenshot({ path: `dev/screenshots/grooves/${out}.png`, clip: { x: r.x, y: r.y, width: r.width, height: r.height } });
if (errs.length) console.log(errs.join('\n'));
await b.close();
