// Diff heat map of a before/after pair: node dev/groove-diffmap.mjs <name>  → dev/screenshots/grooves/diff-<name>.png
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
const DIR = 'dev/screenshots/grooves';
const n = process.argv[2];
const b = await chromium.launch();
const p = await b.newPage();
const url = await p.evaluate(async ([a, c]) => {
  const load = async (s) => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode(); return i; };
  const A = await load(a), B = await load(c);
  const cv = document.createElement('canvas'); cv.width = A.width; cv.height = A.height;
  const x = cv.getContext('2d');
  x.drawImage(A, 0, 0); const da = x.getImageData(0, 0, A.width, A.height);
  x.drawImage(B, 0, 0); const db = x.getImageData(0, 0, A.width, A.height);
  for (let i = 0; i < da.data.length; i += 4) {
    const d = Math.max(Math.abs(da.data[i] - db.data[i]), Math.abs(da.data[i + 1] - db.data[i + 1]), Math.abs(da.data[i + 2] - db.data[i + 2]));
    const g = da.data[i] * 0.25;
    db.data[i] = Math.min(255, g + d * 3); db.data[i + 1] = g; db.data[i + 2] = g; db.data[i + 3] = 255;
  }
  x.putImageData(db, 0, 0);
  return cv.toDataURL();
}, [readFileSync(`${DIR}/before-${n}.png`).toString('base64'), readFileSync(`${DIR}/after-${n}.png`).toString('base64')]);
writeFileSync(`${DIR}/diff-${n}.png`, Buffer.from(url.split(',')[1], 'base64'));
await b.close();
