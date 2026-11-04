// Scripted interaction checks for the UI harness. Usage: node dev/ui-test.mjs [baseUrl]
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:5174/dev/ui.html';
const browser = await chromium.launch();
let failed = 0;
const errors = [];

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}

async function open(query = '?ui=advanced', viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${base}${query}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  return page;
}
const state = (p) => p.evaluate(() => window.__store.get());
const calls = (p) => p.evaluate(() => window.__calls.map((c) => c.name));
const canUndo = (p) => p.evaluate(() => window.__store.canUndo());

// ---------- slider drag + undo ----------
{
  const p = await open();
  const range = p.locator('[data-field="slide.passes"] input[type="range"]');
  await range.scrollIntoViewIfNeeded();
  const box = await range.boundingBox();
  const before = (await state(p)).recipe.slide.passes;
  const y = box.y + box.height / 2;
  const x0 = box.x + 8 + ((before - 1) / 299) * (box.width - 16);
  await p.mouse.move(x0, y);
  await p.mouse.down();
  for (let i = 1; i <= 12; i++) await p.mouse.move(x0 + i * 8, y);
  await p.mouse.up();
  const after = (await state(p)).recipe.slide.passes;
  const numVal = await p.locator('[data-field="slide.passes"] input[type="number"]').inputValue();
  check('slider drag changes slide.passes', after > before, `${before} → ${after}`);
  check('number box follows the slider', Number(numVal) === after, numVal);
  await p.evaluate(() => window.__store.undo());
  const undone = (await state(p)).recipe.slide.passes;
  check('one undo restores the pre-drag value', undone === before, `after undo: ${undone}`);
  check('the whole drag was a single undo step', (await canUndo(p)) === false);
  const rangeVal = await range.inputValue();
  check('slider shows the restored value', Number(rangeVal) === before, rangeVal);

  // keyboard arrows on a focused slider: one step each
  await range.focus();
  await p.keyboard.press('ArrowRight');
  await p.keyboard.press('ArrowRight');
  check('arrow keys step the slider', (await state(p)).recipe.slide.passes === before + 2);
  await p.evaluate(() => window.__store.undo());
  check('each arrow press is its own undo step', (await state(p)).recipe.slide.passes === before + 1);

  // numeric box
  const num = p.locator('[data-field="slide.endRadius"] input[type="number"]');
  await num.fill('31.5');
  await num.press('Enter');
  check('typing in the number box commits', (await state(p)).recipe.slide.endRadius === 31.5);
  await num.fill('9999');
  await num.press('Tab');
  check('number box clamps to max', (await state(p)).recipe.slide.endRadius === 150);

  // focus survives unrelated recipe updates
  await num.focus();
  await p.evaluate(() => window.__store.setRecipe((d) => void (d.slide.passes = 77)));
  const focusedField = await p.evaluate(() => document.activeElement?.closest('[data-field]')?.getAttribute('data-field'));
  check('focus stays on the edited control across re-renders', focusedField === 'slide.endRadius', String(focusedField));
  await p.close();
}

// ---------- locks ----------
{
  const p = await open();
  const lock = p.locator('[data-field="slide.passes"] [data-lock="slide.passes"]');
  await lock.click();
  check('lock adds key to store.locks', (await state(p)).locks.includes('slide.passes'));
  check('lock button reports aria-pressed', (await lock.getAttribute('aria-pressed')) === 'true');
  await lock.click();
  check('second click removes it', !(await state(p)).locks.includes('slide.passes'));
  await p.locator('[data-lock="rosettes"]').first().click();
  check('whole-stack lock', (await state(p)).locks.includes('rosettes'));
  const id = (await state(p)).recipe.rosettes[0].id;
  const inherited = await p.locator(`[data-lock="rosettes.${id}.lobes"]`).getAttribute('data-inherited');
  check('per-field rosette locks show the stack lock', inherited === 'true');
  await p.locator(`[data-lock="rosettes.${id}.lobes"]`).click();
  check('per-field rosette lock key', (await state(p)).locks.includes(`rosettes.${id}.lobes`));
  await p.locator('[data-group="eccentric"] [data-lock="eccentric.enabled"]').click();
  check('chuck header lock', (await state(p)).locks.includes('eccentric.enabled'));
  await p.locator('[data-field="ink.palette"] [data-lock="ink.palette"]').click();
  check('palette lock', (await state(p)).locks.includes('ink.palette'));
  await p.close();
}

