// Integration: wires the store, engine, renderer, playback, UI and exports together.
import { Store, type AppState } from './state/store';
import type { Recipe } from './state/recipe';
import { mountUI, type ToolpathInfo, type UIDeps } from './ui';
import { RenderApp } from './render/views';
import { Playback } from './render/playback';
import { createMachineModel } from './render/machine3d';
import { computeToolpath, prepare } from './engine';
import type { Prepared, Toolpath } from './engine/types';
import { mutateRecipe, randomRecipe } from './engine/random';
import { PRESETS, presetRecipe } from './presets';
import { readRecipeFromHash, writeRecipeToHash } from './state/url';
import { parsePreset, serializePreset } from './export/preset';
import { buildSVG } from './export/svg';
import { buildGcode } from './export/gcode';
import { exportPNG } from './export/png';
import { downloadBlob, downloadText } from './export/download';
import { fileName } from './export/filename';

const DEFAULT_SPEED = 4;

/** Symmetry and Fill to edge start locked, so Random keeps the user's choice until they unlock them.
 *  Locks are view state: share URLs and preset files carry only the recipe. */
const DEFAULT_LOCKS = ['symmetry.order', 'symmetry.mirror', 'machine.fillEdge'];

const store = new Store({ locks: [...DEFAULT_LOCKS], playback: { playing: false, speed: DEFAULT_SPEED, progress: 0 } });

// ---------- toolpath cache ----------
// Only these recipe parts change the geometry; mode/ink/metal edits reuse the same Toolpath object,
// which lets RenderApp skip the stroke-mesh rebuild.
const geometryKey = (r: Recipe) =>
  JSON.stringify([r.machine, r.rosettes, r.slide, r.eccentric, r.elliptical]);

let builtKey = '';
let prepared: Prepared | null = null;
let toolpath: Toolpath | null = null;
let toolpathInfo: ToolpathInfo | null = null;
let builtRecipe: Recipe | null = null;

function rebuild(recipe: Recipe): void {
  const key = geometryKey(recipe);
  if (key !== builtKey || !toolpath) {
    prepared = prepare(recipe);
    toolpath = computeToolpath(prepared);
    toolpathInfo = {
      totalSamples: toolpath.totalSamples,
      passes: toolpath.passes.length,
      passStarts: Int32Array.from(toolpath.passes, (p) => p.start),
    };
    builtKey = key;
  } else {
    // Same geometry: keep the toolpath, but refresh the recipe reference the engine data was built from.
    prepared = { ...prepared!, recipe };
  }
  builtRecipe = recipe;
}

// ---------- UI ----------
const root = document.getElementById('app')!;

/** Set by Random / Mutate / preset loads: the next rebuild starts the plotter drawing from zero. */
let autoplayNext = false;
let rebuildScheduled = 0;
let editFromProgress = 0;

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;
}

function current(): { recipe: Recipe; toolpath: Toolpath } {
  flushRebuild();
  return { recipe: store.get().recipe, toolpath: toolpath! };
}

function loadRecipe(recipe: Recipe): void {
  autoplayNext = true;
  store.setRecipe(recipe);
}

const deps: UIDeps = {
  random() {
    const s = store.get();
    loadRecipe(randomRecipe(randomSeed(), s.recipe, s.locks));
  },
  mutate() {
    const s = store.get();
    loadRecipe(mutateRecipe(s.recipe, randomSeed(), s.locks));
  },
  async share() {
    await writeRecipeToHash(store.get().recipe);
    await navigator.clipboard.writeText(location.href);
  },
  presets: PRESETS.map(({ id, name }) => ({ id, name })),
  loadPreset(id) {
    const r = presetRecipe(id);
    if (!r) throw new Error(`Unknown preset: ${id}`);
    loadRecipe(r);
  },
  getToolpathInfo: () => toolpathInfo,
  exportSVG(opts) {
    const { recipe, toolpath: tp } = current();
    downloadText(buildSVG(recipe, tp, opts), fileName(recipe, 'svg'), 'image/svg+xml');
  },
  async exportPNG(opts) {
    const { recipe } = current();
    const blob = await exportPNG(app, opts);
    downloadBlob(blob, fileName(recipe, 'png'));
  },
  previewGcode(opts) {
    const { recipe, toolpath: tp } = current();
    return buildGcode(recipe, tp, opts).stats;
  },
  exportGcode(opts) {
    const { recipe, toolpath: tp } = current();
    downloadText(buildGcode(recipe, tp, opts).text, fileName(recipe, 'gcode'), 'text/plain');
  },
  savePreset() {
    const { recipe } = current();
    downloadText(serializePreset(recipe), fileName(recipe, 'json'), 'application/json');
  },
  loadPresetText(text) {
    loadRecipe(parsePreset(text));
  },
  resetCamera: (preset) => app.setCameraPreset(preset),
};

