// First-load check: fresh browser per run, reports the main canvas size and whether it has drawn anything.
import { chromium, webkit } from 'playwright';
import fs from 'fs';
const url = process.argv[2] || 'https://rose-engine.balian.dev/';
const out = process.argv[3] || 'dev/screenshots/firstload';
fs.mkdirSync(out, { recursive: true });
const browsers = { chromium: [chromium, ['--use-angle=metal', '--enable-gpu']], webkit: [webkit, []] };
const views = [
  ['desk', { width: 1440, height: 900 }, 1],
  ['laptop', { width: 1280, height: 720 }, 2],
  ['phone', { width: 390, height: 844 }, 3],
];
for (const [name, [bt, args]] of Object.entries(browsers)) {
  for (const [vname, viewport, dpr] of views) {
    const b = await bt.launch({ args });
    const ctx = await b.newContext({ viewport, deviceScaleFactor: dpr, isMobile: vname === 'phone' && name === 'chromium', hasTouch: vname === 'phone' });
    const p = await ctx.newPage();
    const logs = [];
    p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`); });
    p.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
    p.on('requestfailed', (r) => logs.push('reqfail: ' + r.url() + ' ' + r.failure()?.errorText));
    await p.goto(url, { waitUntil: 'commit' });
    await p.waitForTimeout(5000);
    const info = await p.evaluate(() => {
      const cs = [...document.querySelectorAll('canvas')];
      const c = cs.sort((a, b) => b.width * b.height - a.width * a.height)[0];
      if (!c) return 'no canvas';
      const r = c.getBoundingClientRect();
      return `canvas ${c.width}x${c.height} css ${Math.round(r.width)}x${Math.round(r.height)}`;
    }).catch((e) => 'eval err ' + e.message);
    const file = `${out}/${name}-${vname}.png`;
    await p.screenshot({ path: file });
    console.log(`${name} ${vname}: ${info}${logs.length ? '\n  ' + logs.slice(0, 8).join('\n  ') : ''}`);
    await b.close();
  }
}
