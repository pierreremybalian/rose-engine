// Repro a random recipe by seed (+ optional locked passes): node dev/qa-repro.mjs <seed> [passes] [name]
import { launch, rects, shot, state } from './qa-lib.mjs';
const [seed, passes, name = 'repro'] = process.argv.slice(2);
const { browser, page, log } = await launch({});
await page.waitForTimeout(800);
const info = await page.evaluate(async ({ seed, passes }) => {
  const { randomRecipe } = await import('/src/engine/random.ts');
  const st = window.__rose.store;
  const cur = structuredClone(st.get().recipe);
  const locks = [];
  if (passes) { cur.slide.passes = Number(passes); locks.push('slide.passes'); }
  const r = randomRecipe(Number(seed), cur, locks);
  st.set({ playback: { ...st.get().playback, speed: 0 } });
  st.setRecipe(r);
  return r;
}, { seed, passes });
await page.waitForTimeout(300);
await page.click('[data-action="play"]');
await page.waitForTimeout(800);
const s = await state(page);
console.log(JSON.stringify({ ...info, toolpath: await page.evaluate(() => { const t = window.__rose.app.toolpath; return { total: t.totalSamples, passes: t.passes.length, spr: t.samplesPerRev, closed: t.passes[0]?.closed }; }) }, null, 1));
await page.click('header [aria-label="Work only"]');
await page.waitForTimeout(800);
await shot(page, `repro-${name}`, (await rects(page)).work);
console.log(log.join('\n') || 'console clean');
await browser.close();
