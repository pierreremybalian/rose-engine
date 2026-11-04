// UI harness: real Store + stub deps. The viewport gets a cheap 2D placeholder drawing so screenshots read like the app.
import { profileValue } from '../src/engine/rosette';
import type { GcodeOptions, GcodeResult } from '../src/export/types';
import { passColor } from '../src/state/colors';
import type { Recipe } from '../src/state/recipe';
import { Store } from '../src/state/store';
import { mountUI, type ToolpathInfo, type UIDeps } from '../src/ui';

const params = new URLSearchParams(location.search);
const store = new Store({
  uiMode: params.get('ui') === 'advanced' ? 'advanced' : 'simple',
  layout: (params.get('layout') as 'split' | 'machine' | 'work') ?? 'split',
});
if (params.get('mode') === 'metal') {
  store.setRecipe((d) => {
    d.mode = 'metal';
    if (params.get('enamel')) d.metal.enamel = true;
  }, { history: false });
}

type Call = { name: string; args: unknown[] };
const calls: Call[] = [];
const w = window as unknown as { __calls: Call[]; __store: Store; __ui: unknown };
w.__calls = calls;
w.__store = store;
const log = (name: string, ...args: unknown[]) => {
  calls.push({ name, args });
  console.log('[deps]', name, ...args);
};

// ---- fake toolpath ----
const SPR = 1024;
let cached: { recipe: Recipe; info: ToolpathInfo } | null = null;
function info(): ToolpathInfo {
  const r = store.get().recipe;
  if (cached?.recipe === r) return cached.info;
  const passes = r.slide.passes * (r.eccentric.enabled ? r.eccentric.divisions : 1);
  const starts = new Uint32Array(passes);
  for (let i = 0; i < passes; i++) starts[i] = i * SPR;
  cached = { recipe: r, info: { totalSamples: passes * SPR, passes, passStarts: starts } };
  return cached.info;
}

let seedCounter = 48213;
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const locked = (k: string) => store.get().locks.includes(k);

const deps: UIDeps = {
  random() {
    log('random');
    seedCounter = Math.floor(Math.random() * 2 ** 31);
    store.setRecipe((d) => {
      d.seed = seedCounter;
      d.name = ['Barleycorn', 'Basket weave', 'Moiré wave', 'Flame', 'Rosace'][Math.floor(Math.random() * 5)];
      if (!locked('slide.passes')) d.slide.passes = Math.round(rnd(12, 90));
      if (!locked('rosettes')) {
        for (const ro of d.rosettes) {
          if (!locked(`rosettes.${ro.id}.lobes`)) ro.lobes = Math.round(rnd(3, 36));
          if (!locked(`rosettes.${ro.id}.amplitude`)) ro.amplitude = +rnd(0.4, 2.6).toFixed(2);
        }
      }
    });
  },
  mutate() {
    log('mutate');
    store.setRecipe((d) => {
      if (!locked('slide.phaseStep')) d.slide.phaseStep = +(d.slide.phaseStep + rnd(-1, 1)).toFixed(2);
      for (const ro of d.rosettes) if (!locked(`rosettes.${ro.id}.amplitude`)) ro.amplitude = Math.max(0, +(ro.amplitude + rnd(-0.2, 0.2)).toFixed(2));
    });
  },
  share() {
    log('share');
  },
  presets: [
    { id: 'barleycorn', name: 'Barleycorn' },
    { id: 'basket', name: 'Basket weave' },
    { id: 'moire', name: 'Moiré wave' },
    { id: 'flame', name: 'Flame' },
    { id: 'rosace', name: 'Eccentric rosace' },
    { id: 'ellipse', name: 'Elliptical sunburst' },
  ],
  loadPreset(id) {
    log('loadPreset', id);
    store.setRecipe((d) => {
      d.name = deps.presets.find((p) => p.id === id)?.name ?? id;
    });
  },
  getToolpathInfo: info,
  exportSVG(opts) {
    log('exportSVG', opts);
  },
  exportPNG(opts) {
    log('exportPNG', opts);
  },
  previewGcode(opts: GcodeOptions): GcodeResult['stats'] {
    log('previewGcode', opts);
    const r = store.get().recipe;
    const n = info().passes;
    let draw = 0;
    for (let i = 0; i < r.slide.passes; i++) {
      const rad = r.slide.startRadius + ((r.slide.endRadius - r.slide.startRadius) * i) / Math.max(1, r.slide.passes - 1);
      draw += 2 * Math.PI * rad;
    }
    draw *= n / r.slide.passes;
    const lines = Math.round(info().totalSamples / (1 + opts.tolerance * 400)) + n * 3 + 6;
    const travel = n * 4.2;
    const R = r.machine.workDiameter / 2;
    const off = opts.origin === 'center' ? 0 : R;
    return {
      lines,
      drawLength: draw,
      travelLength: travel,
      estimatedSeconds: (draw / opts.feedRate) * 60 + (travel / 3000) * 60 + n * 0.4,
      bounds: { minX: -R + off, minY: -R + off, maxX: R + off, maxY: R + off },
    };
  },
  exportGcode(opts) {
    log('exportGcode', opts);
  },
  savePreset() {
    log('savePreset');
  },
  loadPresetText(text) {
    log('loadPresetText', text.length);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('That file is not valid JSON.');
    }
    if (!data || typeof data !== 'object' || !('slide' in (data as object))) throw new Error('Not a rose-engine preset.');
  },
};

const ui = mountUI(document.getElementById('app')!, store, deps);
w.__ui = ui;

