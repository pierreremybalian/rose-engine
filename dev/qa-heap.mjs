// QA: heap / GPU objects across many Random presses (does growth plateau?).
import { launch, glInfo, heapMB } from './qa-lib.mjs';
const n = Number(process.argv[2] || 60);
const { browser, page, log } = await launch({});
const cdp = await page.context().newCDPSession(page);
await page.waitForTimeout(1500);
for (let i = 0; i < 3; i++) { await page.keyboard.press('r'); await page.waitForTimeout(600); }
const out = [];
for (let i = 0; i <= n; i++) {
  if (i % 15 === 0) out.push({ i, heap: await heapMB(page, cdp), ...(await glInfo(page)).live, geo: (await glInfo(page)).geometries });
  if (i < n) { await page.keyboard.press('r'); await page.waitForTimeout(350); }
}
console.log(out.map((o) => JSON.stringify(o)).join('\n'));
console.log(log.join('\n') || 'console clean');
await browser.close();
