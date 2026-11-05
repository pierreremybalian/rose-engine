// Aspect independence of the flat metal shading: renderPNG at 2000×1000 and 1000×2000 share mm/px, so their
// central 1000×1000 squares show the same plate area and must match. Also flat (tilt 0) vs a 0.3° tilt.
//   node dev/groove-aspect.mjs [preset]
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const id = process.argv[2] || 'grain-d-orge';
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
await p.goto('http://127.0.0.1:5173/');
await p.waitForFunction(() => window.__rose);
await p.waitForTimeout(1200);
const res = await p.evaluate(async (id) => {
  const { presetRecipe } = await import('/src/presets/index.ts');
  const { store, app } = window.__rose;
  store.set({ layout: 'work', tilt: { x: 0, y: 0 }, shimmer: false });
  const r = presetRecipe(id);
  r.mode = 'metal';
  store.setRecipe(r);
  const raf = () => new Promise((res) => requestAnimationFrame(res));
  await raf(); await raf();
  store.set({ playback: { ...store.get().playback, playing: false, progress: 1e12 } });
  await raf();
  const toImg = async (blob) => {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const x = c.getContext('2d');
    x.drawImage(bmp, 0, 0);
    return { c, data: x.getImageData(0, 0, c.width, c.height) };
  };
  const wide = await toImg(await app.renderPNG({ width: 2000, height: 1000, transparent: false }));
  const tall = await toImg(await app.renderPNG({ width: 1000, height: 2000, transparent: false }));
  let sum = 0, big = 0, max = 0;
  for (let y = 0; y < 1000; y++) for (let x = 0; x < 1000; x++) {
    const i = ((y) * 2000 + (x + 500)) * 4;
    const j = ((y + 500) * 1000 + x) * 4;
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(wide.data.data[i + k] - tall.data.data[j + k]));
    sum += d; if (d > 8) big++; if (d > max) max = d;
  }
  const sheet = document.createElement('canvas');
  sheet.width = 2008; sheet.height = 1000;
  const sx = sheet.getContext('2d');
  sx.fillStyle = '#c00'; sx.fillRect(0, 0, 2008, 1000);
  sx.drawImage(wide.c, 500, 0, 1000, 1000, 0, 0, 1000, 1000);
  sx.drawImage(tall.c, 0, 500, 1000, 1000, 1008, 0, 1000, 1000);
  return { mean: +(sum / 1e6).toFixed(3), over8pct: +(big / 1e4).toFixed(3), max, url: sheet.toDataURL('image/png') };
}, id);
writeFileSync(`dev/screenshots/grooves/aspect-${id}.png`, Buffer.from(res.url.split(',')[1], 'base64'));
console.log(id, 'wide vs tall centre square: mean |Δ|', res.mean, ' >8:', res.over8pct + '%', ' max', res.max);
await b.close();