// ---------- rosette stack ----------
{
  const p = await open();
  const remove0 = p.locator('article[data-rosette] header button[aria-label^="Remove"]').first();
  check('remove disabled with a single rosette', await remove0.isDisabled());
  await p.click('[data-action="add-rosette"]');
  let s = await state(p);
  check('add rosette', s.recipe.rosettes.length === 2 && (await p.locator('article[data-rosette]').count()) === 2);
  const thumbs = await p.locator('article[data-rosette] canvas').evaluateAll((cs) => cs.map((c) => c.width > 0));
  check('each card draws a thumbnail', thumbs.every(Boolean));
  const second = p.locator('article[data-rosette]').nth(1);
  await second.locator('[data-field="lobes"] input[type="number"]').fill('5');
  await second.locator('[data-field="lobes"] input[type="number"]').press('Enter');
  s = await state(p);
  check('editing a card writes its own rosette', s.recipe.rosettes[1].lobes === 5 && s.recipe.rosettes[0].lobes === 12);
  await second.locator('header [role="switch"]').click();
  check('enable switch toggles the rosette', (await state(p)).recipe.rosettes[1].enabled === false);
  await second.locator('header button[aria-label^="Remove"]').click();
  s = await state(p);
  check('remove rosette', s.recipe.rosettes.length === 1 && (await p.locator('article[data-rosette]').count()) === 1);
  await p.evaluate(() => window.__store.undo());
  check('undo brings it back', (await p.locator('article[data-rosette]').count()) === 2);
  await p.close();
}

// ---------- groups / visibility ----------
{
  const p = await open('?ui=simple');
  check('simple mode hides chuck groups', await p.locator('[data-group="eccentric"]').isHidden());
  await p.click('header.re-topbar [role="radio"][data-value="advanced"]');
  check('advanced shows them', await p.locator('[data-group="eccentric"]').isVisible());
  await p.locator('[data-group="eccentric"] [role="switch"]').click();
  check('chuck switch enables + reveals params', (await state(p)).recipe.eccentric.enabled && (await p.locator('[data-field="eccentric.offset"]').isVisible()));
  await p.selectOption('[data-field="slide.phaseMode"] select', 'custom');
  check('custom phase input appears', await p.locator('[data-field="slide.phaseCustom"] input').isVisible());
  await p.fill('[data-field="slide.phaseCustom"] input', '0, 5, 10.5');
  await p.press('[data-field="slide.phaseCustom"] input', 'Enter');
  check('custom phase parses', JSON.stringify((await state(p)).recipe.slide.phaseCustom) === '[0,5,10.5]');
  await p.click('[data-field="ink.palette"] button[aria-label="Ember palette"]');
  {
    const st = await state(p);
    check('palette chip sets palette + paper', st.recipe.ink.palette[0] === '#7a1f1f' && st.recipe.ink.paper === '#fbf6ec');
  }
  await p.click('header.re-topbar [role="radio"][data-value="metal"]');
  check('metal mode swaps groups', (await p.locator('[data-group="metal"]').isVisible()) && (await p.locator('[data-group="ink"]').isHidden()));
  await p.click('[data-field="metal.material"] [data-value="blued"]');
  check('metal chip sets material', (await state(p)).recipe.metal.material === 'blued');
  await p.close();
}

// ---------- keyboard ----------
{
  const p = await open();
  await p.locator('main').click({ position: { x: 300, y: 300 } });
  await p.keyboard.press('r');
  await p.keyboard.press('m');
  let c = await calls(p);
  check('R → deps.random, M → deps.mutate', c.includes('random') && c.includes('mutate'));
  const seed = (await state(p)).recipe.seed;
  check('seed chip shows the seed', (await p.locator('[data-action="copy-seed"]').innerText()).includes(String(seed)));
  const before = (await state(p)).recipe;
  await p.keyboard.press('ControlOrMeta+z');
  const undone = (await state(p)).recipe;
  check('⌘Z undoes', undone !== before && undone.seed !== before.seed || undone.slide.phaseStep !== before.slide.phaseStep);
  await p.keyboard.press('ControlOrMeta+Shift+z');
  check('⇧⌘Z redoes', JSON.stringify((await state(p)).recipe) === JSON.stringify(before));
  const playing0 = (await state(p)).playback.playing;
  await p.keyboard.press(' ');
  check('Space toggles playback', (await state(p)).playback.playing !== playing0);
  await p.keyboard.press(' ');
  await p.keyboard.press('e');
  check('E opens the export dialog', await p.locator('dialog[data-dialog="export"]').evaluate((d) => d.open));
  await p.keyboard.press('r');
  check('shortcuts are ignored while the dialog is open', (await calls(p)).filter((x) => x === 'random').length === 1);
  await p.keyboard.press('Escape');
  check('Esc closes the dialog', !(await p.locator('dialog[data-dialog="export"]').evaluate((d) => d.open)));
  await p.locator('input[aria-label="Recipe name"]').click();
  await p.keyboard.type('rm e');
  c = await calls(p);
  check('typing in inputs does not fire shortcuts', c.filter((x) => x === 'random').length === 1 && c.filter((x) => x === 'mutate').length === 1);
  await p.close();
}

