// QA: 390x844 drawer, 1100px width, and GPU/heap growth across 20 Random presses.
import { launch, rects, shot, state, glInfo, heapMB } from './qa-lib.mjs';

const url = process.argv[2] || 'http://127.0.0.1:5173/';
const tag = process.argv[3] || 'dev';
const res = {};
const overflow = (page) => page.evaluate(() => ({ docW: document.documentElement.scrollWidth, winW: innerWidth, docH: document.documentElement.scrollHeight, winH: innerHeight }));

// ---- phone
{
  const { browser, page, log, setSection } = await launch({ url, width: 390, height: 844 });
  setSection('phone');
  await page.waitForTimeout(2500);
  await shot(page, `${tag}-30-phone`);
  res.phone = { overflow: await overflow(page), rects: await rects(page) };
  await page.click('[data-action="drawer"]');
  await page.waitForTimeout(500);
  await shot(page, `${tag}-31-phone-drawer`);
  res.phone.drawer = await page.evaluate(() => document.querySelector('.re-app').dataset.drawer);
  // change mode from the drawer, then close via the close button
  await page.click('#re-panel [aria-label="Finish"] button[data-value="metal"]');
  await page.waitForTimeout(300);
  await page.click('#re-panel [aria-label="Machine only"]');
  await page.waitForTimeout(200);
  await page.click('[data-action="close-drawer"]');
  await page.waitForTimeout(1500);
  res.phone.afterDrawer = { drawer: await page.evaluate(() => document.querySelector('.re-app').dataset.drawer), mode: (await state(page)).recipe.mode, layout: (await state(page)).layout };
  await shot(page, `${tag}-32-phone-metal-machine`);
  await page.click('[data-action="drawer"]');
  await page.waitForTimeout(400);
  await page.click('#re-panel [aria-label="Split: machine and work"]');
  await page.click('.re-scrim', { position: { x: 380, y: 400 } });
  await page.waitForTimeout(1500);
  await shot(page, `${tag}-33-phone-split-metal`);
  res.phone.scrimClosed = await page.evaluate(() => document.querySelector('.re-app').dataset.drawer);
  // export dialog fits
  await page.click('[data-action="export"]');
  await page.waitForTimeout(400);
  await shot(page, `${tag}-34-phone-export`);
  res.phone.dialog = await page.evaluate(() => { const d = document.querySelector('dialog[open]'); const b = d.getBoundingClientRect(); return { w: b.width, h: b.height, x: b.x, y: b.y }; });
  res.phone.log = log;
  await browser.close();
}

// ---- 1100 wide
{
  const { browser, page, log, setSection } = await launch({ url, width: 1100, height: 760 });
  setSection('1100');
  await page.waitForTimeout(2500);
  await shot(page, `${tag}-35-w1100`);
  res.w1100 = { overflow: await overflow(page), rects: await rects(page), drawerBtnVisible: await page.isVisible('[data-action="drawer"]') };
  res.w1100.log = log;
  await browser.close();
}

// ---- memory across 20 Random presses
{
  const { browser, page, log, setSection } = await launch({ url });
  const cdp = await page.context().newCDPSession(page);
  setSection('memory');
  await page.waitForTimeout(1500);
  const snap = async () => ({ heap: await heapMB(page, cdp), ...(await glInfo(page)) });
  // warm-up: both modes + all three layouts, so lazily-created programs/targets exist
  for (let i = 0; i < 3; i++) { await page.keyboard.press('r'); await page.waitForTimeout(700); }
  const s0 = await snap();
  const series = [];
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('r');
    await page.waitForTimeout(500);
    if (i % 5 === 4) series.push(await snap());
  }
  await page.waitForTimeout(800);
  const s1 = await snap();
  res.memory = { start: s0, series, end: s1 };
  res.memory.log = log;
  await browser.close();
}

console.log(JSON.stringify(res, null, 1));
