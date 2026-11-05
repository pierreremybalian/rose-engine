// Forces the first-load race: the stylesheet arrives late, after the app script has run.
// Pass criterion: the WebGL canvas fills the work area in every browser.
import { chromium, webkit } from 'playwright';
const url = process.argv[2] || 'http://127.0.0.1:4173/';
const delay = Number(process.argv[3] || 1500);
let fail = 0;
for (const [name, bt, args] of [['webkit', webkit, []], ['chromium', chromium, ['--use-angle=metal', '--enable-gpu']]]) {
  for (const [vw, vh, dpr] of [[1440, 900, 1], [1280, 720, 2], [390, 844, 3]]) {
    const b = await bt.launch({ args });
    const p = await (await b.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr })).newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    await p.route(/\.css(\?|$)/, async (r) => { await new Promise((ok) => setTimeout(ok, delay)); await r.continue(); });
    await p.goto(url);
    await p.waitForTimeout(delay + 3000);
    const s = await p.evaluate(() => {
      const c = [...document.querySelectorAll('canvas')].find((x) => x.getContext('webgl2'));
      const r = c.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), inline: c.parentElement.style.position || '-' };
    });
    const ok = s.w > 200 && s.h > 200 && !errs.length;
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${vw}x${vh}@${dpr}: canvas ${s.w}x${s.h} inline-position=${s.inline}${errs.length ? ' errors: ' + errs.join('; ') : ''}`);
    await p.screenshot({ path: `dev/screenshots/firstload-race-${name}-${vw}.png` });
    await b.close();
  }
}
process.exit(fail ? 1 : 0);
