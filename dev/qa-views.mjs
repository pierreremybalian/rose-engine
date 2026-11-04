// QA: boot, playback motion, Ink/Metal (+enamel), layouts, work frame, camera presets, Simple/Advanced.
import { launch, readout, rects, shot, state, pause } from './qa-lib.mjs';

const url = process.argv[2] || 'http://127.0.0.1:5173/';
const tag = process.argv[3] || 'dev';
const { browser, page, log, setSection } = await launch({ url });
const res = {};
const same = (a, b) => Buffer.compare(a, b) === 0;

// ---- boot
await page.waitForTimeout(1200);
const r0 = await readout(page);
const pb0 = (await state(page)).playback;
const rc = await rects(page);
const m1 = await page.screenshot({ clip: rc.machine });
const w1 = await page.screenshot({ clip: rc.work });
await shot(page, `${tag}-01-boot`);
await page.waitForTimeout(700);
const m2 = await page.screenshot({ clip: rc.machine });
const w2 = await page.screenshot({ clip: rc.work });
const r1 = await readout(page);
const pb1 = (await state(page)).playback;
res.boot = { readouts: [r0, r1], progress: [pb0.progress, pb1.progress], playing: pb0.playing, machineAnimates: !same(m1, m2), workAnimates: !same(w1, w2) };

// Tool close-up while playing: two frames for the spindle/headstock check.
setSection('motion');
await page.click('footer button[data-value="tool"]');
await page.waitForTimeout(1100);
const rc2 = await rects(page);
await shot(page, `${tag}-02-tool-a`, rc2.machine);
await page.waitForTimeout(400);
await shot(page, `${tag}-02-tool-b`, rc2.machine);
await page.click('footer button[data-value="rosette"]');
await page.waitForTimeout(1100);
await shot(page, `${tag}-02-rosette-a`, rc2.machine);
await page.waitForTimeout(300);
await shot(page, `${tag}-02-rosette-b`, rc2.machine);
await page.click('footer button[data-value="overview"]');
await page.waitForTimeout(1100);

// ---- finish to the end, then Metal
setSection('metal');
await page.selectOption('[data-action="speed"]', '0');
await page.click('[data-action="play"]');
await page.waitForTimeout(400);
await page.click('header [aria-label="Finish"] button[data-value="metal"]');
await page.waitForTimeout(1500);
res.metal = { mode: (await state(page)).recipe.mode, enamel: (await state(page)).recipe.metal.enamel };
await shot(page, `${tag}-03-metal`);
// enamel on
const enamelSwitch = '[data-field="metal.enamel"] [role="switch"]';
const en0 = await page.getAttribute(enamelSwitch, 'aria-checked');
await page.click(enamelSwitch);
await page.waitForTimeout(1200);
res.metal.enamelAfterClick = (await state(page)).recipe.metal.enamel;
await shot(page, `${tag}-04-metal-enamel`);
const rcw = await rects(page);
await shot(page, `${tag}-04-metal-enamel-work`, rcw.work);
await page.click(enamelSwitch);
await page.waitForTimeout(800);
res.metal.enamelBack = (await state(page)).recipe.metal.enamel;
res.metal.enamelInitial = en0;

// ---- layouts in metal
setSection('layouts');
for (const [v, label] of [['machine', 'Machine only'], ['work', 'Work only'], ['split', 'Split: machine and work']]) {
  await page.click(`header [aria-label="${label}"]`);
  await page.waitForTimeout(1300);
  await shot(page, `${tag}-05-layout-${v}-metal`);
}
await page.click('header [aria-label="Finish"] button[data-value="ink"]');
await page.waitForTimeout(800);
for (const [v, label] of [['machine', 'Machine only'], ['work', 'Work only'], ['split', 'Split: machine and work']]) {
  await page.click(`header [aria-label="${label}"]`);
  await page.waitForTimeout(1300);
  await shot(page, `${tag}-05-layout-${v}-ink`);
}
res.layoutFinal = (await state(page)).layout;

// ---- turning frame mid-play
setSection('frame');
await page.selectOption('[data-action="speed"]', '4');
await page.click('[data-action="restart"]');
await page.click('footer button[data-value="machine"]');
await page.waitForTimeout(1500);
const rcf = await rects(page);
const f1 = await page.screenshot({ clip: rcf.work });
await shot(page, `${tag}-06-turning`);
await page.waitForTimeout(300);
const f2 = await page.screenshot({ clip: rcf.work });
res.turning = { frame: (await state(page)).frame, workMoves: !same(f1, f2) };
await page.click('footer button[data-value="work"]');
await page.waitForTimeout(300);
await shot(page, `${tag}-06-still`);
res.still = (await state(page)).frame;

// ---- Simple / Advanced
setSection('detail');
await pause(page);
const countFields = () => page.$$eval('#re-panel [data-field]', (els) => els.filter((e) => e.offsetParent !== null).length);
const simpleCount = await countFields();
await page.click('header button[data-value="advanced"]');
await page.waitForTimeout(300);
const advCount = await countFields();
await shot(page, `${tag}-07-advanced`);
await page.click('header button[data-value="simple"]');
await page.waitForTimeout(300);
res.detail = { simpleCount, advCount, back: await countFields() };

console.log(JSON.stringify(res, null, 1));
console.log(log.length ? log.join('\n') : 'console: clean');
await browser.close();
