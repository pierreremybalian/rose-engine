// Engine preview: renders recipes to SVG (pure strings, no DOM). Rasterised by tests/engine/preview.test.ts
// (run with PREVIEW=1 npx vitest run tests/engine/preview.test.ts).
import { defaultRecipe, defaultRosette, type Recipe } from '../src/state/recipe';
import { computeToolpath, prepare, simplifyPolyline } from '../src/engine';
import type { Toolpath } from '../src/engine/types';

export interface PreviewCase {
  name: string;
  recipe: Recipe;
  /** Optional zoom window in mm: [cx, cy, halfSize]. */
  zoom?: [number, number, number];
}

function make(name: string, edit: (r: Recipe) => void, zoom?: [number, number, number]): PreviewCase {
  const r = defaultRecipe();
  r.name = name;
  edit(r);
  return { name, recipe: r, zoom };
}

export const PREVIEW_CASES: PreviewCase[] = [
  make('barleycorn-default', () => {}, [20, 20, 12]),
  make('linear-drift', (r) => {
    r.rosettes = [defaultRosette({ lobes: 18, amplitude: 1.6, profile: 'sine' })];
    r.slide = { ...r.slide, passes: 90, startRadius: 4, endRadius: 46, phaseMode: 'linear', phaseStep: 1.2 };
  }),
  make('basket-weave', (r) => {
    r.rosettes = [defaultRosette({ lobes: 24, amplitude: 1.1, profile: 'sine' })];
    r.slide = { ...r.slide, passes: 72, startRadius: 6, endRadius: 46, phaseMode: 'alternate', alternateEvery: 3, alternateFraction: 0.5 };
  }, [24, 18, 10]),
  make('eccentric-8', (r) => {
    r.rosettes = [defaultRosette({ lobes: 10, amplitude: 0.8, profile: 'sine' })];
    r.slide = { ...r.slide, passes: 14, startRadius: 6, endRadius: 17, phaseMode: 'linear', phaseStep: 0 };
    r.eccentric = { enabled: true, offset: 16, angle: 90, divisions: 8, divisionStep: 0 };
  }),
  make('elliptical', (r) => {
    r.rosettes = [defaultRosette({ lobes: 16, amplitude: 1.4, profile: 'convex' })];
    r.slide = { ...r.slide, passes: 40, startRadius: 10, endRadius: 40, phaseMode: 'alternate', alternateEvery: 1 };
    r.elliptical = { enabled: true, e: 8, angle: 30 };
  }),
  make('spiral', (r) => {
    r.rosettes = [defaultRosette({ lobes: 20, amplitude: 1.3, profile: 'sine' })];
    r.slide = { ...r.slide, passes: 45, startRadius: 3, endRadius: 46, phaseMode: 'linear', phaseStep: 4, spiral: true };
  }),
  make('spiral-alternate', (r) => {
    r.rosettes = [defaultRosette({ lobes: 20, amplitude: 1.0, profile: 'sine' })];
    r.slide = { ...r.slide, passes: 40, startRadius: 6, endRadius: 46, phaseMode: 'alternate', alternateEvery: 1, spiral: true };
  }, [30, -5, 9]),
  make('concave-rubber-0', (r) => {
    r.rosettes = [defaultRosette({ lobes: 24, amplitude: 3, profile: 'concave' })];
    r.slide = { ...r.slide, passes: 36, startRadius: 10, endRadius: 46, phaseMode: 'alternate', alternateEvery: 1 };
    r.machine.rubberRadius = 0;
  }, [24, 20, 10]),
  make('concave-rubber-8', (r) => {
    r.rosettes = [defaultRosette({ lobes: 24, amplitude: 3, profile: 'concave' })];
    r.slide = { ...r.slide, passes: 36, startRadius: 10, endRadius: 46, phaseMode: 'alternate', alternateEvery: 1 };
    r.machine.rubberRadius = 8;
  }, [24, 20, 10]),
  make('flame-taper-pump', (r) => {
    r.rosettes = [
      defaultRosette({ lobes: 9, amplitude: 2.2, profile: 'flame' }),
      defaultRosette({ lobes: 36, amplitude: 0.25, profile: 'sine', axis: 'pump' }),
    ];
    r.slide = { ...r.slide, passes: 60, startRadius: 4, endRadius: 46, phaseMode: 'linear', phaseStep: 2.5, amplitudeTaper: 0.3 };
  }),
];

export interface SvgPreviewOptions {
  px: number;
  /** [cx, cy, halfSize] in mm; default = the whole work disc. */
  view?: [number, number, number];
  penWidth: number;
  tolerance: number;
}

export function previewSVG(recipe: Recipe, tp: Toolpath, o: SvgPreviewOptions): string {
  const half = o.view ? o.view[2] : recipe.machine.workDiameter / 2 + 2;
  const cx = o.view ? o.view[0] : 0;
  const cy = o.view ? o.view[1] : 0;
  const parts: string[] = [];
  const colors = ['#1d2a5c', '#7a2a3a', '#2f6b4f'];
  for (const pass of tp.passes) {
    const idx = simplifyPolyline(tp.x, tp.y, pass.start, pass.count, o.tolerance, pass.closed);
    let d = '';
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      d += `${k ? 'L' : 'M'}${tp.x[i].toFixed(3)} ${(-tp.y[i]).toFixed(3)}`;
    }
    if (pass.closed) d += 'Z';
    const col = recipe.eccentric.enabled ? colors[pass.division % colors.length] : colors[0];
    parts.push(`<path d="${d}" stroke="${col}"/>`);
  }
  const vb = `${cx - half} ${-cy - half} ${2 * half} ${2 * half}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${o.px}" height="${o.px}" viewBox="${vb}">
<rect x="${cx - half}" y="${-cy - half}" width="${2 * half}" height="${2 * half}" fill="#f4efe4"/>
<circle cx="0" cy="0" r="${recipe.machine.workDiameter / 2}" fill="none" stroke="#c9bfa8" stroke-width="0.2"/>
<g fill="none" stroke-width="${o.penWidth}" stroke-linejoin="round" stroke-linecap="round" stroke-opacity="0.92">
${parts.join('\n')}
</g></svg>`;
}

export function renderCase(c: PreviewCase): { full: string; zoom: string | null; stats: string } {
  const t0 = performance.now();
  const p = prepare(c.recipe);
  const tp = computeToolpath(p);
  const ms = performance.now() - t0;
  const full = previewSVG(c.recipe, tp, { px: 1400, penWidth: 0.13, tolerance: 0.005 });
  const zoom = c.zoom ? previewSVG(c.recipe, tp, { px: 1000, view: c.zoom, penWidth: 0.08, tolerance: 0.002 }) : null;
  const stats = `${c.name}: ${tp.passes.length} strokes, ${tp.totalSamples} samples @ ${tp.samplesPerRev}/rev, ${ms.toFixed(1)} ms, length ${(tp.totalLength / 1000).toFixed(2)} m, z ${tp.zMin.toFixed(2)}..${tp.zMax.toFixed(2)}`;
  return { full, zoom, stats };
}
