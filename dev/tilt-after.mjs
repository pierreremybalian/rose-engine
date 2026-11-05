// Second half of dev/tilt-shots.mjs: runs against the tilt build.
export async function runAfter({ open, load, grab, getRecipes, flatCaptures, OUT, errors, browser, fs }) {
  const report = {};
  const { page, ctx } = await open();
  const R = await getRecipes(page);
  const settle = (ms = 350) => page.waitForTimeout(ms);
  const setTilt = (t) => page.evaluate((t) => window.__rose.store.set({ tilt: t, shimmer: false }), t);
  const reset = () => page.evaluate(() => window.__rose.app.resetWorkView());

  // ── 1. tilt 0 must match the pre-change flat render ──
  await flatCaptures(page, R, 'after');
  report.diff = {};
  for (const name of ['barleycorn-metal', 'enamel-dial', 'barleycorn-ink', 'barleycorn-metal-zoom6']) {
    const a = fs.readFileSync(`${OUT}/before-${name}.png`).toString('base64');
    const b = fs.readFileSync(`${OUT}/after-${name}.png`).toString('base64');
    report.diff[name] = await page.evaluate(async ([a, b]) => {
      const img = async (src) => {
        const i = new Image();
        i.src = 'data:image/png;base64,' + src;
        await i.decode();
        const c = document.createElement('canvas');
        c.width = i.width;
        c.height = i.height;
        const x = c.getContext('2d');
        x.drawImage(i, 0, 0);
        return x.getImageData(0, 0, i.width, i.height);
      };
      const A = await img(a);
      const B = await img(b);
      if (A.width !== B.width || A.height !== B.height) return { sizeMismatch: [A.width, A.height, B.width, B.height] };
      let diff = 0;
      let max = 0;
      for (let i = 0; i < A.data.length; i += 4) {
        const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
        if (d > 0) diff++;
        max = Math.max(max, d);
      }
      return { pixels: A.width * A.height, differing: diff, maxChannelDelta: max };
    }, [a, b]);
  }

  // ── 2. tilted renders ──
  const TILTS = [['t0', { x: 0, y: 0 }], ['t25_-15', { x: 25, y: -15 }], ['t-30_20', { x: -30, y: 20 }]];
  for (const [name, key] of [['barleycorn-metal', 'barleycornMetal'], ['enamel-dial', 'enamel']]) {
    await load(page, R[key]);
    await reset();
    for (const [tn, t] of TILTS) {
      await setTilt(t);
      await settle();
      await grab(page, `${OUT}/${name}-${tn}.png`);
    }
  }
  // zoomed-in tilted metal (and its flat twin for comparison)
  await load(page, R.barleycornMetal);
  await reset();
  await page.evaluate(() => {
    const v = window.__rose.app.workView;
    v.zoom(6, v.width * 0.62, v.height * 0.4);
  });
  await settle();
  await grab(page, `${OUT}/barleycorn-metal-zoom6-t0.png`);
  await setTilt({ x: 22, y: -14 });
  await settle();
  await grab(page, `${OUT}/barleycorn-metal-zoom6-t22_-14.png`);
  await setTilt({ x: -2, y: 1 });
  await settle();
  await grab(page, `${OUT}/barleycorn-metal-zoom6-t-2_1.png`);
  // a sweep of small tilts, to see highlights travel
  for (const [i, t] of [[0, -12], [1, -4], [2, 4], [3, 12]]) {
    await setTilt({ x: 0, y: t });
    await settle();
    await grab(page, `${OUT}/sweep-zoom6-${i}-y${t}.png`);
  }
  // sharpness at fit zoom: flat vs a 0.5° tilt (plate-space path), same crop enlarged 3×
  await reset();
  const crop3 = async (path) => {
    const url = await page.evaluate(() => {
      const { app } = window.__rose;
      app.renderFrame();
      const c = app.gl.domElement;
      const cv = document.createElement('canvas');
      cv.width = 1080;
      cv.height = 780;
      const x = cv.getContext('2d');
      x.imageSmoothingEnabled = false;
      x.drawImage(c, 560, 180, 360, 260, 0, 0, 1080, 780);
      return cv.toDataURL('image/png');
    });
    fs.writeFileSync(path, Buffer.from(url.split(',')[1], 'base64'));
  };
  await setTilt({ x: 0, y: 0 });
  await settle();
  await crop3(`${OUT}/crop3x-flat.png`);
  await setTilt({ x: 0.4, y: 0.3 });
  await settle();
  await crop3(`${OUT}/crop3x-tilt0.5.png`);
  // the shimmer path at fit zoom, at fixed times (frames of the hands-free rock)
  report.shimmerFrames = [];
  for (const [i, time] of [[0, 1], [1, 2.6], [2, 4.2], [3, 5.8]]) {
    const t = await page.evaluate((time) => {
      const { app } = window.__rose;
      app.baseTilt = { x: 0, y: 0 };
      app.shimmerOn = true;
      app.shimmerRamp = 1;
      app.shimmerTime = time;
      app.applyShownTilt();
      app.shimmerOn = false;
      app.shimmerRamp = 0;
      return app.tilt;
    }, time);
    report.shimmerFrames.push({ time, tilt: { x: +t.x.toFixed(2), y: +t.y.toFixed(2) } });
    await grab(page, `${OUT}/shimmer-fit-${i}.png`);
  }
  await setTilt({ x: 0, y: 0 });

  // ink tilted
  await load(page, R.barleycornInk);
  await reset();
  await setTilt({ x: 25, y: -15 });
  await settle();
  await grab(page, `${OUT}/barleycorn-ink-t25_-15.png`);
  await page.evaluate(() => {
    const v = window.__rose.app.workView;
    v.zoom(5, v.width * 0.55, v.height * 0.45);
  });
  await settle();
  await grab(page, `${OUT}/barleycorn-ink-zoom5-t25_-15.png`);
  // Turning mode, mid-cut, tilted
  await load(page, R.enamel, { frame: 'machine' });
  await reset();
  await page.evaluate(() => {
    const { store, app } = window.__rose;
    const total = app.toolpath.totalSamples;
    store.set({ playback: { ...store.get().playback, playing: false, progress: total * 0.55 } });
  });
  await setTilt({ x: 20, y: 18 });
  await settle(500);
  await grab(page, `${OUT}/enamel-turning-t20_18.png`);
  await page.screenshot({ path: `${OUT}/ui-turning-tilted.png` });
  await page.evaluate(() => window.__rose.store.set({ frame: 'work' }));

  // ── 3. PNG export ignores the tilt ──
  await load(page, R.barleycornMetal);
  const pngHash = async () => page.evaluate(async () => {
    const b = await window.__rose.app.renderPNG({ width: 900, height: 900, transparent: false });
    const buf = new Uint8Array(await b.arrayBuffer());
    const d = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(d)].slice(0, 8).map((x) => x.toString(16).padStart(2, '0')).join('');
  });
  await setTilt({ x: 0, y: 0 });
  await settle();
  const flatPng = await pngHash();
  await setTilt({ x: 25, y: -15 });
  await settle();
  const tiltPng = await pngHash();
  report.pngExportUnchanged = { flat: flatPng, tilted: tiltPng, equal: flatPng === tiltPng };

  // ── 4. interactions ──
  const rect = await page.evaluate(() => {
    const b = document.querySelector('.rose-work-view').getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
  const st = () => page.evaluate(() => {
    const s = window.__rose.store.get();
    const v = window.__rose.app.workView;
    return { tilt: s.tilt, shimmer: s.shimmer, cx: v.cx, cy: v.cy, mm: v.mmPerPx };
  });
  const ix = {};
  await setTilt({ x: 0, y: 0 });
  await reset();
  await settle();
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  // Shift+drag
  await page.keyboard.down('Shift');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy - 60, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  ix.shiftDrag = (await st()).tilt;
  // right-drag
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(cx - 80, cy, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  ix.rightDrag = (await st()).tilt;
  // pan while tilted: the plate point under the cursor follows it
  ix.panHold = await page.evaluate(() => {
    const v = window.__rose.app.workView;
    const p0 = { x: 0, y: 0 };
    v.proj.screenToPlate(v.width * 0.4, v.height * 0.4, p0);
    return p0;
  });
  await page.mouse.move(rect.x + rect.w * 0.4, rect.y + rect.h * 0.4);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.w * 0.55, rect.y + rect.h * 0.5, { steps: 8 });
  await page.mouse.up();
  ix.panHoldAfter = await page.evaluate(() => {
    const v = window.__rose.app.workView;
    const p1 = { x: 0, y: 0 };
    v.proj.screenToPlate(v.width * 0.55, v.height * 0.5, p1);
    return p1;
  });
  // wheel zoom while tilted keeps the plate point under the cursor
  ix.zoomHoldBefore = await page.evaluate(() => {
    const v = window.__rose.app.workView;
    const p = { x: 0, y: 0 };
    v.proj.screenToPlate(v.width * 0.3, v.height * 0.6, p);
    return p;
  });
  await page.mouse.move(rect.x + rect.w * 0.3, rect.y + rect.h * 0.6);
  await page.mouse.wheel(0, -400);
  await settle(200);
  ix.zoomHoldAfter = await page.evaluate(() => {
    const v = window.__rose.app.workView;
    const p = { x: 0, y: 0 };
    v.proj.screenToPlate(v.width * 0.3, v.height * 0.6, p);
    return { ...p, mm: v.mmPerPx };
  });
  // pad: keyboard
  await page.focus('[data-action="tilt"]');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowUp');
  ix.padKeys = (await st()).tilt;
  ix.padAria = await page.getAttribute('[data-action="tilt"]', 'aria-valuetext');
  await page.keyboard.press('Enter');
  ix.padEnterShimmer = (await st()).shimmer;
  await page.keyboard.press('Space');
  ix.padSpaceShimmer = (await st()).shimmer;
  // T toggles shimmer (focus elsewhere)
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('t');
  ix.tKey = (await st()).shimmer;
  await settle(1500);
  ix.shimmerMoves = await page.evaluate(() => window.__rose.app.tilt);
  // grabbing the pad stops the shimmer where the plate is
  const pad = await page.locator('[data-action="tilt"]').boundingBox();
  await page.mouse.move(pad.x + pad.width / 2, pad.y + pad.height / 2);
  await page.mouse.down();
  ix.grabStopsShimmer = await st();
  await page.mouse.move(pad.x + pad.width / 2 + 10, pad.y + pad.height / 2 - 6, { steps: 4 });
  await page.mouse.up();
  ix.padDrag = (await st()).tilt;
  // pad double-click levels the plate only
  const before = await st();
  await page.mouse.dblclick(pad.x + pad.width / 2, pad.y + pad.height / 2);
  const after = await st();
  ix.padDblclick = { tilt: after.tilt, zoomKept: after.mm === before.mm && after.cx === before.cx };
  // view double-click resets zoom, pan and tilt
  await setTilt({ x: 10, y: 5 });
  await page.mouse.dblclick(cx - 100, cy - 100);
  ix.viewDblclick = await st();
  report.interactions = ix;

  // ── 4b. GPU objects don't pile up when tilting on and off and switching modes ──
  const cycle = () => page.evaluate(async () => {
    const { store } = window.__rose;
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
    for (let i = 0; i < 16; i++) {
      store.set({ tilt: i % 2 ? { x: 0, y: 0 } : { x: 6 + i, y: -5 } });
      if (i % 4 === 0) store.setRecipe((r) => { r.mode = r.mode === 'metal' ? 'ink' : 'metal'; });
      await frames();
    }
    await frames();
    const info = window.__rose.app.gl.info;
    return { textures: info.memory.textures, geometries: info.memory.geometries, programs: info.programs.length, ...window.__glLive };
  });
  report.glLive = [await cycle(), await cycle(), await cycle()];

  // ── 5. shimmer timing ──
  const measure = async (label, ms = 5000) => {
    const r = await page.evaluate(async (ms) => {
      const { app } = window.__rose;
      let grooves = 0;
      let plans = 0;
      const g = app.drawGroove.bind(app);
      const pl = app.planPlate.bind(app);
      app.drawGroove = (...a) => { grooves++; return g(...a); };
      app.planPlate = (...a) => { plans++; return pl(...a); };
      let cpu = 0;
      const rf = app.renderFrame.bind(app);
      app.renderFrame = () => { const t = performance.now(); rf(); cpu += performance.now() - t; };
      const times = [];
      await new Promise((res) => {
        let last = 0;
        const t0 = performance.now();
        const f = (now) => {
          if (last) times.push(now - last);
          last = now;
          if (now - t0 < ms) requestAnimationFrame(f);
          else res();
        };
        requestAnimationFrame(f);
      });
      delete app.drawGroove;
      delete app.planPlate;
      delete app.renderFrame;
      times.sort((a, b) => a - b);
      const mean = times.reduce((a, b) => a + b, 0) / times.length;
      return {
        frames: times.length,
        fps: +(1000 / mean).toFixed(1),
        meanMs: +mean.toFixed(2),
        p95Ms: +times[Math.floor(times.length * 0.95)].toFixed(2),
        over20ms: times.filter((t) => t > 20).length,
        renderCpuMsPerFrame: +(cpu / times.length).toFixed(2),
        groovePasses: grooves,
        plans,
      };
    }, ms);
    return { label, ...r };
  };
  await load(page, R.barleycornMetal);
  await reset();
  await page.evaluate(() => window.__rose.store.set({ shimmer: true }));
  await settle(1500);
  report.timing = [await measure('work layout, metal barleycorn, dpr 1')];
  await page.evaluate(() => window.__rose.store.set({ layout: 'split' }));
  await settle(800);
  report.timing.push(await measure('split layout, metal barleycorn, dpr 1'));
  await load(page, R.enamel);
  await page.evaluate(() => window.__rose.store.set({ layout: 'work', shimmer: true }));
  await settle(1500);
  report.timing.push(await measure('work layout, enamel dial, dpr 1'));
  report.gpu = await page.evaluate(() => {
    const gl = window.__rose.app.gl.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  await page.evaluate(() => window.__rose.store.set({ shimmer: false }));
  await ctx.close();

  // retina laptop: 1440×900 at dpr 2
  {
    const { page, ctx } = await open({ width: 1440, height: 900 }, { deviceScaleFactor: 2 });
    await load(page, R.barleycornMetal);
    await page.evaluate(() => window.__rose.store.set({ shimmer: true }));
    await page.waitForTimeout(1500);
    const m = await page.evaluate(async () => {
      const times = [];
      await new Promise((res) => {
        let last = 0;
        const t0 = performance.now();
        const f = (now) => {
          if (last) times.push(now - last);
          last = now;
          if (now - t0 < 5000) requestAnimationFrame(f);
          else res();
        };
        requestAnimationFrame(f);
      });
      times.sort((a, b) => a - b);
      const mean = times.reduce((a, b) => a + b, 0) / times.length;
      const p = window.__rose.app.plate;
      return { fps: +(1000 / mean).toFixed(1), p95Ms: +times[Math.floor(times.length * 0.95)].toFixed(2), over20ms: times.filter((t) => t > 20).length, plateTarget: p && [p.w, p.h] };
    });
    report.timing.push({ label: 'work layout, metal barleycorn, dpr 2 (retina 1440×900)', ...m });
    await page.screenshot({ path: `${OUT}/ui-shimmer-dpr2.png` });
    await ctx.close();
  }

  // ── 6. mobile layout ──
  {
    const { page, ctx } = await open({ width: 390, height: 844 }, { deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await page.evaluate(() => window.__rose.store.set({ layout: 'split' }));
    await load(page, R.barleycornMetal, { layout: 'split' });
    await page.evaluate(() => window.__rose.store.set({ tilt: { x: 18, y: -10 } }));
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/mobile-390x844-split.png` });
    await page.evaluate(() => window.__rose.store.set({ layout: 'work' }));
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/mobile-390x844-work.png` });
    // touch: tap on the pad levels the plate
    const pad = await page.locator('[data-action="tilt"]').boundingBox();
    await page.touchscreen.tap(pad.x + pad.width / 2, pad.y + pad.height / 2);
    await page.waitForTimeout(200);
    report.mobileTapLevels = await page.evaluate(() => window.__rose.store.get().tilt);
    await ctx.close();
  }

  fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
