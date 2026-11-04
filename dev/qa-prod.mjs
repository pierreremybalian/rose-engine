// QA: production bundle (vite preview) vs dev: computed styles match, views render, exports work, console clean.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
const PROD = process.argv[2] || 'http://127.0.0.1:5180/';
const DEV = process.argv[3] || 'http://127.0.0.1:5173/';
const OUT = 'dev/screenshots/qa';
mkdirSync(`${OUT}/exports-prod`, { recursive: true });
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu'] });
const probe = () => {
  const pick = (sel, props) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return Object.fromEntries(props.map((p) => [p, cs[p]]));
  };
  return {
    body: pick('body', ['backgroundColor', 'fontFamily', 'color']),
    random: pick('[data-action="random"]', ['backgroundImage', 'color', 'paddingLeft', 'height', 'borderRadius', 'boxShadow']),
    ghost: pick('[data-action="mutate"]', ['backgroundImage', 'borderTopColor', 'height', 'display']),
    panel: pick('#re-panel', ['width', 'backgroundImage', 'backgroundColor', 'overflowY']),
    range: pick('#re-panel input[type="range"]', ['appearance', 'height', 'backgroundImage']),
    switch: pick('#re-panel [role="switch"]', ['width', 'height', 'backgroundColor', 'borderRadius']),
    play: pick('[data-action="play"]', ['width', 'height', 'borderRadius', 'backgroundImage']),
    select: pick('[data-action="speed"]', ['appearance', 'backgroundColor', 'height', 'fontFamily']),
    h1: pick('.re-plate-name', ['fontFamily', 'fontStyle', 'fontSize']),
  };
};
const res = {};
const logs = [];
for (const [name, url] of [['prod', PROD], ['dev', DEV]]) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${name}] ${m.type()}: ${m.text()}`); });
  p.on('pageerror', (e) => logs.push(`[${name}] pageerror: ${e.message}`));
  await p.goto(url);
  await p.waitForTimeout(3000);
  res[name] = await p.evaluate(probe);
  if (name === 'prod') {
    await p.screenshot({ path: `${OUT}/prod-01-boot.png` });
    await p.click('header [aria-label="Finish"] button[data-value="metal"]');
    await p.waitForTimeout(1500);
    await p.screenshot({ path: `${OUT}/prod-02-metal.png` });
    await p.click('header [aria-label="Work only"]');
    await p.waitForTimeout(1000);
    await p.screenshot({ path: `${OUT}/prod-03-work.png` });
    await p.click('header [aria-label="Machine only"]');
    await p.waitForTimeout(1000);
    await p.screenshot({ path: `${OUT}/prod-04-machine.png` });
    await p.click('[data-action="export"]');
    await p.click('[data-tab="svg"]');
    const [d] = await Promise.all([p.waitForEvent('download'), p.click('dialog [data-action="download"]')]);
    const path = `${OUT}/exports-prod/${d.suggestedFilename()}`;
    await d.saveAs(path);
    res.prodSvg = await p.evaluate((t) => { const doc = new DOMParser().parseFromString(t, 'image/svg+xml'); return { err: !!doc.querySelector('parsererror'), paths: doc.querySelectorAll('path').length, w: doc.documentElement.getAttribute('width') }; }, readFileSync(path, 'utf8'));
    await p.screenshot({ path: `${OUT}/prod-05-export-dialog.png` });
    res.prodDevHook = await p.evaluate(() => 'window.__rose' in window ? 'present' : 'absent');
    // phone
    const pp = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    pp.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[prod-phone] ${m.type()}: ${m.text()}`); });
    await pp.goto(url);
    await pp.waitForTimeout(2500);
    await pp.click('[data-action="drawer"]');
    await pp.waitForTimeout(500);
    await pp.screenshot({ path: `${OUT}/prod-06-phone-drawer.png` });
  }
  await ctx.close();
}
const diffs = [];
for (const k of Object.keys(res.dev)) for (const prop of Object.keys(res.dev[k] ?? {})) if (JSON.stringify(res.dev[k][prop]) !== JSON.stringify(res.prod[k]?.[prop])) diffs.push({ k, prop, dev: res.dev[k][prop], prod: res.prod[k]?.[prop] });
console.log(JSON.stringify({ styleDiffs: diffs, prodSvg: res.prodSvg, prodDevHook: res.prodDevHook, sample: res.prod.random }, null, 1));
console.log(logs.join('\n') || 'console: clean');
await b.close();
