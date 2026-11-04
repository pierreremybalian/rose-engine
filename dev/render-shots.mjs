// Screenshot + perf checks for the render harness. Usage:
//   node dev/render-shots.mjs [shot ...]   (default: all)
// Requires `npx vite --port 5175 --strictPort` running.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:5175/dev/render.html';
const OUT = 'dev/screenshots/render';
mkdirSync(OUT, { recursive: true });

const want = new Set(process.argv.slice(2));
const all = want.size === 0;

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const errors = [];

async function open(query, { width = 1600, height = 900, dpr = 1 } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || m.type() === 'warning' || /GL_|WebGL|THREE/.test(t)) {
      errors.push(`[${m.type()}] ${t}`);
    }
    if (process.env.VERBOSE || /\[harness\]/.test(t)) console.log('  console:', t);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  await page.goto(`${BASE}?${query}`);
  await page.waitForFunction(() => window.__rose && window.__rose.toolpath, null, { timeout: 60000 });
  await page.waitForTimeout(800);
  return page;
}

async function setRecipe(page, fn) {
  await page.evaluate((src) => {
    const { store } = window.__rose;
    // eslint-disable-next-line no-new-func
    const f = new Function('d', src);
    store.setRecipe((d) => f(d));
  }, fn);
  await page.waitForTimeout(600);
}

async function shot(page, name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('saved', `${OUT}/${name}.png`);
}

const run = async (name, f) => {
  if (!all && !want.has(name)) return;
  console.log('==', name);
  await f();
};

