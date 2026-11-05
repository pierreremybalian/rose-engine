// Batch 2 UI checks: plate size (rescale + undo), fill to edge, symmetry chips/custom/mirror, dynamic limits,
// readout, locks, responsive layout. Runs against the dev server; screenshots go to dev/screenshots/ui-batch2/.
// Usage: node dev/ui-batch2.mjs [url]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:5173/';
const OUT = new URL('./screenshots/ui-batch2/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu'] });
const errors = [];
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`);
  if (!ok) failed++;
};

async function open(viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  page.on('console', (m) => m.type() === 'error' && errors.push(`${viewport.width}: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`${viewport.width}: ${e.message}`));
  await page.goto(URL_);
  await page.waitForFunction(() => window.__rose);
  await page.evaluate(() => document.fonts.ready);
  // stop the opening plot so the screenshots show the whole pattern
  await page.evaluate(() => {
    const s = window.__rose.store;
    s.set({ playback: { ...s.get().playback, playing: false, speed: 0 } });
  });
  await page.waitForTimeout(500);
  return page;
}

const recipe = (p) => p.evaluate(() => window.__rose.store.get().recipe);
const locks = (p) => p.evaluate(() => window.__rose.store.get().locks);
const canUndo = (p) => p.evaluate(() => window.__rose.store.canUndo());
const settle = (p, ms = 120) => p.waitForTimeout(ms);
const finish = (p) =>
  p.evaluate(() => {
    const s = window.__rose.store;
    const tp = window.__rose.app.toolpath;
    s.set({ playback: { ...s.get().playback, playing: false, progress: tp ? tp.totalSamples : 1e9 } });
  });
async function scrollPanelTo(p, sel, offset = 8) {
  await p.locator(sel).first().evaluate((el, off) => {
    const aside = el.closest('aside');
    aside.scrollTop = el.getBoundingClientRect().top - aside.getBoundingClientRect().top + aside.scrollTop - off;
  }, offset);
  await settle(p, 200);
}
/** The readout must equal symmetryText(analyzeSymmetry(recipe)), evaluated with the app's own modules. */
const readoutMatches = (p) =>
  p.evaluate(async () => {
    const { analyzeSymmetry } = await import('/src/engine/symmetry.ts');
    const { symmetryText } = await import('/src/ui/plate.ts');
    const want = symmetryText(analyzeSymmetry(window.__rose.store.get().recipe));
    const got = document.querySelector('[data-readout="symmetry"]')?.textContent ?? '';
    return { want, got, ok: want === got };
  });

