// First visit opens Grain d'Orge; the three grain presets fill to the rim.
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://127.0.0.1:5173/';
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu'] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto(url);
await p.waitForTimeout(1500);
const boot = await p.evaluate(() => { const r = window.__rose.store.get().recipe; return `${r.name} · ${r.mode} · fill=${r.machine.fillEdge} · passes=${r.slide.passes}`; });
console.log('boot:', boot);
await p.screenshot({ path: 'dev/screenshots/default-boot.png' });
await p.getByRole('button', { name: /Presets/ }).click();
await p.waitForTimeout(400);
console.log('menu:', (await p.locator('[role=menuitem], [role=option]').allInnerTexts()).map((t) => t.split('\n')[0]).join(' | '));
await p.screenshot({ path: 'dev/screenshots/default-menu.png' });
await p.keyboard.press('Escape');
for (const name of ["Grain d'Orge", 'Fine Barleycorn', 'Grain Drift']) {
  await p.evaluate((n) => {
    const { store } = window.__rose;
    const s = store.get();
    store.set({ playback: { ...s.playback, speed: 0 } });
  }, name);
  await p.getByRole('button', { name: /Presets/ }).click();
  await p.waitForTimeout(250);
  await p.locator('[role=menuitem], [role=option]').filter({ hasText: name }).first().click();
  await p.waitForTimeout(2500);
  const r = await p.evaluate(() => { const r = window.__rose.store.get().recipe; return `${r.name} fill=${r.machine.fillEdge} start=${r.slide.startRadius} passes=${r.slide.passes}`; });
  console.log('preset:', r);
  await p.screenshot({ path: `dev/screenshots/default-${name.replace(/\W+/g, '-').toLowerCase()}.png` });
}
console.log(errs.length ? 'errors: ' + errs.join('; ') : 'no errors');
await b.close();
