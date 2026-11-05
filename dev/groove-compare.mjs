// Before/after comparison of dev/screenshots/grooves: diff stats per pair and side-by-side sheets.
//   node dev/groove-compare.mjs [filter] [--crop x,y,w,h] [--scale s]
// Writes dev/screenshots/grooves/cmp-<name>.png (before | after).
import { chromium } from 'playwright';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const DIR = 'dev/screenshots/grooves';
const args = process.argv.slice(2);
const cropArg = args.indexOf('--crop');
const crop = cropArg >= 0 ? args[cropArg + 1].split(',').map(Number) : null;
const scaleArg = args.indexOf('--scale');
const scale = scaleArg >= 0 ? Number(args[scaleArg + 1]) : 0.5;
const filter = args[0] && !args[0].startsWith('--') ? new RegExp(args[0]) : null;
const names = readdirSync(DIR)
  .filter((f) => f.startsWith('before-') && f.endsWith('.png'))
  .map((f) => f.slice(7, -4))
  .filter((n) => (!filter || filter.test(n)) && readdirSync(DIR).includes(`after-${n}.png`));

const browser = await chromium.launch();
const page = await browser.newPage();
for (const n of names) {
  const a = readFileSync(`${DIR}/before-${n}.png`).toString('base64');
  const b = readFileSync(`${DIR}/after-${n}.png`).toString('base64');
  const res = await page.evaluate(
    async ([a, b, crop, scale]) => {
      const load = async (src) => {
        const i = new Image();
        i.src = 'data:image/png;base64,' + src;
        await i.decode();
        return i;
      };
      const A = await load(a);
      const B = await load(b);
      const W = A.width, H = A.height;
      const px = (img) => {
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const x = c.getContext('2d');
        x.drawImage(img, 0, 0);
        return x.getImageData(0, 0, W, H).data;
      };
      const da = px(A), db = px(B);
      let sum = 0, big = 0, max = 0;
      for (let i = 0; i < da.length; i += 4) {
        const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
        sum += d;
        if (d > 16) big++;
        if (d > max) max = d;
      }
      const [cx, cy, cw, ch] = crop ?? [0, 0, W, H];
      const ow = Math.round(cw * scale), oh = Math.round(ch * scale);
      const c = document.createElement('canvas');
      c.width = ow * 2 + 8;
      c.height = oh;
      const x = c.getContext('2d');
      x.fillStyle = '#c00';
      x.fillRect(0, 0, c.width, c.height);
      x.imageSmoothingEnabled = scale < 1;
      x.drawImage(A, cx, cy, cw, ch, 0, 0, ow, oh);
      x.drawImage(B, cx, cy, cw, ch, ow + 8, 0, ow, oh);
      return { mean: +(sum / (W * H)).toFixed(2), over16: +((100 * big) / (W * H)).toFixed(2), max, url: c.toDataURL('image/png') };
    },
    [a, b, crop, scale],
  );
  writeFileSync(`${DIR}/cmp-${n}.png`, Buffer.from(res.url.split(',')[1], 'base64'));
  console.log(n.padEnd(36), `mean |Δ| ${res.mean}`.padEnd(16), `>16: ${res.over16}%`.padEnd(14), `max ${res.max}`);
}
await browser.close();
