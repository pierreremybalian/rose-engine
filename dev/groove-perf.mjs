// Groove pass timing against the running dev server (http://127.0.0.1:5173).
//   node dev/groove-perf.mjs [label]
// Times (wall clock, GPU-synced with a 1-pixel readPixels): the metal groove G-buffer pass at fit and zoomed,
// a full flat-view frame, the 4096² disc surface pass, and the CPU geometry build.
import { chromium } from 'playwright';

const label = process.argv[2] || '';
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.goto('http://127.0.0.1:5173/');
await page.waitForFunction(() => window.__rose);
await page.waitForTimeout(1200);
await page.evaluate(() => window.__rose.store.set({ layout: 'work', shimmer: false }));

const results = {};
for (const [id, patch] of [
  // as measured before the preset moved to fill-to-edge (303k samples)
  ['fine-barleycorn', { rubberRadius: 0.15, startRadius: 6.5, endRadius: 15.5, passes: 37, fillEdge: false }],
  ['fine-barleycorn-current', { id: 'fine-barleycorn' }],
  ['grain-d-orge', {}],
  ['enamel-dial', {}],
  ['barleycorn', { mode: 'metal' }],
]) {
  results[id] = await page.evaluate(
    async ([id, patch]) => {
      const { presetRecipe } = await import('/src/presets/index.ts');
      const sm = await import('/src/render/strokeMesh.ts');
      const { store, app } = window.__rose;
      const r = presetRecipe(patch.id ?? id);
      if (patch.rubberRadius != null) r.machine.rubberRadius = patch.rubberRadius;
      if (patch.startRadius != null) Object.assign(r.slide, { startRadius: patch.startRadius, endRadius: patch.endRadius, passes: patch.passes });
      if (patch.fillEdge != null) r.machine.fillEdge = patch.fillEdge;
      if (patch.mode) r.mode = patch.mode;
      store.set({ frame: 'work', tilt: { x: 0, y: 0 } });
      store.setRecipe(r);
      const raf = () => new Promise((res) => requestAnimationFrame(res));
      await raf();
      await raf();
      store.set({ playback: { ...store.get().playback, playing: false, progress: 1e12 } });
      app.resetWorkView();
      await raf();
      await raf();
      const tp = app.toolpath;
      const gl = app.gl.getContext();
      const px = new Uint8Array(4);
      const sync = () => {
        app.gl.setRenderTarget(null);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      };
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      /** GPU ms per call (timer query) and wall ms per call (readPixels-synced), as [gpu, wall]. */
      const time = async (fn, n = 12) => {
        fn();
        sync();
        let gpu = null;
        if (ext) {
          const q = gl.createQuery();
          gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
          for (let i = 0; i < n; i++) fn();
          gl.endQuery(ext.TIME_ELAPSED_EXT);
          for (let k = 0; k < 200 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); k++) await raf();
          if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) gpu = +(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6 / n).toFixed(2);
          gl.deleteQuery(q);
        }
        sync();
        const t0 = performance.now();
        for (let i = 0; i < n; i++) fn();
        app.gl.readRenderTargetPixels(app.grooveRT, 0, 0, 1, 1, px);
        sync();
        return [gpu, +((performance.now() - t0) / n).toFixed(2)];
      };
      const out = { samples: tp.totalSamples };
      // CPU geometry build
      const builders = Object.entries(sm).filter(([k, v]) => typeof v === 'function' && /^build/.test(k));
      app.inkRT.setSize(app.workRect.w, app.workRect.h);
      for (const [k, fn] of builders) {
        const t0 = performance.now();
        const m = fn(tp);
        out[`cpu_${k}_ms`] = +(performance.now() - t0).toFixed(1);
        (m.geometry ?? m).dispose?.();
      }
      const v = app.workView;
      const groove = () => app.drawGroove(app.grooveRT, v.camera, v.pxPerMm, app.placement, app.progress);
      const frame = () => {
        app.workDirty = 2;
        app.renderFrame();
      };
      out.fit_groove_ms = await time(groove);
      out.fit_frame_ms = await time(frame);
      const R = r.machine.workDiameter / 2;
      for (const z of [8, 20]) {
        app.resetWorkView();
        v.mmPerPx /= z;
        v.cx = 0.6875 * R * Math.cos(0.61);
        v.cy = 0.6875 * R * Math.sin(0.61);
        v.fitted = false;
        v.updateCamera();
        v.onChange();
        await raf();
        out[`z${z}_groove_ms`] = await time(groove);
      }
      app.resetWorkView();
      await raf();
      // ink: full redraw of the flat ink cache (same toolpath, ink mode)
      const ink = () =>
        app.drawInk(app.inkRT, v.camera, v.pxPerMm, app.placement, -1, app.progress, { clear: true, bg: true, shadow: 1, paperEverywhere: false });
      out.ink_fit_ms = await time(ink);
      const D = r.machine.workDiameter;
      out.disc4096_full_ms = await time(() => app.drawGrooveInto(app.discRT, app.discCam, app.discRT.width / D, { rotation: 0, x: 0, y: 0 }, -1, app.progress, true, false), 4);
      out.viewport = [app.workRect.w, app.workRect.h];
      return out;
    },
    [id, patch],
  );
}
console.log(label, '[gpu ms, wall ms] per call');
for (const [k, v] of Object.entries(results)) console.log(k, JSON.stringify(v));
console.log(errors.length ? errors.join('\n') : 'no errors');
await browser.close();
