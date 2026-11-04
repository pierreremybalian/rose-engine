// QA: regression checks for the QA fixes (mode switch keeps the cut, camera re-click, play to the end, phone tabs).
import { launch, rects, shot, state, readout, waitStopped } from './qa-lib.mjs';

const url = process.argv[2] || 'http://127.0.0.1:5173/';
const tag = process.argv[3] || 'dev';
const res = {};
{
  const { browser, page, log, setSection } = await launch({ url });
  await page.waitForTimeout(1500);
  // mode switch while playing keeps progress; a geometry edit restarts
  setSection('mode-mid-play');
  const p0 = (await state(page)).playback;
  await page.click('header [aria-label="Finish"] button[data-value="metal"]');
  await page.waitForTimeout(150);
  const p1 = (await state(page)).playback;
  res.modeSwitch = { before: Math.round(p0.progress), after: Math.round(p1.progress), playing: p1.playing };
  await page.waitForTimeout(600);
  await shot(page, `${tag}-40-metal-mid-play`);
  const lobes = page.locator('[data-rosette] [data-field="lobes"] input[type="number"]').first();
  await lobes.fill('16');
  await lobes.press('Enter');
  await page.waitForTimeout(100);
  res.geometryEditWhilePlaying = Math.round((await state(page)).playback.progress);
  await page.click('header [aria-label="Finish"] button[data-value="ink"]');

  // camera: orbit away, re-click Overview -> back to the framed preset
  setSection('camera');
  await page.waitForTimeout(1000);
  const camPos = () => page.evaluate(() => window.__rose.app.camera3d.position.toArray().map((v) => +v.toFixed(1)));
  const framed = await camPos();
  const r = (await rects(page)).machine;
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2 + 160, r.y + r.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const orbited = await camPos();
  await page.click('footer button[data-value="overview"]');
  await page.waitForTimeout(1300);
  const back = await camPos();
  res.cameraReclick = { framed, orbited, back };
  // Random re-frames a parked overview to the new machine size
  await page.keyboard.press('r');
  await page.waitForTimeout(1400);
  await shot(page, `${tag}-41-random-reframed`);

  // play to the end at 64x
  setSection('play-end');
  await page.selectOption('[data-action="speed"]', '64');
  await page.click('[data-action="restart"]');
  await page.waitForFunction(() => window.__rose.store.get().playback.playing);
  const t0 = Date.now();
  await waitStopped(page, 90000);
  const s = await state(page);
  const total = await page.evaluate(() => window.__rose.app.toolpath.totalSamples);
  res.playEnd = { seconds: (Date.now() - t0) / 1000, progress: s.playback.progress, total, readout: await readout(page), button: await page.getAttribute('[data-action="play"]', 'aria-label') };
  await shot(page, `${tag}-42-play-end`);
  // play again at the end starts over
  await page.click('[data-action="play"]');
  await page.waitForTimeout(150);
  const again = (await state(page)).playback;
  res.playAgain = { playing: again.playing, progress: Math.round(again.progress) };
  res.log = log;
  await browser.close();
}
{
  const { browser, page, log } = await launch({ url, width: 390, height: 844 });
  await page.waitForTimeout(1200);
  await page.click('[data-action="export"]');
  await page.waitForTimeout(400);
  res.phoneTabs = await page.$$eval('[role="tab"]', (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  await shot(page, `${tag}-43-phone-export`);
  res.phoneLog = log;
  await browser.close();
}
console.log(JSON.stringify(res, null, 1));
