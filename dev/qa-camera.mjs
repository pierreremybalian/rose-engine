import { chromium } from 'playwright';
const url = process.argv[2] || 'http://127.0.0.1:5173/';
const vw = Number(process.argv[3] || 1440), vh = Number(process.argv[4] || 900);
const out = 'dev/screenshots/qa';
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu'] });
const p = await b.newPage({ viewport: { width: vw, height: vh } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(`${m.type()}: ${m.text()}`); });
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
await p.goto(url);
await p.waitForTimeout(2500);
const layouts = { split: 'Split: machine and work', machine: 'Machine only' };
for (const [lk, label] of Object.entries(layouts)) {
  await p.click(`header [aria-label="${label}"]`);
  for (const cam of ['Overview', 'Rosette', 'Tool']) {
    await p.click(`footer button:has-text("${cam}")`);
    await p.waitForTimeout(1300);
    await p.screenshot({ path: `${out}/cam-${vw}-${lk}-${cam.toLowerCase()}.png` });
  }
  await p.click(`footer button:has-text("Overview")`);
  await p.waitForTimeout(1200);
}
console.log(errs.slice(0, 20).join('\n') || 'no console errors');
await b.close();
