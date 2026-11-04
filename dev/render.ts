// Render-module harness: real engine (falls back to the synthetic fixture), real or stub machine model.
import { RenderApp } from '../src/render/views';
import { Playback } from '../src/render/playback';
import { Store } from '../src/state/store';
import { cloneRecipe, defaultRecipe, type MetalKind, type Recipe } from '../src/state/recipe';
import type { Prepared, Toolpath } from '../src/engine/types';
import type { IMachineModel } from '../src/render/types';
import * as engine from '../src/engine';
import { createStubMachine, fixturePrepared, fixtureToolpath, LARGE_FIXTURE } from './fixtures';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

let presets: { id: string; name: string; recipe: Recipe }[] = [];
try {
  presets = (await import('../src/presets')).PRESETS;
} catch (e) {
  console.warn('[harness] presets unavailable', e);
}

async function makeMachine(kind: string): Promise<IMachineModel> {
  if (kind !== 'stub') {
    try {
      const m = await import('../src/render/machine3d');
      return m.createMachineModel();
    } catch (e) {
      console.warn('[harness] machine3d unavailable, using stub', e);
    }
  }
  return createStubMachine();
}

const machineKind = params.get('machine') ?? 'real';
$<HTMLSelectElement>('machine').value = machineKind;
const machine = await makeMachine(machineKind);

const store = new Store({ layout: (params.get('layout') as never) ?? 'split' });
let frames = 0;
let fpsT0 = performance.now();
let fps = 0;
const app = new RenderApp($('view'), {
  machine,
  onFrame: () => {
    frames++;
    const now = performance.now();
    if (now - fpsT0 >= 1000) {
      fps = (frames * 1000) / (now - fpsT0);
      frames = 0;
      fpsT0 = now;
      const st = store.get();
      $('stats').textContent = `${fps.toFixed(0)} fps · ${tp ? tp.totalSamples.toLocaleString() : 0} samples · ${Math.round(st.playback.progress).toLocaleString()}`;
      if (st.playback.playing) console.log(`[harness] fps ${fps.toFixed(1)} progress ${Math.round(st.playback.progress)}`);
    }
  },
});

let prepared: Prepared | null = null;
let tp: Toolpath | null = null;
let large = params.get('size') === 'large';
let geomKey = '';

function geometryKey(r: Recipe): string {
  const { mode: _m, ink: _i, metal: _t, name: _n, seed: _s, ...rest } = r;
  return JSON.stringify(rest) + (large ? ':large' : '');
}

function largeRecipe(r: Recipe): Recipe {
  const x = cloneRecipe(r);
  x.rosettes = [{ ...x.rosettes[0], lobes: 180, amplitude: 0.35, axis: 'rock', enabled: true, profile: 'sine' }];
  x.rosettes.push({ id: 'pump', enabled: true, axis: 'pump', lobes: 9, amplitude: 0.04, profile: 'sine', phase: 0 });
  x.slide = { ...x.slide, passes: 190, startRadius: 4, endRadius: 48, phaseMode: 'alternate', alternateEvery: 1, alternateFraction: 0.5 };
  return x;
}

function rebuild(recipe: Recipe): void {
  const r = large ? largeRecipe(recipe) : recipe;
  const key = geometryKey(recipe);
  const t0 = performance.now();
  if (key !== geomKey || !tp || !prepared) {
    try {
      prepared = engine.prepare(r);
      tp = engine.computeToolpath(prepared);
    } catch (e) {
      console.warn('[harness] engine failed, using fixture', e);
      prepared = fixturePrepared(r);
      tp = fixtureToolpath(LARGE_FIXTURE);
    }
    geomKey = key;
  } else {
    prepared = { ...prepared, recipe: r };
  }
  const t1 = performance.now();
  app.setRecipe(r, prepared, tp);
  const t2 = performance.now();
  console.log(`[harness] toolpath ${tp.totalSamples} samples in ${(t1 - t0).toFixed(1)}ms, setRecipe ${(t2 - t1).toFixed(1)}ms`);
}

const playback = new Playback(store, () => tp);
playback.start();

store.subscribe((s, prev) => {
  if (s.recipe !== prev.recipe) {
    rebuild(s.recipe);
    if (!s.playback.playing && tp) {
      store.set({ playback: { ...s.playback, progress: tp.totalSamples } });
      return;
    }
  }
  if (s.playback.progress !== prev.playback.progress || s.recipe !== prev.recipe) app.setProgress(s.playback.progress);
  if (s.layout !== prev.layout) app.setLayout(s.layout);
  if (s.frame !== prev.frame) app.setFrame(s.frame);
  if (s.camera !== prev.camera) app.setCameraPreset(s.camera);
  syncControls();
});