await run('gpu', async () => {
  const page = await open('layout=work');
  const info = await page.evaluate(() => {
    const gl = window.__rose.app.gl.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  console.log('GPU:', info);
  await page.close();
});

await run('ink-split', async () => {
  const page = await open('layout=split&mode=ink');
  await shot(page, 'ink-split');
  await page.close();
});

await run('ink-zoom8', async () => {
  const page = await open('layout=split&mode=ink');
  await page.evaluate(() => {
    const v = window.__rose.app.workView;
    // zoom 8x around a point on the pattern (right of centre)
    v.zoom(8, v.width / 2 + v.width * 0.18, v.height / 2 - v.height * 0.12);
  });
  await shot(page, 'ink-zoom8');
  await page.evaluate(() => window.__rose.app.workView.zoom(10));
  await shot(page, 'ink-zoom80');
  await page.close();
});

await run('ink-colors', async () => {
  const page = await open('layout=work&preset=harlequin&mode=ink');
  await shot(page, 'ink-colors');
  await page.close();
});

await run('metal-silver', async () => {
  const page = await open('layout=split&preset=enamel-dial&mode=metal');
  await setRecipe(page, `d.metal.enamel = false; d.metal.material = 'silver';`);
  await shot(page, 'metal-silver');
  await page.evaluate(() => {
    const v = window.__rose.app.workView;
    v.zoom(8, v.width / 2 + v.width * 0.15, v.height / 2 - v.height * 0.1);
  });
  await shot(page, 'metal-silver-zoom8');
  await page.close();
});

await run('metal-gold-enamel', async () => {
  const page = await open('layout=split&preset=enamel-dial&mode=metal');
  await setRecipe(page, `d.metal.enamel = true; d.metal.material = 'gold'; d.metal.enamelColor = '#1b3fa0'; d.metal.enamelOpacity = 0.6;`);
  await shot(page, 'metal-gold-enamel');
  await page.evaluate(() => {
    const v = window.__rose.app.workView;
    v.zoom(8, v.width / 2 + v.width * 0.15, v.height / 2 - v.height * 0.1);
  });
  await shot(page, 'metal-gold-enamel-zoom8');
  await setRecipe(page, `d.metal.material = 'silver';`);
  await shot(page, 'metal-silver-enamel-zoom8');
  await page.close();
});

await run('metal-materials', async () => {
  const page = await open('layout=work&preset=enamel-dial&mode=metal');
  for (const m of ['rose', 'brass', 'steel', 'blued']) {
    await setRecipe(page, `d.metal.enamel = false; d.metal.material = '${m}';`);
    await shot(page, `metal-${m}`);
  }
  await page.close();
});

await run('mid-playback', async () => {
  const page = await open('layout=split&mode=ink');
  await page.evaluate(() => {
    const { store } = window.__rose;
    store.set({ frame: 'machine', camera: 'tool', playback: { playing: true, speed: 4, progress: 0 } });
  });
  await page.waitForTimeout(3500);
  await page.evaluate(() => {
    const { store } = window.__rose;
    store.set({ playback: { ...store.get().playback, playing: false } });
  });
  await shot(page, 'mid-playback');
  await page.close();
});

await run('perf', async () => {
  for (const mode of ['ink', 'metal']) {
    for (const frame of ['work', 'machine']) {
      const page = await open(`layout=split&size=large&mode=${mode}`);
      const res = await page.evaluate(async (frame) => {
        const { store, toolpath } = window.__rose;
        store.set({ frame, playback: { playing: true, speed: 20, progress: 0 } });
        const t0 = performance.now();
        let n = 0;
        let worst = 0;
        let last = t0;
        await new Promise((resolve) => {
          const f = (now) => {
            n++;
            worst = Math.max(worst, now - last);
            last = now;
            if (now - t0 < 5000) requestAnimationFrame(f);
            else resolve();
          };
          requestAnimationFrame(f);
        });
        const dt = performance.now() - t0;
        return { samples: toolpath.totalSamples, fps: (n * 1000) / dt, worstMs: worst, progress: store.get().playback.progress };
      }, frame);
      console.log(`perf ${mode}/${frame}:`, JSON.stringify(res));
      if (mode === 'metal' && frame === 'machine') await shot(page, 'perf-large-metal');
      await page.close();
    }
  }
});

await run('png', async () => {
  const page = await open('layout=split&preset=enamel-dial&mode=metal');
  const res = await page.evaluate(async () => {
    const { app } = window.__rose;
    const out = {};
    for (const [w, h, t] of [[1200, 800, false], [3000, 3000, false]]) {
      const t0 = performance.now();
      const b = await app.renderPNG({ width: w, height: h, transparent: t });
      const bmp = await createImageBitmap(b);
      out[`${w}x${h}`] = { bytes: b.size, w: bmp.width, h: bmp.height, ms: Math.round(performance.now() - t0) };
    }
    return out;
  });
  console.log('png metal:', JSON.stringify(res));
  const dataUrl = await page.evaluate(async () => {
    const b = await window.__rose.app.renderPNG({ width: 1400, height: 1000, transparent: false });
    return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
  });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(`${OUT}/export-metal.png`, Buffer.from(dataUrl.split(',')[1], 'base64'));
  await setRecipe(page, `d.mode = 'ink';`);
  const ink = await page.evaluate(async () => {
    const b = await window.__rose.app.renderPNG({ width: 1000, height: 1000, transparent: true });
    return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
  });
  writeFileSync(`${OUT}/export-ink-transparent.png`, Buffer.from(ink.split(',')[1], 'base64'));
  console.log('saved exports');
  await shot(page, 'after-export');
  await page.close();
});

await run('interact', async () => {
  const page = await open('layout=split&mode=ink');
  const box = await page.locator('.rose-work-view').boundingBox();
  const v0 = await page.evaluate(() => { const v = window.__rose.app.workView; return { cx: v.cx, cy: v.cy, mm: v.mmPerPx, w: v.width, h: v.height }; });
  // wheel-zoom at a point right of centre: the display point under the cursor must stay put
  const px = box.x + box.width * 0.75, py = box.y + box.height * 0.4;
  const under = (v, x, y) => ({ x: v.cx + ((x - box.x) / box.width * v.w - v.w / 2) * v.mm, y: v.cy - ((y - box.y) / box.height * v.h - v.h / 2) * v.mm });
  const before = under(v0, px, py);
  await page.mouse.move(px, py);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(200);
  const v1 = await page.evaluate(() => { const v = window.__rose.app.workView; return { cx: v.cx, cy: v.cy, mm: v.mmPerPx, w: v.width, h: v.height }; });
  const after = under(v1, px, py);
  console.log('wheel zoom ×', (v0.mm / v1.mm).toFixed(2), 'cursor drift mm', Math.hypot(after.x - before.x, after.y - before.y).toExponential(2));
  await page.mouse.down();
  await page.mouse.move(px - 100, py + 50, { steps: 5 });
  await page.mouse.up();
  const v2 = await page.evaluate(() => { const v = window.__rose.app.workView; return { cx: v.cx, cy: v.cy, mm: v.mmPerPx }; });
  console.log('drag pan dx,dy mm', ((v2.cx - v1.cx) / v1.mm).toFixed(1), ((v2.cy - v1.cy) / v1.mm).toFixed(1), '(expect +100·k, +50·k px)');
  await shot(page, 'interact-zoomed');
  await page.mouse.dblclick(px, py);
  await page.waitForTimeout(200);
  const v3 = await page.evaluate(() => { const v = window.__rose.app.workView; return { cx: v.cx, cy: v.cy, mm: v.mmPerPx, fitted: v.fitted }; });
  console.log('dblclick reset', JSON.stringify(v3), 'matches initial', Math.abs(v3.mm - v0.mm) < 1e-9);
  for (const layout of ['machine', 'work']) {
    await page.evaluate((l) => window.__rose.store.set({ layout: l }), layout);
    await shot(page, `layout-${layout}`);
  }
  await page.setViewportSize({ width: 700, height: 1000 });
  await page.evaluate(() => window.__rose.store.set({ layout: 'split' }));
  await page.waitForTimeout(300);
  await shot(page, 'layout-portrait');
  await page.close();
});

await browser.close();
const relevant = errors.filter((e) => !/DevTools|favicon|Download the React/.test(e));
console.log(relevant.length ? `console problems (${relevant.length}):\n` + [...new Set(relevant)].slice(0, 30).join('\n') : 'console: clean');