// ===================== desktop =====================
const p = await open({ width: 1440, height: 900 });
{
  const order = await p.$$eval('aside [data-group]', (els) => els.map((e) => e.getAttribute('data-group')));
  check('plate section sits above the rosette stack', order.indexOf('plate') === 0 && order.indexOf('rosettes') === 1, order.join(','));
  const visibleFields = await p.$$eval('[data-group="plate"] [data-field]', (els) => els.map((e) => e.getAttribute('data-field')));
  check('simple view shows plate size, fill, symmetry', ['machine.workDiameter', 'machine.fillEdge', 'symmetry.order'].every((k) => visibleFields.includes(k)), visibleFields.join(','));
  check('mirror hidden while free', !visibleFields.includes('symmetry.mirror'));
  check('readout shows the live symmetry', (await readoutMatches(p)).ok, JSON.stringify(await readoutMatches(p)));
  const meta = await p.textContent('.re-plate');
  check('cartouche keeps passes · Ø · finish', /48 passes · Ø 100 mm · Ink on paper/.test(meta), meta.replace(/\s+/g, ' '));

  // ---- locks ----
  const l0 = await locks(p);
  check('symmetry, mirror and fill start locked', ['symmetry.order', 'symmetry.mirror', 'machine.fillEdge'].every((k) => l0.includes(k)), l0.join(','));
  check('plate size has no lock', (await p.locator('[data-field="machine.workDiameter"] [data-lock]').count()) === 0);
  const fillLock = p.locator('[data-field="machine.fillEdge"] [data-lock="machine.fillEdge"]');
  check('fill lock shows pressed', (await fillLock.getAttribute('aria-pressed')) === 'true');
  check('fill lock has an aria-label', (await fillLock.getAttribute('aria-label')) === 'Lock Fill to edge');
  await fillLock.focus();
  await p.keyboard.press('Space');
  await settle(p);
  check('Space on a lock unlocks it', !(await locks(p)).includes('machine.fillEdge') && (await fillLock.getAttribute('aria-pressed')) === 'false');
  await p.keyboard.press('Enter');
  await settle(p);
  check('Enter re-locks it', (await locks(p)).includes('machine.fillEdge'));
  const symLock = p.locator('[data-field="symmetry.order"] [data-lock="symmetry.order"]');
  check('symmetry lock pressed', (await symLock.getAttribute('aria-pressed')) === 'true');
  check('locks are not undo steps', (await canUndo(p)) === false);

  await finish(p);
  await settle(p, 300);
  await p.screenshot({ path: `${OUT}01-desktop-plate-section.png` });

  // ---- plate chips: 100 → 32 → 100 ----
  const r0 = await recipe(p);
  const chip = (d) => p.locator(`[data-field="machine.workDiameter"] [role="radio"][data-value="${d}"]`);
  check('plate chips are a labelled radiogroup', (await p.locator('[role="radiogroup"][aria-label="Plate size presets"]').count()) === 1);
  check('chip aria-label', (await chip(32).getAttribute('aria-label')) === 'Watch, 32 mm');
  check('Plate 100 chip checked at 100 mm', (await chip(100).getAttribute('aria-checked')) === 'true');
  await chip(32).click();
  await settle(p);
  const r32 = await recipe(p);
  check('Watch 32 sets the plate to 32 mm', r32.machine.workDiameter === 32);
  const k = 32 / 100;
  check('design scales with the plate (end radius)', Math.abs(r32.slide.endRadius - r0.slide.endRadius * k) < 0.06, `${r0.slide.endRadius} → ${r32.slide.endRadius}`);
  check('design scales with the plate (rock amplitude)', Math.abs(r32.rosettes[0].amplitude - r0.rosettes[0].amplitude * k) < 0.03, `${r0.rosettes[0].amplitude} → ${r32.rosettes[0].amplitude}`);
  check('Watch 32 chip checked', (await chip(32).getAttribute('aria-checked')) === 'true' && (await chip(100).getAttribute('aria-checked')) === 'false');
  check('cartouche shows Ø 32 mm', /Ø 32 mm/.test(await p.textContent('.re-plate')));
  const radMax = await p.evaluate(async () => {
    const { maxUsefulRadius } = await import('/src/engine/plate.ts');
    const r = window.__rose.store.get().recipe;
    const el = document.querySelector('[data-field="slide.endRadius"] input[type="range"]');
    return { want: maxUsefulRadius(r), got: Number(el?.max) };
  });
  check('end radius max follows the plate (maxUsefulRadius)', radMax.want === radMax.got, JSON.stringify(radMax));
  const startMax = await p.evaluate(() => Number(document.querySelector('[data-field="slide.startRadius"] input[type="range"]').max));
  check('start radius max follows the plate', startMax === radMax.want, String(startMax));
  await p.screenshot({ path: `${OUT}02-desktop-watch-32.png` });

  await chip(100).click();
  await settle(p);
  const rBack = await recipe(p);
  check('100 → 32 → 100 round-trips exactly', JSON.stringify(rBack) === JSON.stringify(r0));
  await p.evaluate(() => window.__rose.store.undo());
  check('undo → 32 mm', (await recipe(p)).machine.workDiameter === 32);
  await p.evaluate(() => window.__rose.store.undo());
  check('undo → original recipe', JSON.stringify(await recipe(p)) === JSON.stringify(r0));
  check('one undo step per chip', (await canUndo(p)) === false);
  await p.evaluate(() => window.__rose.store.redo());
  check('redo → 32 mm', JSON.stringify(await recipe(p)) === JSON.stringify(r32));
  await p.evaluate(() => window.__rose.store.undo());

  // arrow keys move through the chips
  await chip(100).focus();
  await p.keyboard.press('ArrowLeft');
  await settle(p);
  check('ArrowLeft on the chips picks Pocket 50', (await recipe(p)).machine.workDiameter === 50);
  check('focus follows the checked chip', await chip(50).evaluate((el) => el === document.activeElement));
  await p.keyboard.press('Home');
  await settle(p);
  check('Home picks Watch 32', (await recipe(p)).machine.workDiameter === 32);
  await p.evaluate(() => {
    const s = window.__rose.store;
    while (s.canUndo()) s.undo();
  });

  // slider drag: one undo step, scaled from the drag's start (no accumulated rounding)
  const range = p.locator('[data-field="machine.workDiameter"] input[type="range"]');
  const box = await range.boundingBox();
  const y = box.y + box.height / 2;
  const x0 = box.x + 8 + ((100 - 20) / 280) * (box.width - 16);
  await p.mouse.move(x0, y);
  await p.mouse.down();
  for (let i = 1; i <= 10; i++) await p.mouse.move(x0 - i * 6, y);
  for (let i = 9; i >= 0; i--) await p.mouse.move(x0 - i * 6, y);
  await p.mouse.up();
  await settle(p);
  const rDrag = await recipe(p);
  check('dragging out and back returns the original design', rDrag.machine.workDiameter === 100 && JSON.stringify(rDrag) === JSON.stringify(r0), String(rDrag.machine.workDiameter));
  await p.mouse.move(x0, y);
  await p.mouse.down();
  for (let i = 1; i <= 10; i++) await p.mouse.move(x0 - i * 6, y);
  await p.mouse.up();
  await settle(p);
  const dragged = (await recipe(p)).machine.workDiameter;
  check('plate slider drag changes the size', dragged < 100, String(dragged));
  await p.evaluate(() => window.__rose.store.undo());
  check('a whole plate drag is one undo step', JSON.stringify(await recipe(p)) === JSON.stringify(r0));

  // number box: a size between the chips leaves none checked but the group tabbable
  const num = p.locator('[data-field="machine.workDiameter"] input[type="number"]');
  await num.fill('45');
  await num.press('Enter');
  await settle(p);
  check('typed size applies', (await recipe(p)).machine.workDiameter === 45);
  const tabs = await p.$$eval('[data-field="machine.workDiameter"] [role="radio"]', (bs) => bs.map((b) => `${b.getAttribute('aria-checked')}:${b.tabIndex}`));
  check('no chip checked, first chip still tabbable', tabs.every((t) => t.startsWith('false')) && tabs[0].endsWith(':0'), tabs.join(' '));
  await num.fill('999');
  await num.press('Enter');
  await settle(p);
  check('plate size clamps to 300', (await recipe(p)).machine.workDiameter === 300);
  await p.evaluate(() => {
    const s = window.__rose.store;
    while (s.canUndo()) s.undo();
  });

  // ---- fill to edge ----
  const fillSw = p.locator('[data-field="machine.fillEdge"] [role="switch"]');
  check('fill is a labelled switch', (await fillSw.getAttribute('aria-checked')) === 'false' && (await p.locator('[data-field="machine.fillEdge"] label').textContent()) === 'Fill to edge');
  await fillSw.click();
  await settle(p);
  check('fill on', (await recipe(p)).machine.fillEdge === true);
  check('end radius slider replaced', (await p.locator('[data-field="slide.endRadius"]').count()) === 0);
  const auto = p.locator('[data-field="slide.endRadius:auto"]');
  const autoText = (await auto.textContent())?.replace(/\s+/g, ' ').trim();
  const eff = await p.evaluate(async () => {
    const { effectiveEndRadius } = await import('/src/engine/plate.ts');
    return effectiveEndRadius(window.__rose.store.get().recipe);
  });
  check('auto line shows effectiveEndRadius', autoText === `End radius: auto · reaches rim (${eff.toFixed(1)} mm)`, autoText);
  await chip(32).click();
  await settle(p);
  const eff32 = await p.evaluate(async () => {
    const { effectiveEndRadius } = await import('/src/engine/plate.ts');
    return effectiveEndRadius(window.__rose.store.get().recipe);
  });
  check('auto line follows the plate', (await auto.textContent()).includes(`(${eff32.toFixed(1)} mm)`), eff32.toFixed(1));
  await p.evaluate(() => window.__rose.store.undo());
  await finish(p);
  await scrollPanelTo(p, '[data-group="plate"]');
  await settle(p, 300);

  // ---- symmetry ----
  const sym = (v) => p.locator(`[data-field="symmetry.order"] [role="radio"][data-value="${v}"]`);
  check('symmetry chips are a labelled radiogroup', (await p.locator('[data-field="symmetry.order"] [role="radiogroup"][aria-label="Symmetry"]').count()) === 1);
  check('Free checked by default', (await sym(0).getAttribute('aria-checked')) === 'true');
  // a 25-lobe rosette, then 12-fold
  await p.evaluate(() => window.__rose.store.setRecipe((d) => void (d.rosettes[0].lobes = 25)));
  await settle(p);
  await sym(12).click();
  await settle(p);
  let r = await recipe(p);
  check('symmetry 12 set', r.symmetry.order === 12);
  check('setting 12-fold enforces at once (25 lobes → multiple of 12)', r.rosettes[0].lobes % 12 === 0, `lobes ${r.rosettes[0].lobes}`);
  check('mirror toggle appears at order ≥ 2', (await p.locator('[data-field="symmetry.mirror"] [role="switch"]').count()) === 1);
  check('mirror starts locked', (await p.locator('[data-lock="symmetry.mirror"]').getAttribute('aria-pressed')) === 'true');
  const lobesRange = p.locator('[data-rosette] [data-field="lobes"] input[type="range"]').first();
  const lobesNum = p.locator('[data-rosette] [data-field="lobes"] input[type="number"]').first();
  check('lobes slider: min 12, step 12', (await lobesRange.getAttribute('min')) === '12' && (await lobesRange.getAttribute('step')) === '12', `${await lobesRange.getAttribute('min')}/${await lobesRange.getAttribute('step')}`);
  await lobesNum.fill('13');
  await lobesNum.press('Enter');
  await settle(p);
  check('lobes field 13 snaps to 12', (await recipe(p)).rosettes[0].lobes === 12, String((await recipe(p)).rosettes[0].lobes));
  await lobesNum.fill('25');
  await lobesNum.press('Enter');
  await settle(p);
  check('lobes field 25 snaps to 24', (await recipe(p)).rosettes[0].lobes === 24 && (await lobesNum.inputValue()) === '24', await lobesNum.inputValue());
  await lobesRange.focus();
  await p.keyboard.press('ArrowRight');
  await settle(p);
  check('lobes slider steps by 12', (await recipe(p)).rosettes[0].lobes === 36, String((await recipe(p)).rosettes[0].lobes));
  await p.keyboard.press('ArrowLeft');
  await p.keyboard.press('ArrowLeft');
  await settle(p);
  check('lobes slider stops at 12', (await recipe(p)).rosettes[0].lobes === 12);
  check('readout follows (12-fold)', (await readoutMatches(p)).ok, JSON.stringify(await readoutMatches(p)));

  // mirror
  const mirrorSw = p.locator('[data-field="symmetry.mirror"] [role="switch"]');
  await mirrorSw.click();
  await settle(p);
  r = await recipe(p);
  check('mirror on', r.symmetry.mirror === true);
  check('readout after mirror', (await readoutMatches(p)).ok, JSON.stringify(await readoutMatches(p)));
  check('readout reads "12-fold · mirror"', (await p.textContent('[data-readout="symmetry"]')) === '12-fold · mirror', await p.textContent('[data-readout="symmetry"]'));
  // a profile edit under mirror is enforced too, and the select shows what was kept
  const profileSel = p.locator('[data-rosette] [data-field="profile"] select').first();
  await profileSel.selectOption('saw');
  await settle(p);
  r = await recipe(p);
  check('mirror: Saw is enforced to a symmetric profile', r.rosettes[0].profile !== 'saw' && (await profileSel.inputValue()) === r.rosettes[0].profile, `${r.rosettes[0].profile} / select ${await profileSel.inputValue()}`);
  await p.evaluate(() => window.__rose.store.undo());
  await finish(p);
  await settle(p, 300);
  await p.screenshot({ path: `${OUT}03-desktop-symmetry-12-mirror.png` });

  // keyboard on the symmetry chips
  await sym(12).focus();
  await p.keyboard.press('ArrowRight');
  await settle(p);
  check('ArrowRight → 24-fold', (await recipe(p)).symmetry.order === 24);
  check('lobes min/step follow (24)', (await lobesRange.getAttribute('step')) === '24');
  // custom
  const custom = p.locator('[data-field="symmetry.order"] input[type="number"]');
  check('custom box is labelled', (await custom.getAttribute('aria-label')) === 'Custom symmetry order');
  await custom.fill('5');
  await custom.press('Enter');
  await settle(p);
  r = await recipe(p);
  check('custom order 5', r.symmetry.order === 5 && r.rosettes[0].lobes % 5 === 0, `order ${r.symmetry.order}, lobes ${r.rosettes[0].lobes}`);
  const checkedCount = await p.locator('[data-field="symmetry.order"] [role="radio"][aria-checked="true"]').count();
  check('no chip checked for a custom order', checkedCount === 0);
  check('custom box lit', (await p.locator('[data-field="symmetry.order"] .re-numbox').getAttribute('data-active')) === 'true');
  check('first symmetry chip tabbable', (await sym(0).evaluate((b) => b.tabIndex)) === 0);
  // rosette edits enforce: add a rosette → lobes snap to the order
  await p.locator('[data-action="add-rosette"]').click();
  await settle(p);
  r = await recipe(p);
  check('added rosette obeys the order', r.rosettes.every((x) => x.lobes % 5 === 0), r.rosettes.map((x) => x.lobes).join(','));
  await finish(p);
  await settle(p, 200);
  await scrollPanelTo(p, '[data-group="plate"]');
  await p.screenshot({ path: `${OUT}04-desktop-custom-5.png` });

  // Free clears mirror and the constraint
  await sym(0).click();
  await settle(p);
  r = await recipe(p);
  check('Free → order 0, mirror cleared', r.symmetry.order === 0 && r.symmetry.mirror === false);
  check('mirror row hidden again', (await p.locator('[data-field="symmetry.mirror"]').count()) === 0);
  check('lobes step back to 1', (await lobesRange.getAttribute('step')) === '1' && (await lobesRange.getAttribute('min')) === '1');
  check('readout while free', (await readoutMatches(p)).ok, JSON.stringify(await readoutMatches(p)));

  // undo / redo through the keyboard
  const before = JSON.stringify(await recipe(p));
  await p.locator('.re-plate').click({ position: { x: 10, y: 10 } });
  await p.keyboard.press('Meta+z');
  await settle(p);
  const undone = await recipe(p);
  check('⌘Z undoes the Free choice', undone.symmetry.order === 5, String(undone.symmetry.order));
  await p.keyboard.press('Meta+Shift+z');
  await settle(p);
  check('⇧⌘Z redoes it', JSON.stringify(await recipe(p)) === before);
}

