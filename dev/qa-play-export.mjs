// QA: chucks with real values, playback (end, scrub, speeds, restart), exports through the dialog, share URL.
import { mkdirSync, readFileSync } from 'node:fs';
import { launch, readout, rects, shot, state, pause, waitStopped } from './qa-lib.mjs';

const url = process.argv[2] || 'http://127.0.0.1:5173/';
const tag = process.argv[3] || 'dev';
const DL = `dev/screenshots/qa/exports-${tag}`;
mkdirSync(DL, { recursive: true });
const { browser, context, page, log, setSection } = await launch({ url });
const res = {};
const tp = () => page.evaluate(() => { const t = window.__rose.app.toolpath; return { total: t.totalSamples, passes: t.passes.length }; });
const loadPreset = async (id) => {
  await page.click('[data-action="presets"]');
  await page.click(`[data-preset="${id}"]`);
  await page.waitForTimeout(250);
};
const setNum = async (key, v) => {
  const inp = page.locator(`[data-field="${key}"] input[type="number"]`);
  await inp.scrollIntoViewIfNeeded();
  await inp.fill(String(v));
  await inp.press('Enter');
  await inp.blur();
  await page.waitForTimeout(150);
};
await page.waitForTimeout(800);

// ---- chucks with values
setSection('chucks');
await page.click('header button[data-value="advanced"]');
await page.selectOption('[data-action="speed"]', '0');
await loadPreset('barleycorn');
const base = await tp();
await page.click('section[data-group="eccentric"] [role="switch"]');
await setNum('eccentric.offset', 12);
await setNum('eccentric.divisions', 6);
await page.click('[data-action="play"]');
await page.waitForTimeout(800);
const ecc = await tp();
res.eccentric = { base, ecc, recipe: (await state(page)).recipe.eccentric, readout: await readout(page) };
await shot(page, `${tag}-20-eccentric`);
await page.click('section[data-group="eccentric"] [role="switch"]');
await page.click('section[data-group="elliptical"] [role="switch"]');
await setNum('elliptical.e', 9);
await setNum('elliptical.angle', 30);
await page.click('[data-action="play"]');
await page.waitForTimeout(800);
res.elliptical = { tp: await tp(), recipe: (await state(page)).recipe.elliptical };
await shot(page, `${tag}-21-elliptical`);
await page.click('section[data-group="elliptical"] [role="switch"]');

