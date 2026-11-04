// Prints where each pass of seed 1186653558 (metal) has sharp direction changes (kinks), to tell real
// geometry seams from render artifacts. Uses the running app at 5173 only to load the engine modules.
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5173/');
await page.waitForFunction(() => window.__rose && window.__rose.store);
const out = await page.evaluate(async () => {
  const { randomRecipe } = await import('/src/engine/random.ts');
  const eng = await import('/src/engine/index.ts');
  const cur = structuredClone(window.__rose.store.get().recipe); cur.mode = 'metal';
  const r = randomRecipe(1186653558, cur, []);
  const tp = eng.computeToolpath(eng.prepare(r));
  const rows = [];
  for (const pi of [99, 90, 75, 60, 45, 30, 15]) {
    const p = tp.passes[pi];
    const kinks = [];
    for (let i = 0; i < p.count; i++) {
      const a = p.start + ((i - 1 + p.count) % p.count), b = p.start + i, c = p.start + ((i + 1) % p.count);
      const t1 = Math.atan2(tp.y[b] - tp.y[a], tp.x[b] - tp.x[a]);
      const t2 = Math.atan2(tp.y[c] - tp.y[b], tp.x[c] - tp.x[b]);
      let d = Math.abs(t2 - t1); if (d > Math.PI) d = 2 * Math.PI - d;
      if (d > 0.12) kinks.push(`(${tp.x[b].toFixed(1)},${tp.y[b].toFixed(1)}) ${(d * 57.3).toFixed(0)}°`);
    }
    rows.push(`pass ${pi}: ${kinks.slice(0, 12).join('  ')}`);
  }
  return rows.join('\n');
});
console.log(out);
await browser.close();
