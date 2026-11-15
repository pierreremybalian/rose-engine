// Layered recipes: the base cut plus recipe.layers, cut one after another into the same plate.
//
// Each cut is an ordinary single-cut recipe (layerRecipe), prepared and computed on its own with a shared
// samples-per-rev, then joined into one Toolpath:
// - strokes keep their order (base cut first); Pass.index is global and sequential, Pass.cut / Pass.local say
//   which cut and which stroke within it;
// - sample indices and theta continue across cuts (theta stays monotonic);
// - metal: each cut's depth is folded into z (z + depth_cut - metal.baseDepth), so baseDepth + z is that cut's
//   groove depth everywhere (renderer, G-code). Ink: z is left alone (pen width is not a depth).
// Poses of a layered recipe carry `cut`; pass / slidePass inside them are local to that cut.
import type { Recipe } from '../state/recipe';
import type { Pass, Prepared, Toolpath } from './types';
import { chooseSamplesPerRev, computeToolpath, prepareCut, strokeCount, MAX_TOTAL_SAMPLES, MIN_SAMPLES_PER_REV, type EnginePrepared, type PrepareOptions } from './machine';

const TAU = Math.PI * 2;

export interface CutPart {
  /** 0 = base cut, i + 1 = recipe.layers[i]. */
  cut: number;
  recipe: Recipe;
  prepared: EnginePrepared;
  toolpath: Toolpath;
  /** Added to this cut's z in the joined toolpath (metal depth relative to metal.baseDepth). */
  zOffset: number;
  /** First sample / first stroke of this cut in the joined toolpath. */
  sampleOffset: number;
  passOffset: number;
}

/** Prepared form of a layered recipe. Every engine entry point accepts it in place of a single-cut Prepared. */
export interface LayeredPrepared extends Prepared {
  parts: CutPart[];
  toolpath: Toolpath;
}

export function isLayered(p: Prepared): p is LayeredPrepared {
  return Array.isArray((p as LayeredPrepared).parts);
}

/** True when the recipe has at least one enabled extra cut. */
export function hasLayers(r: Recipe): boolean {
  return Array.isArray(r.layers) && r.layers.some((l) => l.enabled);
}

/** Cut numbers that will be made: 0 (base) and every enabled layer (i + 1). */
export function cutNumbers(r: Recipe): number[] {
  const out = [0];
  (r.layers ?? []).forEach((l, i) => l.enabled && out.push(i + 1));
  return out;
}

/** Cut `cut` of a recipe as a single-cut recipe (0 = the base cut). */
export function layerRecipe(r: Recipe, cut: number): Recipe {
  if (cut <= 0) return { ...r, layers: [] };
  const l = r.layers[cut - 1];
  if (!l) throw new Error(`No cut ${cut}`);
  return {
    ...r,
    // Fill to edge is the base cut's: an extra cut stops at its own end radius (e.g. a centre-only fill).
    machine: { ...r.machine, fillEdge: false },
    rosettes: l.rosettes,
    slide: l.slide,
    straight: l.straight,
    eccentric: l.eccentric,
    elliptical: l.elliptical,
    mask: l.mask,
    metal: { ...r.metal, baseDepth: l.depth },
    layers: [],
  };
}

/** Depth a cut is made at (metal.baseDepth for the base cut). */
export function cutDepth(r: Recipe, cut: number): number {
  return cut <= 0 ? r.metal.baseDepth : (r.layers[cut - 1]?.depth ?? r.metal.baseDepth);
}

function revolutions(p: EnginePrepared): number {
  const r = p.recipe;
  const passes = Math.max(1, Math.round(r.slide.passes));
  return r.slide.spiral && !r.straight?.enabled ? passes * strokeCount(p) : strokeCount(p);
}