// ---- playback
setSection('playback');
await page.selectOption('[data-action="speed"]', '200');
await loadPreset('barleycorn'); // autoplays at 200x
const t0 = Date.now();
await waitStopped(page, 60000);
const endS = await state(page);
const endT = await tp();
res.playEnd = { ms: Date.now() - t0, progress: endS.playback.progress, total: endT.total, readout: await readout(page), playLabel: await page.getAttribute('[data-action="play"]', 'aria-label') };
await shot(page, `${tag}-22-play-end`);
// scrub to 40%
const target = Math.round(endT.total * 0.4);
await page.evaluate((v) => {
  const el = document.querySelector('[data-action="scrub"]');
  el.value = String(v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, target);
await page.waitForTimeout(400);
const sc = await state(page);
res.scrub = { target, progress: sc.playback.progress, playing: sc.playback.playing, readout: await readout(page) };
await shot(page, `${tag}-23-scrub-40`);
// every speed
res.speeds = [];
const opts = await page.$$eval('[data-action="speed"] option', (o) => o.map((x) => x.value));
for (const v of opts) {
  await page.selectOption('[data-action="speed"]', v);
  await page.click('[data-action="restart"]');
  const a = (await state(page)).playback.progress;
  await page.waitForTimeout(600);
  const s = (await state(page)).playback;
  res.speeds.push({ speed: v, startedAt: Math.round(a), after600ms: Math.round(s.progress), playing: s.playing, storeSpeed: s.speed });
}
// restart mid-way
await page.selectOption('[data-action="speed"]', '4');
await page.click('[data-action="restart"]');
await page.waitForTimeout(700);
const before = (await state(page)).playback.progress;
await page.click('[data-action="restart"]');
await page.waitForTimeout(50);
const afterR = (await state(page)).playback;
res.restart = { before: Math.round(before), after: Math.round(afterR.progress), playing: afterR.playing };
// space toggles play
await page.click('#re-panel .re-plate', { position: { x: 5, y: 5 } }).catch(() => {});
await page.locator('body').press('Space');
await page.waitForTimeout(100);
res.spacePause = !(await state(page)).playback.playing;
await pause(page);

// ---- exports
setSection('export');
await page.selectOption('[data-action="speed"]', '0');
await loadPreset('rosace');
await page.waitForTimeout(400);
const recipe = (await state(page)).recipe;
const tpi = await tp();
const dl = async (tab, before) => {
  await page.click('[data-action="export"]');
  await page.click(`[data-tab="${tab}"]`);
  if (before) await before();
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('dialog [data-action="download"]')]);
  const path = `${DL}/${d.suggestedFilename()}`;
  await d.saveAs(path);
  await page.waitForTimeout(150);
  if (await page.evaluate(() => document.querySelector('dialog[open]'))) await page.click('dialog [data-action="close-dialog"]');
  return { path, name: d.suggestedFilename() };
};
// SVG
const svg = await dl('svg');
const svgText = readFileSync(svg.path, 'utf8');
res.svg = {
  file: svg.name,
  ...(await page.evaluate((t) => {
    const doc = new DOMParser().parseFromString(t, 'image/svg+xml');
    const err = doc.querySelector('parsererror');
    const root = doc.documentElement;
    const paths = doc.querySelectorAll('path');
    const layers = [...doc.querySelectorAll('g')].filter((g) => g.getAttribute('inkscape:groupmode') === 'layer' || g.getAttributeNS('http://www.inkscape.org/namespaces/inkscape', 'groupmode') === 'layer').length;
    const nan = /NaN|undefined|Infinity/.test(t);
    return { parseError: !!err, width: root.getAttribute('width'), height: root.getAttribute('height'), viewBox: root.getAttribute('viewBox'), paths: paths.length, layers, metadata: !!doc.querySelector('metadata'), nan, bytes: t.length };
  }, svgText)),
  passes: tpi.passes,
};
// PNG 2048
const png = await dl('png', () => page.click('dialog button[data-value="2048"]'));
const pngB64 = readFileSync(png.path).toString('base64');
res.png = { file: png.name, ...(await page.evaluate(async (b64) => {
  const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
  const bmp = await createImageBitmap(blob);
  return { width: bmp.width, height: bmp.height, bytes: blob.size };
}, pngB64)), requested: 2048 };
// PNG print size (100 mm @ 150 dpi = 591 px)
const png2 = await dl('png', async () => {
  await page.click('dialog button[data-value="print"]');
  const inputs = page.locator('dialog input[type="number"]');
  const mm = page.locator('dialog label:has-text("Print size") + div input');
  await mm.fill('100');
  await mm.press('Tab');
  const dpi = page.locator('dialog label:has-text("Resolution") + div input');
  await dpi.fill('150');
  await dpi.press('Tab');
});
res.png.print = await page.evaluate(async (b64) => {
  const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
  return { width: bmp.width, height: bmp.height, expected: Math.round((100 / 25.4) * 150) };
}, readFileSync(png2.path).toString('base64'));
// G-code
const gc = await dl('gcode');
const gtext = readFileSync(gc.path, 'utf8');
const lines = gtext.split('\n');
let maxR = 0, nan = 0, moves = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
for (const l of lines) {
  if (/NaN|undefined|Infinity/.test(l)) nan++;
  const mx = /X(-?[\d.]+)/.exec(l);
  const my = /Y(-?[\d.]+)/.exec(l);
  if (mx && my) {
    moves++;
    const x = +mx[1], y = +my[1];
    maxR = Math.max(maxR, Math.hypot(x, y));
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
}
res.gcode = { file: gc.name, lines: lines.length, moves, nan, maxR: +maxR.toFixed(3), workR: recipe.machine.workDiameter / 2, bounds: [minX, maxX, minY, maxY], head: lines.slice(0, 6) };
// Preset save -> load back
const pj = await dl('preset');
const saved = JSON.parse(readFileSync(pj.path, 'utf8'));
await page.selectOption('[data-action="speed"]', '0');
await loadPreset('flame'); // something different in between
await page.click('[data-action="export"]');
await page.click('[data-tab="preset"]');
await page.setInputFiles('dialog [data-action="load-preset-file"]', pj.path);
await page.waitForTimeout(600);
const loaded = (await state(page)).recipe;
const strip = (r) => JSON.stringify(r);
res.preset = { file: pj.name, version: saved.version, sameAsOriginal: strip(loaded) === strip(recipe), dialogClosed: !(await page.evaluate(() => !!document.querySelector('dialog[open]'))) };
if (!res.preset.sameAsOriginal) res.preset.diff = Object.keys(recipe).filter((k) => JSON.stringify(recipe[k]) !== JSON.stringify(loaded[k]));
if (await page.evaluate(() => document.querySelector('dialog[open]'))) await page.click('dialog [data-action="close-dialog"]');
// Share
await page.click('[data-action="share"]');
await page.waitForTimeout(500);
const link = await page.evaluate(() => navigator.clipboard.readText());
const p2 = await context.newPage();
const log2 = [];
p2.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log2.push(`[share-page] ${m.type()}: ${m.text()}`); });
p2.on('pageerror', (e) => log2.push('[share-page] pageerror: ' + e.message));
await p2.goto(link);
await p2.waitForFunction(() => window.__rose);
await p2.waitForTimeout(1500);
const shared = await p2.evaluate(() => window.__rose.store.get().recipe);
res.share = { link: link.slice(0, 80) + '…', length: link.length, same: strip(shared) === strip(loaded) };
if (!res.share.same) res.share.diff = Object.keys(loaded).filter((k) => JSON.stringify(loaded[k]) !== JSON.stringify(shared[k]));
await p2.screenshot({ path: `dev/screenshots/qa/${tag}-24-share-opened.png` });
log.push(...log2);

console.log(JSON.stringify(res, null, 1));
console.log(log.length ? log.join('\n') : 'console: clean');
await browser.close();
