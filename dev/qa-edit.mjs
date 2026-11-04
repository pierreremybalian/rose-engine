// QA: slider drag, undo/redo, locks + Random 5x, Mutate, rosettes (incl. pump), chucks, every preset.
import { launch, readout, rects, shot, state, pause, waitStopped } from './qa-lib.mjs';

const url = process.argv[2] || 'http://127.0.0.1:5173/';
const tag = process.argv[3] || 'dev';
const { browser, page, log, setSection } = await launch({ url });
const res = {};
const sha = async (buf) => (await import('node:crypto')).createHash('sha1').update(buf).digest('hex').slice(0, 10);
await page.waitForTimeout(1000);
await pause(page);
await page.selectOption('[data-action="speed"]', '4');

// ---- slider drag (paused): pattern rebuilds and shows complete
setSection('slider');
const field = '[data-field="slide.passes"]';
const range = `${field} input[type="range"]`;
await page.locator(range).scrollIntoViewIfNeeded();
const box = await page.locator(range).boundingBox();
const before = (await state(page)).recipe.slide.passes;
await page.mouse.move(box.x + box.width * 0.13, box.y + box.height / 2);
await page.mouse.down();
const mids = [];
for (let i = 1; i <= 6; i++) {
  await page.mouse.move(box.x + box.width * (0.13 + i * 0.04), box.y + box.height / 2, { steps: 2 });
  await page.waitForTimeout(80);
  const s = await state(page);
  mids.push({ passes: s.recipe.slide.passes, progress: Math.round(s.playback.progress), total: await page.evaluate(() => window.__rose.app.toolpath?.totalSamples) });
}
await page.mouse.up();
await page.waitForTimeout(300);
const after = await state(page);
const tot = await page.evaluate(() => window.__rose.app.toolpath.totalSamples);
res.slider = { before, after: after.recipe.slide.passes, playing: after.playback.playing, progressIsTotal: after.playback.progress === tot, readout: await readout(page), mids };
await shot(page, `${tag}-10-slider`);

// ---- undo / redo (one drag = one step)
setSection('undo');
await page.click('[data-action="undo"]');
await page.waitForTimeout(200);
const u = (await state(page)).recipe.slide.passes;
await page.click('[data-action="redo"]');
await page.waitForTimeout(200);
const rd = (await state(page)).recipe.slide.passes;
await page.keyboard.press('Meta+z');
await page.waitForTimeout(100);
const uk = (await state(page)).recipe.slide.passes;
await page.keyboard.press('Meta+Shift+z');
await page.waitForTimeout(100);
res.undo = { undo: u, redo: rd, kbUndo: uk, kbRedo: (await state(page)).recipe.slide.passes };

// ---- lock + Random x5
setSection('random');
await page.click('[data-lock="slide.passes"]');
const locked = (await state(page)).recipe.slide.passes;
const rc = await rects(page);
const rnd = [];
for (let i = 0; i < 5; i++) {
  await page.click('[data-action="random"]');
  await page.waitForTimeout(150);
  await page.selectOption('[data-action="speed"]', '0'); // finish instantly for a full-pattern shot
  await page.click('[data-action="play"]');
  await page.waitForTimeout(500);
  const s = await state(page);
  const img = await page.screenshot({ clip: rc.work });
  await shot(page, `${tag}-11-random-${i + 1}`, rc.work);
  rnd.push({ seed: s.recipe.seed, name: s.recipe.name, passes: s.recipe.slide.passes, mode: s.recipe.mode, total: await page.evaluate(() => window.__rose.app.toolpath.totalSamples), img: await sha(img) });
  await page.selectOption('[data-action="speed"]', '4');
}
res.random = { locked, locks: (await state(page)).locks, runs: rnd, distinct: new Set(rnd.map((r) => r.img)).size, lockHeld: rnd.every((r) => r.passes === locked) };
await page.click('[data-lock="slide.passes"]');

