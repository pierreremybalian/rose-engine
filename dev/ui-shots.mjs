// Screenshots of the UI harness. Usage: node dev/ui-shots.mjs [baseUrl]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5174/dev/ui.html';
const out = new URL('./screenshots/ui/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const errors = [];

async function open(query, viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  page.on('console', (m) => m.type() === 'error' && errors.push(`${query}: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`${query}: ${e.message}`));
  await page.goto(`${base}${query}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
  return page;
}

const shot = (page, name) => page.screenshot({ path: `${out}${name}.png` });
async function scrollTo(page, sel) {
  await page.locator(sel).evaluate((el) => {
    const aside = el.closest('aside');
    aside.scrollTop = el.offsetTop - 8;
  });
  await page.waitForTimeout(200);
}

let p = await open('?ui=simple');
await shot(p, '01-simple-ink');
await p.close();

p = await open('?ui=advanced');
await shot(p, '02-advanced-ink');
await scrollTo(p, '[data-group="ink"]');
await shot(p, '02b-advanced-ink-palette');
await p.locator('aside').evaluate((el) => (el.scrollTop = el.scrollHeight));
await p.waitForTimeout(200);
await shot(p, '02c-advanced-ink-bottom');
await p.close();

p = await open('?ui=advanced&mode=metal&enamel=1');
await shot(p, '03-advanced-metal-enamel');
await scrollTo(p, '[data-group="metal"]');
await shot(p, '03b-advanced-metal-section');
await p.close();

p = await open('?ui=simple&layout=work');
await p.keyboard.press('e');
await p.waitForTimeout(400);
for (const tab of ['svg', 'png', 'gcode', 'preset']) {
  await p.click(`[data-tab="${tab}"]`);
  await p.waitForTimeout(450);
  await shot(p, `04-export-${tab}`);
}
await p.close();

p = await open('?ui=advanced', { width: 1100, height: 760 });
await p.hover('[data-action="mutate"]');
await p.waitForTimeout(700);
await shot(p, '06-1100-advanced-tooltip');
await p.close();

p = await open('?ui=advanced');
await p.evaluate(() => {
  const st = window.__store;
  st.setRecipe((d) => {
    d.rosettes.push({ id: 'rB', enabled: true, axis: 'pump', lobes: 7, amplitude: 2.5, profile: 'flame', phase: 0 });
    d.rosettes.push({ id: 'rC', enabled: false, axis: 'rock', lobes: 24, amplitude: 0.8, profile: 'concave', phase: 0 });
    d.seed = 2847193021;
    d.name = 'Flame rosace';
  });
  st.set({ locks: ['rosettes.r0.lobes', 'rosettes.rB.amplitude', 'slide.passes'] });
});
await p.waitForTimeout(150);
await p.locator('aside').evaluate((el) => (el.scrollTop = 170));
await p.click('[data-action="presets"]');
await p.waitForTimeout(250);
await shot(p, '07-detail-presets-locks');
await p.keyboard.press('Escape');
await p.hover('[data-field="lobes"] .re-label');
await p.waitForTimeout(700);
await shot(p, '07b-detail-help-tooltip');
await p.close();

p = await open('?ui=simple', { width: 390, height: 844 });
await shot(p, '05-mobile');
await p.click('[data-action="drawer"]');
await p.waitForTimeout(450);
await shot(p, '05b-mobile-drawer');
await p.close();

await browser.close();
if (errors.length) {
  console.log('Console errors:\n' + errors.join('\n'));
  process.exitCode = 1;
} else console.log('ok, no console errors');
