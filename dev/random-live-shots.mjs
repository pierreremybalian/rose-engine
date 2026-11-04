// Press Random in the running app and screenshot the results, both finishes.
//   node dev/random-live-shots.mjs [url] [presses]     (default http://127.0.0.1:5173/, 4 presses per mode)
// Does not start or stop any server. Output: dev/screenshots/random/live-<mode>-<n>.png
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.argv[2] ?? 'http://127.0.0.1:5173/';
const PRESSES = Number(process.argv[3] ?? 4);
const OUT = 'dev/screenshots/random';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(URL);
await page.waitForTimeout(2500);

const clickRadio = async (name) => {
  const r = page.getByRole('radio', { name, exact: true }).first();
  if (await r.count()) await r.click();
};
await clickRadio('Work only');
// Instant playback so each Random shows the finished plate.
await page.getByLabel('Playback speed').first().selectOption({ label: 'Instant' }).catch(() => {});

for (const mode of ['Ink', 'Metal']) {
  await clickRadio(mode);
  await page.waitForTimeout(800);
  for (let i = 1; i <= PRESSES; i++) {
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    await page.keyboard.press('r');
    await page.waitForTimeout(2500);
    const file = `${OUT}/live-${mode.toLowerCase()}-${i}.png`;
    await page.screenshot({ path: file });
    console.log('saved', file);
  }
}
await browser.close();
if (errors.length) console.log('page errors:\n' + errors.slice(0, 8).join('\n'));