// ---- mutate
setSection('mutate');
const pre = JSON.stringify((await state(page)).recipe);
await page.click('[data-action="mutate"]');
await page.waitForTimeout(400);
const post = (await state(page)).recipe;
res.mutate = { changed: pre !== JSON.stringify(post), playing: (await state(page)).playback.playing };
await page.click('[data-action="undo"]');
await page.waitForTimeout(200);
res.mutate.undoRestores = pre === JSON.stringify((await state(page)).recipe);

// ---- rosettes: add, make pump (advanced), remove
setSection('rosettes');
await pause(page);
await page.click('header button[data-value="advanced"]');
const n0 = (await state(page)).recipe.rosettes.length;
await page.click('[data-action="add-rosette"]');
await page.waitForTimeout(300);
const s1 = await state(page);
const newId = s1.recipe.rosettes.at(-1).id;
await page.selectOption(`[data-rosette="${newId}"] [data-field="axis"] select`, 'pump').catch(async (e) => {
  res.pumpSelectError = e.message.split('\n')[0];
});
await page.waitForTimeout(500);
const s2 = await state(page);
res.rosettes = { before: n0, afterAdd: s1.recipe.rosettes.length, axis: s2.recipe.rosettes.at(-1).axis };
await page.click('footer button[data-value="rosette"]');
await page.waitForTimeout(1200);
await page.click('[data-action="play"]');
await page.waitForTimeout(800);
await shot(page, `${tag}-12-pump-rosette`);
await pause(page);
await page.click(`[data-rosette="${newId}"] [aria-label^="Remove"]`);
await page.waitForTimeout(400);
res.rosettes.afterRemove = (await state(page)).recipe.rosettes.length;
await page.click('footer button[data-value="overview"]');

// ---- chucks
setSection('chucks');
for (const g of ['eccentric', 'elliptical']) {
  const sw = `section[data-group="${g}"] [role="switch"]`;
  try {
    await page.locator(sw).scrollIntoViewIfNeeded({ timeout: 5000 });
  } catch (e) {
    await shot(page, `${tag}-13-${g}-FAIL`);
    res[g + 'Fail'] = await page.evaluate((g) => { const sec = document.querySelector(`section[data-group="${g}"]`); return { hidden: sec?.hidden, html: sec?.outerHTML.slice(0, 300), uiMode: window.__rose.store.get().uiMode, n: document.querySelectorAll(`section[data-group="${g}"]`).length }; }, g);
    console.log(JSON.stringify(res[g + 'Fail']));
    continue;
  }
  await page.click(sw);
  await page.waitForTimeout(150);
  await page.selectOption('[data-action="speed"]', '0');
  await page.click('[data-action="play"]');
  await page.waitForTimeout(900);
  const s = await state(page);
  res[g] = { enabled: s.recipe[g].enabled, total: await page.evaluate(() => window.__rose.app.toolpath.totalSamples), passes: await readout(page) };
  await shot(page, `${tag}-13-${g}`);
  await page.click(sw);
  await page.waitForTimeout(300);
  await page.selectOption('[data-action="speed"]', '4');
}

// ---- every preset
setSection('presets');
const ids = await page.$$eval('[data-preset]', (els) => els.map((e) => e.dataset.preset));
res.presets = [];
for (const id of ids) {
  await page.click('[data-action="presets"]');
  await page.click(`[data-preset="${id}"]`);
  await page.waitForTimeout(200);
  await page.selectOption('[data-action="speed"]', '0');
  await page.click('[data-action="play"]');
  await page.waitForTimeout(700);
  const s = await state(page);
  const t = await page.evaluate(() => window.__rose.app.toolpath.totalSamples);
  res.presets.push({ id, name: s.recipe.name, mode: s.recipe.mode, total: t, done: s.playback.progress === t });
  await shot(page, `${tag}-14-preset-${id}`, (await rects(page)).work);
  await page.selectOption('[data-action="speed"]', '4');
}

console.log(JSON.stringify(res, null, 1));
console.log(log.length ? log.join('\n') : 'console: clean');
await browser.close();
