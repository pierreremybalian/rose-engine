// PNG export through app.renderPNG (multisampled tiles): a preset in ink and metal, plus a 4× crop.
//   node dev/groove-png.mjs <preset> [size]
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const [id = 'fine-barleycorn', size = '4096'] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
await p.goto('http://127.0.0.1:5173/');
await p.waitForFunction(() => window.__rose);
await p.waitForTimeout(1200);
for (const mode of ['ink', 'metal']) {
  const url = await p.evaluate(async ([id, mode, size]) => {
    const { presetRecipe } = await import('/src/presets/index.ts');
    const { store, app } = window.__rose;
    const r = presetRecipe(id);
    r.mode = mode;
    store.setRecipe(r);
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const t0 = performance.now();
    const blob = await app.renderPNG({ width: size, height: size, transparent: false });
    console.log('png ms', performance.now() - t0);
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = 1600;
    c.height = 800;
    const x = c.getContext('2d');
    x.drawImage(bmp, 0, 0, size, size, 0, 0, 800, 800);
    x.imageSmoothingEnabled = false;
    // 4× crop around the 35° spot at 0.69 R
    const cx = size / 2 + 0.69 * (size / 2) * Math.cos(0.61), cy = size / 2 - 0.69 * (size / 2) * Math.sin(0.61);
    x.drawImage(bmp, cx - 100, cy - 100, 200, 200, 800, 0, 800, 800);
    return c.toDataURL('image/png');
  }, [id, mode, +size]);
  writeFileSync(`dev/screenshots/grooves/after-png-${id}-${mode}.png`, Buffer.from(url.split(',')[1], 'base64'));
}
await b.close();
