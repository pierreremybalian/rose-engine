// Shared helpers for the dev/qa-*.mjs browser checks.
import { chromium } from 'playwright';

export const OUT = 'dev/screenshots/qa';

/** Counts live WebGL objects so leaks show up across repeated actions. */
const GL_COUNTER = () => {
  const live = { texture: 0, buffer: 0, framebuffer: 0, renderbuffer: 0, program: 0, vertexArray: 0 };
  window.__glLive = live;
  for (const C of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!C) continue;
    const P = C.prototype;
    for (const k of Object.keys(live)) {
      const cap = k[0].toUpperCase() + k.slice(1);
      const cr = P['create' + cap];
      const de = P['delete' + cap];
      if (!cr || !de) continue;
      const seen = new WeakSet();
      P['create' + cap] = function (...a) {
        const o = cr.apply(this, a);
        if (o) {
          live[k]++;
          seen.add(o);
        }
        return o;
      };
      P['delete' + cap] = function (o) {
        if (o && seen.has(o)) {
          live[k]--;
          seen.delete(o);
        }
        return de.call(this, o);
      };
    }
  }
};

export async function launch({ width = 1440, height = 900, url = 'http://127.0.0.1:5173/', hash = '' } = {}) {
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--enable-precise-memory-info'] });
  const context = await browser.newContext({ viewport: { width, height }, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const log = [];
  let section = 'boot';
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') log.push(`[${section}] ${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => log.push(`[${section}] pageerror: ${e.message}`));
  await page.addInitScript(GL_COUNTER);
  await page.goto(url + hash);
  await page.waitForFunction(() => window.__rose);
  return {
    browser,
    context,
    page,
    log,
    setSection: (s) => (section = s),
  };
}

export const state = (page) => page.evaluate(() => {
  const s = window.__rose.store.get();
  return { recipe: s.recipe, locks: s.locks, layout: s.layout, frame: s.frame, camera: s.camera, uiMode: s.uiMode, playback: s.playback };
});

export const total = (page) => page.evaluate(() => {
  const tp = window.__rose.app.toolpath ?? null;
  return tp ? tp.totalSamples : null;
});

export const readout = async (page) => (await page.textContent('[data-readout="pass"]')).replace(/\s+/g, ' ').trim();

export async function shot(page, name, clip) {
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path, clip });
  return path;
}

/** Device-independent rectangles of the 3D and flat viewports (overlay divs placed by RenderApp). */
export async function rects(page) {
  return page.evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      if (!el || el.style.display === 'none') return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    };
    return { machine: r('.rose-machine-view'), work: r('.rose-work-view') };
  });
}

export async function glInfo(page) {
  return page.evaluate(() => {
    const info = window.__rose.app.gl.info;
    return { geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs?.length ?? 0, live: { ...window.__glLive } };
  });
}

export async function heapMB(page, cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  return +(usedSize / 1048576).toFixed(1);
}

/** Wait until the playback stops (end reached) or the timeout passes. */
export async function waitStopped(page, timeout = 30000) {
  await page.waitForFunction(() => !window.__rose.store.get().playback.playing, null, { timeout });
}

export async function pause(page) {
  await page.evaluate(() => {
    const s = window.__rose.store;
    const p = s.get().playback;
    if (p.playing) s.set({ playback: { ...p, playing: false } });
  });
}