// advanced view: plate section still first; the machine group no longer carries the plate size
await p.evaluate(() => window.__rose.store.set({ uiMode: 'advanced' }));
await settle(p, 200);
{
  const groups = await p.$$eval('aside [data-group]:not([hidden])', (els) => els.map((e) => e.getAttribute('data-group')));
  check('advanced: plate section first', groups[0] === 'plate', groups.join(','));
  const machineFields = await p.$$eval('[data-group="machine"] [data-field]', (els) => els.map((e) => e.getAttribute('data-field')));
  check('advanced: plate size only in the plate section', !machineFields.includes('machine.workDiameter'), machineFields.join(','));
}
await p.evaluate(() => window.__rose.store.set({ uiMode: 'simple' }));

// fill on + symmetry for the slide section shot
await p.evaluate(() => {
  const s = window.__rose.store;
  while (s.canUndo()) s.undo();
});
await p.locator('[data-field="machine.fillEdge"] [role="switch"]').click();
await p.locator('[data-field="symmetry.order"] [role="radio"][data-value="12"]').click();
await finish(p);
await settle(p, 400);
await scrollPanelTo(p, '[data-group="slide"]', 60);
await p.screenshot({ path: `${OUT}05-desktop-fill-auto-end-radius.png` });
await p.close();