// ---------- transport ----------
{
  const p = await open('?progress=0');
  await p.click('[data-action="play"]');
  check('play button starts playback', (await state(p)).playback.playing);
  await p.waitForTimeout(400);
  await p.click('[data-action="play"]');
  const prog = (await state(p)).playback.progress;
  check('progress advances while playing', prog > 0, prog.toFixed(1));
  await p.selectOption('[data-action="speed"]', '0');
  check('speed select writes playback.speed (Instant = 0)', (await state(p)).playback.speed === 0);
  const scrub = p.locator('[data-action="scrub"]');
  await scrub.evaluate((el) => {
    el.value = String(Number(el.max) / 2);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const st = await state(p);
  const total = await p.evaluate(() => window.__store && document.querySelector('[data-action="scrub"]').max);
  check('scrub writes playback.progress', Math.abs(st.playback.progress - Number(total) / 2) < 1, `${st.playback.progress}`);
  const readout = await p.locator('[data-readout="pass"]').innerText();
  check('pass readout', /PASS\s*21\s*\/\s*40/i.test(readout.replace(/\n/g, ' ')), readout.replace(/\n/g, ' '));
  await p.click('[role="radio"][data-value="rosette"]');
  check('camera preset → store.camera', (await state(p)).camera === 'rosette');
  await p.click('[role="radio"][data-value="machine"]:not([aria-label])');
  check('frame toggle → store.frame', (await state(p)).frame === 'machine');
  await p.click('header.re-topbar [role="radio"][aria-label="Work only"]');
  check('layout toggle → store.layout', (await state(p)).layout === 'work');
  await p.click('[data-action="restart"]');
  const r = await state(p);
  check('restart rewinds and plays', r.playback.playing && r.playback.progress < 2000);
  await p.close();
}

// ---------- export dialog ----------
{
  const p = await open();
  await p.click('[data-action="export"]');
  await p.click('[data-action="download"]');
  await p.waitForTimeout(100);
  let all = await p.evaluate(() => window.__calls);
  const svg = all.find((c) => c.name === 'exportSVG');
  check('SVG download → deps.exportSVG with defaults', svg && svg.args[0].tolerance === 0.01 && svg.args[0].background === true);
  await p.click('[data-tab="png"]');
  await p.click('[role="radio"][data-value="8192"]');
  await p.click('[data-action="download"]');
  await p.waitForTimeout(100);
  all = await p.evaluate(() => window.__calls);
  const png = all.find((c) => c.name === 'exportPNG');
  check('PNG download → deps.exportPNG', png && png.args[0].width === 8192 && png.args[0].height === 8192, JSON.stringify(png?.args[0]));
  await p.click('[data-tab="gcode"]');
  await p.waitForTimeout(400);
  const lines = await p.locator('[data-gcode-stats] .re-stat').first().innerText();
  check('G-code tab shows live stats', /\d/.test(lines), lines.replace(/\n/g, ' '));
  await p.click('[role="radio"][data-value="cnc"]');
  await p.waitForTimeout(400);
  all = await p.evaluate(() => window.__calls);
  const prev = all.filter((c) => c.name === 'previewGcode').pop();
  check('changing profile re-runs previewGcode', prev && prev.args[0].profile === 'cnc');
  await p.click('[data-action="download"]');
  await p.waitForTimeout(100);
  all = await p.evaluate(() => window.__calls);
  check('G-code download → deps.exportGcode', all.some((c) => c.name === 'exportGcode' && c.args[0].profile === 'cnc'));
  await p.click('[data-tab="preset"]');
  await p.click('[data-action="download"]');
  await p.waitForTimeout(100);
  check('Preset download → deps.savePreset', (await calls(p)).includes('savePreset'));
  await p.setInputFiles('[data-action="load-preset-file"]', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{nope') });
  await p.waitForTimeout(200);
  const toast = await p.locator('.re-toast[data-kind="error"]').last().innerText().catch(() => '');
  check('callback errors surface as a toast', toast.includes('not valid JSON'), toast);
  await p.close();
}

// ---------- mobile drawer ----------
{
  const p = await open('?ui=simple', { width: 390, height: 844 });
  const aside = p.locator('aside#re-panel');
  check('drawer starts inert off-canvas', await aside.evaluate((a) => a.inert && a.getBoundingClientRect().right <= 1));
  await p.click('[data-action="drawer"]');
  await p.waitForTimeout(400);
  check('drawer opens', await aside.evaluate((a) => !a.inert && a.getBoundingClientRect().left >= 0));
  await p.keyboard.press('Escape');
  await p.waitForTimeout(400);
  check('Esc closes the drawer', await aside.evaluate((a) => a.inert));
  await p.close();
}

await browser.close();
if (errors.length) {
  console.log('Page errors:\n' + errors.join('\n'));
  failed++;
}
console.log(failed ? `\n${failed} failing` : '\nall passed');
process.exitCode = failed ? 1 : 0;
