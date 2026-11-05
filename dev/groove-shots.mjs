// Groove / clip / normal-isotropy screenshots against the running dev server (http://127.0.0.1:5173).
//   node dev/groove-shots.mjs before|after [filter]
// Output: dev/screenshots/grooves/<phase>-<case>.png
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const phase = process.argv[2] || 'after';
const filter = process.argv[3] ? new RegExp(process.argv[3]) : null;
const OUT = 'dev/screenshots/grooves';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(m.type() + ': ' + m.text()));
await page.goto('http://127.0.0.1:5173/');
await page.waitForFunction(() => window.__rose);
await page.waitForTimeout(1200);
await page.evaluate(() => window.__rose.store.set({ layout: 'work', shimmer: false }));

const raf2 = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** Load a recipe (preset id + patch), finished, work frame, level plate. */
async function load(id, patch = {}, extra = {}) {
  await page.evaluate(
    async ([id, patch, extra]) => {
      const { presetRecipe } = await import('/src/presets/index.ts');
      const { store, app } = window.__rose;
      // a hot reload (other work in progress) brings back the default layout
      if (store.get().layout !== 'work') store.set({ layout: 'work' });
      const r = presetRecipe(id);
      for (const [k, v] of Object.entries(patch)) {
        const path = k.split('.');
        let o = r;
        for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
        o[path[path.length - 1]] = v;
      }
      store.set({ frame: extra.frame ?? 'work', tilt: { x: 0, y: 0 }, shimmer: false });
      store.setRecipe(r);
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const total = app.toolpath?.totalSamples ?? 1e12;
      const progress = extra.progress != null ? Math.round(total * extra.progress) : 1e12;
      store.set({ playback: { ...store.get().playback, playing: false, progress } });
      app.resetWorkView();
    },
    [id, patch, extra],
  );
  await raf2();
  await page.waitForTimeout(300);
}

/** Fit, or zoom ×z centred on a work-frame point. */
async function view(z, spot) {
  await page.evaluate(
    ([z, spot]) => {
      const { app } = window.__rose;
      app.resetWorkView();
      if (z > 1) {
        const v = app.workView;
        v.mmPerPx /= z;
        v.cx = spot[0];
        v.cy = spot[1];
        v.fitted = false;
        v.updateCamera();
        v.onChange();
      }
    },
    [z, spot],
  );
  await raf2();
  await page.waitForTimeout(250);
}

async function tilt(t) {
  await page.evaluate((t) => window.__rose.store.set({ tilt: t, shimmer: false }), t);
  await raf2();
  await page.waitForTimeout(400);
}

async function shot(name) {
  const r = await page.evaluate(() => {
    const b = document.querySelector('.rose-work-view').getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  });
  if (Math.round(r.width) !== 840 || Math.round(r.height) !== 777) console.warn(`WARNING ${name}: work view is ${r.width}×${r.height}, not 840×777`);
  const path = `${OUT}/${phase}-${name}.png`;
  await page.screenshot({ path, clip: r });
  console.log('saved', path);
}

const spotFor = (R) => [0.6875 * R * Math.cos((35 * Math.PI) / 180), 0.6875 * R * Math.sin((35 * Math.PI) / 180)];

const cases = [];
const add = (name, fn) => cases.push([name, fn]);

// Fine Barleycorn as the user saw it (the preset has since moved to fill-to-edge from the centre).
const FB_OLD = { 'slide.startRadius': 6.5, 'slide.endRadius': 15.5, 'slide.passes': 37, 'machine.fillEdge': false };
for (const [tag, rr] of [['rr060', 0.6], ['rr015', 0.15]]) {
  add(`fine-barleycorn-${tag}`, async (n) => {
    await load('fine-barleycorn', { ...FB_OLD, 'machine.rubberRadius': rr });
    const spot = spotFor(16);
    await view(1);
    await shot(`${n}-fit`);
    await view(8, spot);
    await shot(`${n}-z8`);
    await view(20, spot);
    await shot(`${n}-z20`);
    await view(60, spot);
    await shot(`${n}-z60`);
  });
}
// the preset as it is now
add('fine-barleycorn-current', async (n) => {
  await load('fine-barleycorn');
  const spot = spotFor(16);
  await view(1);
  await shot(`${n}-fit`);
  await view(8, spot);
  await shot(`${n}-z8`);
  await view(20, spot);
  await shot(`${n}-z20`);
  await view(10, [0, 0]);
  await shot(`${n}-centre-z10`);
  await view(10, [16 * Math.cos(0.5), 16 * Math.sin(0.5)]);
  await shot(`${n}-rim-z10`);
});
for (const id of ['grain-d-orge', 'enamel-dial', 'blued-flame']) {
  add(id, async (n) => {
    await load(id);
    const R = await page.evaluate(() => window.__rose.store.get().recipe.machine.workDiameter / 2);
    await view(1);
    await shot(`${n}-fit`);
    await view(8, spotFor(R));
    await shot(`${n}-z8`);
  });
}
add('presets', async () => {
  const ids = await page.evaluate(async () => (await import('/src/presets/index.ts')).PRESETS.map((p) => p.id));
  for (const id of ids) {
    await load(id);
    await shot(`preset-${id}`);
  }
});
// Fill to edge: the pattern runs past the rim; both renderers must stop at the plate edge.
for (const mode of ['ink', 'metal']) {
  add(`fill-${mode}`, async (n) => {
    const R = 50;
    const patch = { mode, 'machine.fillEdge': true, 'slide.endRadius': R + 3 };
    await load('barleycorn', patch);
    await view(1);
    await shot(`${n}-fit`);
    await view(6, [R * Math.cos(0.6), R * Math.sin(0.6)]);
    await shot(`${n}-rim-z6`);
    await load('barleycorn', patch, { frame: 'machine', progress: 0.7 });
    await shot(`${n}-turning`);
    await load('barleycorn', patch);
    await view(1);
    await tilt({ x: 24, y: -16 });
    await shot(`${n}-tilt`);
  });
}
add('tilt', async (n) => {
  await load('fine-barleycorn', { ...FB_OLD, 'machine.rubberRadius': 0.15 });
  await view(8, spotFor(16));
  await tilt({ x: 18, y: -12 });
  await shot(`${n}-fine-barleycorn-z8`);
  await load('enamel-dial');
  await view(1);
  await tilt({ x: -22, y: 14 });
  await shot(`${n}-enamel-dial`);
});

for (const [name, fn] of cases) {
  if (filter && !filter.test(name)) continue;
  await fn(name);
}
console.log(errors.length ? errors.join('\n') : 'no errors');
await browser.close();
