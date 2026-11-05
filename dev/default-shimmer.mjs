// Metal presets (and the boot preset) open shimmering; ink presets open still.
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://127.0.0.1:5173/';
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu'] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto(url);
await p.waitForTimeout(1200);
const state = () => p.evaluate(() => { const s = window.__rose.store.get(); return `${s.recipe.name} (${s.recipe.mode}) shimmer=${s.shimmer} tilt=${JSON.stringify(window.__rose.app.tilt, (k, v) => (typeof v === 'number' ? +v.toFixed(2) : v))}`; });
const fps = () => p.evaluate(() => new Promise((ok) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else ok(n); }; requestAnimationFrame(f); }));
console.log('boot:', await state(), 'fps', await fps());
await p.screenshot({ path: 'dev/screenshots/shimmer-boot-a.png' });
await p.waitForTimeout(1500);
console.log('boot+1.5s:', await state());
await p.screenshot({ path: 'dev/screenshots/shimmer-boot-b.png' });
let fail = 0;
for (const [name, want] of [['Barleycorn', false], ['Fine Barleycorn', true], ['Flame', null], ['Enamel Dial', true]]) {
  await p.getByRole('button', { name: /Presets/ }).click();
  await p.waitForTimeout(250);
  await p.locator('[role=menuitem], [role=option]').filter({ has: p.getByText(name, { exact: true }) }).first().click();
  await p.waitForTimeout(1200);
  const s = await p.evaluate(() => { const s = window.__rose.store.get(); return { mode: s.recipe.mode, shimmer: s.shimmer, name: s.recipe.name }; });
  const ok = s.shimmer === (s.mode === 'metal') && (want === null || s.shimmer === want);
  if (!ok) fail++;
  console.log(ok ? 'PASS' : 'FAIL', s.name, s.mode, 'shimmer=' + s.shimmer);
}
console.log(errs.length ? 'errors: ' + errs.join('; ') : 'no errors');
await b.close();
process.exit(fail ? 1 : 0);