function syncControls(): void {
  const s = store.get();
  $<HTMLButtonElement>('play').textContent = s.playback.playing ? 'Pause' : 'Play';
  const total = tp?.totalSamples ?? 1;
  $<HTMLInputElement>('scrub').value = String(s.playback.progress / total);
  $<HTMLSelectElement>('mode').value = s.recipe.mode;
  $<HTMLSelectElement>('material').value = s.recipe.metal.material;
  $<HTMLInputElement>('enamel').checked = s.recipe.metal.enamel;
  $<HTMLInputElement>('enamelColor').value = s.recipe.metal.enamelColor;
}

// controls
const presetSel = $<HTMLSelectElement>('preset');
presetSel.innerHTML = `<option value="">default</option>` + presets.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
presetSel.onchange = () => {
  const p = presets.find((x) => x.id === presetSel.value);
  store.setRecipe(p ? cloneRecipe(p.recipe) : defaultRecipe());
};
$<HTMLSelectElement>('size').value = large ? 'large' : 'normal';
$<HTMLSelectElement>('size').onchange = (e) => {
  large = (e.target as HTMLSelectElement).value === 'large';
  store.setRecipe(cloneRecipe(store.get().recipe));
};
$<HTMLSelectElement>('mode').onchange = (e) => store.setRecipe((d) => void (d.mode = (e.target as HTMLSelectElement).value as Recipe['mode']));
$<HTMLSelectElement>('layout').onchange = (e) => store.set({ layout: (e.target as HTMLSelectElement).value as never });
$<HTMLSelectElement>('frame').onchange = (e) => store.set({ frame: (e.target as HTMLSelectElement).value as never });
$<HTMLSelectElement>('camera').onchange = (e) => store.set({ camera: (e.target as HTMLSelectElement).value as never });
$<HTMLSelectElement>('speed').onchange = (e) => {
  const pb = store.get().playback;
  store.set({ playback: { ...pb, speed: Number((e.target as HTMLSelectElement).value) } });
};
$<HTMLButtonElement>('play').onclick = () => {
  const pb = store.get().playback;
  store.set({ playback: { ...pb, playing: !pb.playing, speed: Number($<HTMLSelectElement>('speed').value) } });
};
$<HTMLInputElement>('scrub').oninput = (e) => {
  const pb = store.get().playback;
  store.set({ playback: { ...pb, playing: false, progress: Number((e.target as HTMLInputElement).value) * (tp?.totalSamples ?? 0) } });
};
$<HTMLSelectElement>('material').onchange = (e) =>
  store.setRecipe((d) => void (d.metal.material = (e.target as HTMLSelectElement).value as MetalKind));
$<HTMLInputElement>('enamel').onchange = (e) => store.setRecipe((d) => void (d.metal.enamel = (e.target as HTMLInputElement).checked));
$<HTMLInputElement>('enamelColor').oninput = (e) =>
  store.setRecipe((d) => void (d.metal.enamelColor = (e.target as HTMLInputElement).value), { coalesce: true });
$<HTMLInputElement>('light').oninput = (e) =>
  store.setRecipe((d) => void (d.metal.lightAngle = Number((e.target as HTMLInputElement).value)), { coalesce: true });
$<HTMLButtonElement>('zoom8').onclick = () => app.workView.zoom(8);
$<HTMLButtonElement>('reset').onclick = () => app.resetWorkView();
$<HTMLButtonElement>('png').onclick = async () => {
  const blob = await app.renderPNG({ width: 2048, height: 2048, transparent: store.get().recipe.mode === 'ink' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'rose.png';
  a.click();
};
$<HTMLSelectElement>('machine').onchange = (e) => {
  params.set('machine', (e.target as HTMLSelectElement).value);
  location.search = params.toString();
};

// initial recipe
const initial = presets.find((p) => p.id === params.get('preset'));
if (initial) presetSel.value = initial.id;
const r0 = initial ? cloneRecipe(initial.recipe) : defaultRecipe();
if (params.get('mode')) r0.mode = params.get('mode') as Recipe['mode'];
store.setRecipe(r0, { history: false });
app.setLayout(store.get().layout);

declare global {
  interface Window {
    __rose: unknown;
  }
}
window.__rose = {
  app,
  store,
  playback,
  get toolpath() {
    return tp;
  },
  get fps() {
    return fps;
  },
  presets,
};