const ui = mountUI(root, store, deps);

// ---------- renderer + playback ----------
const app = new RenderApp(ui.workViewport, {
  machine: createMachineModel(),
  onTilt: (t) => ui.showTilt(t),
  // grabbing the tilt on the view (or a double-click reset) takes over from the shimmer
  onTiltInput: (t) => store.set({ tilt: t, shimmer: false }),
});
app.attachWorkControls(ui.workControls);
const playback = new Playback(store, () => toolpath);

function flushRebuild(): void {
  if (rebuildScheduled) {
    cancelAnimationFrame(rebuildScheduled);
    rebuildScheduled = 0;
  }
  const recipe = store.get().recipe;
  if (recipe === builtRecipe && toolpath) return;
  const prevToolpath = toolpath;
  rebuild(recipe);
  app.setRecipe(recipe, prepared!, toolpath!);

  const pb = store.get().playback;
  const total = toolpath!.totalSamples;
  if (autoplayNext) {
    autoplayNext = false;
    const play = pb.speed > 0; // speed 0 = "Instant"
    store.set({ playback: { ...pb, progress: play ? 0 : total, playing: play } });
  } else if (pb.playing) {
    // Appearance-only edits (mode, ink, metal) keep the cut going from where it was instead of starting over.
    if (toolpath === prevToolpath) store.set({ playback: { ...pb, progress: Math.min(total, editFromProgress + pb.progress) } });
  } else {
    // Hand edits show the finished pattern straight away so tweaking feels immediate.
    store.set({ playback: { ...pb, progress: total } });
  }
  app.setProgress(store.get().playback.progress);
}

function scheduleRebuild(): void {
  if (!rebuildScheduled) rebuildScheduled = requestAnimationFrame(() => {
    rebuildScheduled = 0;
    flushRebuild();
  });
}

store.subscribe((s: AppState, prev: AppState) => {
  if (s.recipe !== prev.recipe) {
    // store.setRecipe/undo/redo rewind progress to 0; remember where the cut was for same-geometry edits.
    if (!rebuildScheduled) editFromProgress = prev.playback.progress;
    scheduleRebuild();
    return; // progress is applied after the rebuild
  }
  if (s.playback.progress !== prev.playback.progress && !rebuildScheduled) app.setProgress(s.playback.progress);
  if (s.layout !== prev.layout) app.setLayout(s.layout);
  if (s.frame !== prev.frame) app.setFrame(s.frame);
  if (s.camera !== prev.camera) app.setCameraPreset(s.camera);
  // shimmer first: a grab sets both, and the new base tilt must then apply without an ease-out
  if (s.shimmer !== prev.shimmer) app.setShimmer(s.shimmer);
  if (s.tilt !== prev.tilt) app.setTilt(s.tilt);
});

// ---------- boot ----------
const init = store.get();
app.setLayout(init.layout);
app.setFrame(init.frame);
app.setTilt(init.tilt);
app.setShimmer(init.shimmer);
autoplayNext = true; // first visit: let the plotter draw the opening pattern
flushRebuild();
playback.start();

readRecipeFromHash().then((r) => {
  if (r) {
    autoplayNext = true;
    store.setRecipe(r, { history: false });
  }
});

// Dev-only handle for browser QA scripts (dev/qa-*.mjs); stripped from production builds.
if (import.meta.env.DEV) Object.assign(window, { __rose: { store, app, playback } });

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    playback.stop();
    app.dispose();
    ui.dispose();
  });
}
