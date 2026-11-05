import { webkit } from 'playwright';
const url = process.argv[2] || 'https://rose-engine.balian.dev/';
const vw = Number(process.argv[3] || 1440), vh = Number(process.argv[4] || 900), dpr = Number(process.argv[5] || 1);
const b = await webkit.launch();
const p = await (await b.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr })).newPage();
p.on('console', (m) => console.log('console', m.type(), m.text()));
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto(url);
await p.waitForTimeout(4000);
console.log(await p.evaluate(() => [...document.querySelectorAll('canvas')].map((c) => {
  const r = c.getBoundingClientRect();
  const gl = c.getContext('webgl2');
  return `${c.width}x${c.height} css ${Math.round(r.width)}x${Math.round(r.height)} parent ${c.parentElement.className.slice(0, 60)} gl=${gl ? (gl.isContextLost() ? 'LOST' : 'ok ' + gl.getParameter(gl.VERSION)) : 'none'}`;
}).join('\n')));
console.log(await p.evaluate(() => {
  const c = [...document.querySelectorAll('canvas')].find((x) => x.getContext('webgl2'));
  const rows = [];
  for (let e = c; e && e !== document.body; e = e.parentElement) {
    const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    rows.push(`${e.tagName.toLowerCase()} ${Math.round(r.width)}x${Math.round(r.height)} pos=${cs.position} disp=${cs.display} h=${cs.height} minh=${cs.minHeight} flex=${cs.flex} grid=${cs.gridTemplateRows} | ${(e.getAttribute('class') || '').slice(0, 110)}`);
  }
  return rows.join('\n');
}));
await b.close();
