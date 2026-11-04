// QA: leak check. Same preset before and after N Random presses -> GPU object counts should match.
import { launch, glInfo, heapMB } from './qa-lib.mjs';
const n = Number(process.argv[2] || 40);
const { browser, page, log } = await launch({});
const cdp = await page.context().newCDPSession(page);
await page.waitForTimeout(1500);
const load = async (id) => { await page.click('[data-action="presets"]'); await page.click(`[data-preset="${id}"]`); await page.waitForTimeout(900); };
const snap = async () => { const g = await glInfo(page); return { heap: await heapMB(page, cdp), geo: g.geometries, tex: g.textures, ...g.live }; };
// visit metal + ink and all layouts first
await load('sunray'); await load('barleycorn');
const a = await snap();
for (let i = 0; i < n; i++) { await page.keyboard.press('r'); await page.waitForTimeout(350); }
await page.keyboard.press('m'); await page.waitForTimeout(400);
await load('sunray'); await load('barleycorn');
const b = await snap();
console.log(JSON.stringify({ before: a, after: b }, null, 1));
console.log(log.join('\n') || 'console clean');
await browser.close();
