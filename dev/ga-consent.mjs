// GA consent + events against the production build, served as if from the live host (Playwright routes
// https://rose-engine.balian.dev/* to dist/). Every GA collection hit is captured and answered 204, so no test
// traffic reaches the real property. Run `npm run build` first.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
const HOST = 'https://rose-engine.balian.dev';
const dist = path.resolve('dist');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.xml': 'application/xml' };
let fail = 0;
const check = (ok, msg) => { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); };

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu'] });
async function session(vp = { width: 1440, height: 900 }) {
  const ctx = await b.newContext({ viewport: vp, permissions: ['clipboard-read', 'clipboard-write'] });
  const hits = [], google = [];
  await ctx.route(`${HOST}/**`, async (r) => {
    const u = new URL(r.request().url());
    let f = path.join(dist, decodeURIComponent(u.pathname));
    if (u.pathname.endsWith('/')) f = path.join(f, 'index.html');
    if (!fs.existsSync(f)) return r.fulfill({ status: 404, body: 'not found' });
    r.fulfill({ status: 200, body: fs.readFileSync(f), contentType: TYPES[path.extname(f)] || 'application/octet-stream' });
  });
  await ctx.route(/google-analytics\.com|analytics\.google\.com/, (r) => {
    const req = r.request();
    const lines = [req.url(), ...(req.postData() || '').split('\n')].filter(Boolean);
    for (const l of lines) {
      const q = new URLSearchParams(l.includes('?') ? l.slice(l.indexOf('?') + 1) : l);
      const base = new URLSearchParams(req.url().slice(req.url().indexOf('?') + 1));
      const en = q.get('en') || base.get('en');
      if (en) hits.push({ en, tid: base.get('tid'), dl: base.get('dl') || '', ep: Object.fromEntries([...q].filter(([k]) => k.startsWith('ep.'))) });
    }
    r.fulfill({ status: 204, body: '' });
  });
  ctx.on('request', (r) => { if (/googletagmanager\.com|google-analytics\.com|analytics\.google\.com/.test(r.url())) google.push(r.url()); });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  return { ctx, p, hits, google, errs };
}
const prompt = (p) => p.locator('[role=region][aria-label=Analytics]');
const names = (hits) => hits.map((h) => h.en).join(',');

// 1. Allow
{
  const { ctx, p, hits, google, errs } = await session();
  await p.goto(`${HOST}/`);
  await p.waitForTimeout(2500);
  check(await prompt(p).isVisible(), 'prompt shows on first visit');
  check(google.length === 0, `nothing from Google before an answer (${google.length} requests)`);
  await p.screenshot({ path: 'dev/screenshots/ga-prompt-desktop.png' });
  await prompt(p).getByRole('button', { name: 'Allow' }).click();
  await p.waitForTimeout(3500);
  check(!(await prompt(p).count()), 'prompt gone after Allow');
  check(google.some((u) => u.includes('gtag/js?id=G-MXMS8L0Z1H')), 'gtag.js loads after Allow');
  const pv = hits.find((h) => h.en === 'page_view');
  check(!!pv && pv.tid === 'G-MXMS8L0Z1H', `page_view sent to G-MXMS8L0Z1H (${names(hits)})`);
  await p.keyboard.press('r');
  await p.waitForTimeout(1200);
  await p.getByRole('button', { name: /Share/ }).first().click();
  await p.waitForTimeout(6000);
  const after = hits.slice(1);
  check(after.some((h) => h.en === 'random_pattern'), `random_pattern event (${names(after)})`);
  check(after.some((h) => h.en === 'share'), 'share event');
  const pvs = hits.filter((h) => h.en === 'page_view');
  console.log(`  page_views so far: ${pvs.length}; dl values: ${[...new Set(pvs.map((h) => h.dl.slice(0, 60)))].join(' | ')}`);
  check(hits.every((h) => !h.dl.includes('#')), 'no hit carries the share-link hash');
  await p.reload();
  await p.waitForTimeout(3000);
  check(!(await prompt(p).count()), 'no prompt after reload (answer remembered)');
  check(hits.filter((h) => h.en === 'page_view').length > pvs.length, 'page_view on reload without asking');
  check(!errs.length, `no page errors ${errs.join('; ')}`);
  await ctx.close();
}
// 2. No thanks
{
  const { ctx, p, google, errs } = await session();
  await p.goto(`${HOST}/`);
  await p.waitForTimeout(2000);
  await prompt(p).getByRole('button', { name: 'No thanks' }).click();
  await p.keyboard.press('r');
  await p.waitForTimeout(1500);
  await p.reload();
  await p.waitForTimeout(2500);
  check(!(await prompt(p).count()), 'No thanks: no prompt after reload');
  check(google.length === 0, `No thanks: nothing from Google (${google.length} requests)`);
  check(!errs.length, 'no page errors');
  await ctx.close();
}
// 3. Shared link + phone screenshot
{
  const { ctx, p, hits } = await session({ width: 390, height: 844 });
  await p.goto(`${HOST}/`);
  await p.waitForTimeout(2500);
  await p.screenshot({ path: 'dev/screenshots/ga-prompt-phone.png' });
  await prompt(p).getByRole('button', { name: 'Allow' }).click();
  await p.waitForTimeout(500);
  await ctx.close();
}
await b.close();
process.exit(fail ? 1 : 0);