// ===================== mobile =====================
const m = await open({ width: 390, height: 844 });
{
  await m.locator('[data-action="drawer"]').click();
  await settle(m, 500);
  await scrollPanelTo(m, '.re-plate', 4);
  await m.screenshot({ path: `${OUT}06-mobile-plate-section.png` });
  const overflow = await m.evaluate(() => {
    const aside = document.querySelector('aside');
    const bad = [];
    for (const el of aside.querySelectorAll('[data-group="plate"] *')) {
      const b = el.getBoundingClientRect();
      const a = aside.getBoundingClientRect();
      if (b.width && (b.right > a.right + 0.5 || b.left < a.left - 0.5)) bad.push(el.className || el.tagName);
    }
    return bad;
  });
  check('mobile: nothing in the plate section overflows the drawer', overflow.length === 0, overflow.slice(0, 4).join(' | '));
  const chipH = await m.locator('[data-field="machine.workDiameter"] [role="radio"]').first().boundingBox();
  check('mobile: plate chips are ≥ 40px tall', chipH.height >= 40, chipH.height.toFixed(1));
  await m.locator('[data-field="symmetry.order"] [role="radio"][data-value="8"]').click();
  await m.locator('[data-field="machine.fillEdge"] [role="switch"]').click();
  await finish(m);
  await settle(m, 300);
  await scrollPanelTo(m, '[data-field="symmetry.order"]', 4);
  await m.screenshot({ path: `${OUT}07-mobile-symmetry-8-fill.png` });
  await scrollPanelTo(m, '[data-group="slide"]', 4);
  await m.screenshot({ path: `${OUT}08-mobile-auto-end-radius.png` });
  await m.locator('[data-action="close-drawer"]').click();
  await settle(m, 500);
  await m.screenshot({ path: `${OUT}09-mobile-work.png` });
}
await m.close();

console.log(errors.length ? `console errors:\n  ${errors.join('\n  ')}` : 'console: no errors');
await browser.close();
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed || errors.length ? 1 : 0);