export function prepareLayered(recipe: Recipe, opts: PrepareOptions = {}): LayeredPrepared {
  const cuts = cutNumbers(recipe);
  const recipes = cuts.map((c) => layerRecipe(recipe, c));
  // One samples-per-rev for every cut: the finest any cut asks for, within the shared budget.
  const maxSamples = opts.maxSamples ?? MAX_TOTAL_SAMPLES;
  let spr = opts.samplesPerRev ?? Infinity;
  let revs = 0;
  for (const r of recipes) {
    const p = prepareCut(r, { maxSamples });
    revs += revolutions(p);
    if (!opts.samplesPerRev) spr = Math.min(spr, p.engine.samplesPerRev);
  }
  if (Number.isFinite(maxSamples)) spr = Math.min(spr, Math.floor((maxSamples - revs * 2) / Math.max(1, revs)));
  spr = Math.max(MIN_SAMPLES_PER_REV, Math.round(Number.isFinite(spr) ? spr : chooseSamplesPerRev(1, revs, 0, maxSamples)));

  const parts: CutPart[] = [];
  let sampleOffset = 0;
  let passOffset = 0;
  recipes.forEach((r, k) => {
    const prepared = prepareCut(r, { samplesPerRev: spr, maxSamples: Infinity });
    const toolpath = computeToolpath(prepared);
    const zOffset = recipe.mode === 'metal' ? cutDepth(recipe, cuts[k]) - recipe.metal.baseDepth : 0;
    parts.push({ cut: cuts[k], recipe: r, prepared, toolpath, zOffset, sampleOffset, passOffset });
    sampleOffset += toolpath.totalSamples;
    passOffset += toolpath.passes.length;
  });
  return { recipe, parts, toolpath: joinToolpaths(parts, spr) };
}

function joinToolpaths(parts: CutPart[], spr: number): Toolpath {
  const total = parts.reduce((a, p) => a + p.toolpath.totalSamples, 0);
  const x = new Float32Array(total);
  const y = new Float32Array(total);
  const z = new Float32Array(total);
  const theta = new Float32Array(total);
  const passes: Pass[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;
  let length = 0;
  let thetaOffset = 0;
  for (const part of parts) {
    const tp = part.toolpath;
    const o = part.sampleOffset;
    x.set(tp.x, o);
    y.set(tp.y, o);
    for (let i = 0; i < tp.totalSamples; i++) {
      z[o + i] = tp.z[i] + part.zOffset;
      theta[o + i] = tp.theta[i] + thetaOffset;
    }
    if (tp.totalSamples) thetaOffset = theta[o + tp.totalSamples - 1] + TAU;
    for (const p of tp.passes) passes.push({ ...p, index: passes.length, start: p.start + o, cut: part.cut, local: p.index });
    if (tp.totalSamples) {
      minX = Math.min(minX, tp.bounds.minX);
      minY = Math.min(minY, tp.bounds.minY);
      maxX = Math.max(maxX, tp.bounds.maxX);
      maxY = Math.max(maxY, tp.bounds.maxY);
      zMin = Math.min(zMin, tp.zMin + part.zOffset);
      zMax = Math.max(zMax, tp.zMax + part.zOffset);
    }
    length += tp.totalLength;
  }
  if (total === 0) minX = minY = maxX = maxY = zMin = zMax = 0;
  return { x, y, z, theta, passes, samplesPerRev: spr, totalSamples: total, zMin, zMax, bounds: { minX, minY, maxX, maxY }, totalLength: length };
}

/** The part a global stroke index belongs to. */
export function partOfPass(p: LayeredPrepared, pass: number): CutPart {
  let k = 0;
  while (k + 1 < p.parts.length && p.parts[k + 1].passOffset <= pass) k++;
  return p.parts[k];
}

/** The part a global sample index belongs to. */
export function partOfSample(p: LayeredPrepared, s: number): CutPart {
  let k = 0;
  while (k + 1 < p.parts.length && p.parts[k + 1].sampleOffset <= s) k++;
  return p.parts[k];
}

/** The part a pose came from (pose.cut), defaulting to the base cut. */
export function partOfCut(p: LayeredPrepared, cut: number | undefined): CutPart {
  return p.parts.find((x) => x.cut === (cut ?? 0)) ?? p.parts[0];
}