// ---- placeholder viewport ----
const vp = ui.workViewport;
const canvas = document.createElement('canvas');
canvas.className = 'absolute inset-0 size-full';
vp.appendChild(canvas);
const ctx = canvas.getContext('2d')!;

function drawWork(x0: number, y0: number, size: number, r: Recipe, progress: number) {
  const R = size * 0.44;
  const cx = x0 + size / 2;
  const cy = y0 + size / 2;
  const s = R / (r.machine.workDiameter / 2);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  if (r.mode === 'ink') {
    ctx.fillStyle = r.ink.paper;
    ctx.shadowColor = 'rgba(0,0,0,.6)';
    ctx.shadowBlur = 30;
  } else {
    const g = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.4, R * 0.1, cx, cy, R);
    const m: Record<string, [string, string]> = { silver: ['#f1f1ef', '#8d8e8c'], gold: ['#fbe6a2', '#9a7420'], rose: ['#f6cdb8', '#9c5d48'], brass: ['#f0d999', '#8a6a2a'], steel: ['#d5d9dd', '#5d646b'], blued: ['#6f90d6', '#16265a'] };
    const [a, b] = m[r.metal.material];
    g.addColorStop(0, a);
    g.addColorStop(1, b);
    ctx.fillStyle = g;
  }
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();
  const { slide } = r;
  const passes = slide.passes;
  const reveal = progress / SPR;
  const ros = r.rosettes.filter((x) => x.enabled && x.axis === 'rock');
  ctx.lineWidth = Math.max(0.6, r.ink.lineWidth * s);
  ctx.globalAlpha = r.mode === 'ink' ? r.ink.opacity : 0.55;
  for (let p = 0; p < passes && p < reveal; p++) {
    const frac = Math.min(1, reveal - p);
    const t = passes > 1 ? p / (passes - 1) : 0;
    const rad = slide.startRadius + (slide.endRadius - slide.startRadius) * t;
    const taper = 1 + (slide.amplitudeTaper - 1) * t;
    let ph = 0;
    if (slide.phaseMode === 'linear') ph = (p * slide.phaseStep) / 360;
    else if (slide.phaseMode === 'custom') ph = (slide.phaseCustom[p % Math.max(1, slide.phaseCustom.length)] ?? 0) / 360;
    ctx.strokeStyle = r.mode === 'ink' ? passColor(r.ink, p, passes) : 'rgba(20,16,10,.85)';
    ctx.beginPath();
    const steps = 720;
    for (let i = 0; i <= steps * frac; i++) {
      const th = (i / steps) * Math.PI * 2;
      let d = 0;
      for (const ro of ros) {
        let phase = ph * ro.lobes;
        if (slide.phaseMode === 'alternate' && Math.floor(p / slide.alternateEvery) % 2 === 1) phase += slide.alternateFraction;
        d += ro.amplitude * taper * profileValue(ro.profile, (ro.lobes * th) / (Math.PI * 2) + phase + (ro.phase / 360) * ro.lobes);
      }
      const rr = (rad + d) * s;
      const x = cx + rr * Math.cos(th);
      const y = cy - rr * Math.sin(th);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
  if (r.mode === 'metal' && r.metal.enamel) {
    ctx.save();
    ctx.globalAlpha = r.metal.enamelOpacity * 0.75;
    ctx.fillStyle = r.metal.enamelColor;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawMachine(x0: number, y0: number, wd: number, ht: number) {
  ctx.save();
  ctx.fillStyle = '#0d0b09';
  ctx.fillRect(x0, y0, wd, ht);
  ctx.strokeStyle = 'rgba(211,172,98,.10)';
  for (let x = x0; x < x0 + wd; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y0 + ht);
    ctx.stroke();
  }
  for (let y = y0; y < y0 + ht; y += 32) {
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + wd, y);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(211,172,98,.35)';
  ctx.font = 'italic 18px "Bodoni Moda", serif';
  ctx.textAlign = 'center';
  ctx.fillText('3D machine placeholder', x0 + wd / 2, y0 + ht / 2);
  ctx.restore();
}

function draw() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const W = vp.clientWidth;
  const H = vp.clientHeight;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const s = store.get();
  ctx.fillStyle = '#0a0907';
  ctx.fillRect(0, 0, W, H);
  if (s.layout === 'machine') return drawMachine(0, 0, W, H);
  if (s.layout === 'split') {
    const vertical = W < 700;
    if (vertical) {
      drawMachine(0, 0, W, H / 2);
      drawWork((W - Math.min(W, H / 2)) / 2, H / 2, Math.min(W, H / 2), s.recipe, s.playback.progress);
    } else {
      drawMachine(0, 0, W / 2, H);
      const size = Math.min(W / 2, H);
      drawWork(W / 2 + (W / 2 - size) / 2, (H - size) / 2, size, s.recipe, s.playback.progress);
    }
    return;
  }
  const size = Math.min(W, H);
  drawWork((W - size) / 2, (H - size) / 2, size, s.recipe, s.playback.progress);
}

// Fake playback clock.
let last = performance.now();
function tick(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const s = store.get();
  const total = info().totalSamples;
  if (s.playback.playing) {
    const next = s.playback.speed === 0 ? total : Math.min(total, s.playback.progress + s.playback.speed * SPR * dt);
    store.set({ playback: { ...s.playback, progress: next, playing: next < total } });
  }
  draw();
  requestAnimationFrame(tick);
}
if (params.get('progress') !== 'none') store.set({ playback: { ...store.get().playback, progress: info().totalSamples * Number(params.get('progress') ?? 1) } });
requestAnimationFrame(tick);
