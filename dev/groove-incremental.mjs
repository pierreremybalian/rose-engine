// Incremental drawing check: reveal a preset in many small progress steps (each frame appends to the ink cache /
// redraws grooves; the 3D disc appends too), then compare with a full redraw at the same progress.
//   node dev/groove-incremental.mjs <preset> [mode] [zoom]
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const [id = 'barleycorn', mode = 'ink', zoom = '1'] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
await p.goto('http://127.0.0.1:5173/');
await p.waitForFunction(() => window.__rose);
await p.waitForTimeout(1200);
const res = await p.evaluate(async ([id, mode, zoom]) => {
  const { presetRecipe } = await import('/src/presets/index.ts');
  const { store, app } = window.__rose;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  store.set({ layout: 'work', tilt: { x: 0, y: 0 }, shimmer: false, frame: 'work' });
  const r = presetRecipe(id);
  r.mode = mode;
  store.setRecipe(r);
  await raf(); await raf();
  const total = app.toolpath.totalSamples;
  app.resetWorkView();
  if (zoom > 1) {
    const v = app.workView;
    v.mmPerPx /= zoom;
    v.cx = 0.3 * r.machine.workDiameter / 2;
    v.cy = 0.2 * r.machine.workDiameter / 2;
    v.fitted = false;
    v.updateCamera();
    v.onChange();
  }
  const target = Math.round(total * 0.37) + 0.37;
  // many uneven steps, some landing exactly on samples
  let s = 0;
  let k = 0;
  while (s < target) {
    s = Math.min(target, s + (k % 3 === 0 ? 517 : k % 3 === 1 ? 1203.6 : 88.25));
    k++;
    store.set({ playback: { ...store.get().playback, playing: false, progress: s } });
    await raf();
  }
  await raf(); await raf();
  const grab = () => {
    app.renderFrame();
    return app.gl.domElement.toDataURL('image/png');
  };
  const inc = grab();
  app.workDirty = 2;
  const full = grab();
  const load = async (u) => { const i = new Image(); i.src = u; await i.decode(); return i; };
  const A = await load(inc), B = await load(full);
  const c = document.createElement('canvas'); c.width = A.width; c.height = A.height;
  const x = c.getContext('2d');
  x.drawImage(A, 0, 0); const da = x.getImageData(0, 0, A.width, A.height).data;
  x.drawImage(B, 0, 0); const db = x.getImageData(0, 0, A.width, A.height).data;
  let big = 0, max = 0, sum = 0;
  for (let i = 0; i < da.length; i += 4) {
    const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
    sum += d; if (d > 8) big++; if (d > max) max = d;
  }
  return { steps: k, total, mean: +(sum / (A.width * A.height)).toFixed(4), over8: big, max, inc };
}, [id, mode, +zoom]);
writeFileSync(`dev/screenshots/grooves/incremental-${id}-${mode}-z${zoom}.png`, Buffer.from(res.inc.split(',')[1], 'base64'));
console.log(id, mode, `z${zoom}`, `steps ${res.steps}`, `incremental vs full redraw: mean |Δ| ${res.mean}, pixels >8: ${res.over8}, max ${res.max}`);
await b.close();
