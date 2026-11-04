// Screenshots + numeric check for the 3D machine harness.
// Usage: npx vite --port 5176 --strictPort  (in another shell), then: node dev/machine-shots.mjs [only...]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const PAGE = 'http://localhost:5176/dev/machine.html?clean';
const OUT = new URL('./screenshots/machine/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
page.on('console', (m) => console.log('[page]', m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(PAGE);
await page.waitForFunction(() => window.__h && window.__h.ready, null, { timeout: 60000 });
await page.evaluate(() => window.__h.pause());

async function shot(name, fn) {
  if (only.length && !only.includes(name)) return;
  await page.evaluate(fn);
  await page.waitForTimeout(400);
  await page.screenshot({ path: OUT + name + '.png' });
  console.log('saved', name);
}

// Numeric check across configs.
for (const cfg of ['sine12', 'concave5', 'pump', 'eccentric', 'elliptical', 'knife']) {
  const r = await page.evaluate((c) => {
    window.__h.load(c, 'ink');
    return window.__h.check(96);
  }, cfg);
  console.log(`[check] ${cfg}: maxErr=${r.maxErr.toExponential(2)} mm  rockRubber=${JSON.stringify(r.rubberRock)} pumpRubber=${JSON.stringify(r.rubberPump)}`);
}

console.log('[dispose]', JSON.stringify(await page.evaluate(() => window.__h.disposeTest())));
console.log('[timings ms]', JSON.stringify(await page.evaluate(() => window.__h.timings())));

await shot('overview-ink', () => {
  window.__h.load('sine12', 'ink');
  window.__h.rev(3.3);
  window.__h.preset('overview');
});
await shot('overview-metal', () => {
  window.__h.load('sine12', 'metal');
  window.__h.rev(3.3);
  window.__h.preset('overview');
});
await shot('rosette', () => {
  window.__h.load('pump', 'ink');
  window.__h.rev(2.1);
  window.__h.preset('rosette');
});
await shot('tool', () => {
  window.__h.load('sine12', 'ink');
  window.__h.rev(6.37);
  window.__h.preset('tool');
});
await shot('tool-metal', () => {
  window.__h.load('sine12', 'metal');
  window.__h.rev(6.37);
  window.__h.preset('tool');
});
await shot('angle-a', () => {
  window.__h.load('concave5', 'ink');
  window.__h.rev(4.0);
  window.__h.preset('overview');
  window.__h.orbit(0.35, -0.12, 0.62);
});
await shot('angle-b', () => {
  window.__h.rev(4.1);
});
await shot('eccentric', () => {
  window.__h.load('eccentric', 'ink');
  window.__h.rev(13.4);
  window.__h.preset('tool');
  window.__h.orbit(0, 0, 1.6);
});
await shot('elliptical', () => {
  window.__h.load('elliptical', 'metal');
  window.__h.rev(5.2);
  window.__h.preset('tool');
  window.__h.orbit(0, 0, 1.6);
});
await shot('uv-front', () => {
  window.__h.load('sine12', 'ink');
  window.__h.pose({ spindleAngle: 0, rock: 0, pump: 0, slideRadius: 30, divisionAngle: 0 });
  const t = window.__h.tip();
  window.__h.look([t[0] - 30, t[1], 330], [t[0] - 30, t[1], 0]);
});
await shot('nib-closeup', () => {
  window.__h.load('sine12', 'ink');
  window.__h.rev(6.37);
  const t = window.__h.tip();
  window.__h.look([t[0] - 14, t[1] + 9, t[2] + 26], t);
});
await shot('rosette-knife', () => {
  window.__h.load('knife', 'ink');
  window.__h.rev(2.37);
  window.__h.preset('rosette');
  window.__h.orbit(0.25, 0.1, 0.55);
});
await shot('rosette-pump-close', () => {
  window.__h.load('pump', 'ink');
  window.__h.rev(2.37);
  window.__h.preset('rosette');
  window.__h.orbit(-0.35, 0.05, 0.6);
});
await shot('rosette-sine12', () => {
  window.__h.load('sine12', 'ink');
  window.__h.rev(2.1);
  window.__h.preset('rosette');
});
const edge = await page.evaluate(() => window.__h.edge());
for (const [k, v] of Object.entries(edge)) console.log(`[edge] ${k}: ${v}`);
await shot('edge-bigdisc', () => {
  window.__h.preset('overview');
});
await shot('concave-rosette', () => {
  window.__h.load('concave5', 'ink');
  window.__h.rev(2.2);
  window.__h.preset('rosette');
});

await browser.close();
