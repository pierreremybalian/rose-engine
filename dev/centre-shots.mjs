// Screens random patterns that run into the centre (start radius 0), ink and metal, work view only.
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://127.0.0.1:5173/';
const want = Number(process.argv[3] || 8);
const mode = process.argv[4] || 'ink';
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu'] });
const p = await b.newPage({ viewport: { width: 1200, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto(url);
await p.waitForTimeout(3000);
await p.evaluate(() => window.__rose.store.set({ layout: 'work' }));
let shot = 0;
for (let seed = 1; shot < want && seed < 400; seed++) {
  const info = await p.evaluate(async ([seed, mode]) => {
    const { randomRecipe } = await import('/src/engine/random.ts');
    const { store } = window.__rose;
    const cur = { ...store.get().recipe, mode };
    const r = randomRecipe(seed, cur, ['mode']);
    if (r.slide.startRadius > 0) return null;
    store.setRecipe(r);
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const pb = store.get().playback;
    store.set({ playback: { ...pb, playing: false, progress: 1e12 } });
    await new Promise((res) => setTimeout(res, 400));
    return { seed, name: r.name, mode: r.mode, rosettes: r.rosettes.map((x) => `${x.axis}:${x.lobes}${x.profile[0]}@${x.amplitude.toFixed(2)}`).join(' '), spiral: r.slide.spiral, passes: r.slide.passes, taper: r.slide.amplitudeTaper };
  }, [seed, mode]);
  if (!info) continue;
  shot++;
  await p.screenshot({ path: `dev/screenshots/centre/${String(shot).padStart(2, '0')}-${info.mode}-s${seed}.png` });
  console.log(JSON.stringify(info));
}
console.log(errs.slice(0, 10).join('\n') || 'no console errors');
await b.close();
