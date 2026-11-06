// Frame-exact video of the opening pattern cutting. The page runs on a fake clock (requestAnimationFrame and
// performance.now are replaced), so every captured frame is exactly 1/FPS of app time apart regardless of how long
// a screenshot takes. Usage: node dev/record-video.mjs <framesDir> [url] [width] [height]
import { chromium } from 'playwright';
import fs from 'fs';
const dir = process.argv[2];
const url = process.argv[3] || 'http://127.0.0.1:5173/';
const W = Number(process.argv[4] || 1920), H = Number(process.argv[5] || 1080);
const FPS = 60, HOLD_START = 0.6, HOLD_END = 3.5;
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
await p.addInitScript(() => {
  let now = 1000, id = 0;
  const cbs = new Map();
  window.requestAnimationFrame = (cb) => (cbs.set(++id, cb), id);
  window.cancelAnimationFrame = (i) => cbs.delete(i);
  performance.now = () => now;
  window.__tick = (ms) => {
    now += ms;
    const list = [...cbs.values()];
    cbs.clear();
    for (const cb of list) cb(now);
  };
});
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(url);
await p.waitForFunction(() => window.__rose);
// Hold at the start: pause, let entrance animations finish in real time, render a few frames.
await p.evaluate(() => { const s = window.__rose.store; s.set({ playback: { ...s.get().playback, progress: 0, playing: false } }); });
await p.waitForTimeout(1500);
const step = () => p.evaluate((ms) => window.__tick(ms), 1000 / FPS);
for (let i = 0; i < 5; i++) await step();

let n = 0;
const shot = async () => { await step(); await p.screenshot({ path: `${dir}/f${String(n++).padStart(5, '0')}.jpg`, type: 'jpeg', quality: 94 }); };
for (let i = 0; i < HOLD_START * FPS; i++) await shot();
await p.evaluate(() => { const s = window.__rose.store; s.set({ playback: { ...s.get().playback, playing: true } }); });
const t0 = Date.now();
while (await p.evaluate(() => window.__rose.store.get().playback.playing)) {
  await shot();
  if (n % 300 === 0) console.log(`frame ${n} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
for (let i = 0; i < HOLD_END * FPS; i++) await shot();
console.log(`${n} frames (${(n / FPS).toFixed(1)}s of video)`, errs.length ? 'errors: ' + errs.join('; ') : 'no errors');
await b.close();
