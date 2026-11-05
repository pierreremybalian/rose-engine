// Rose engine kinematics: recipe -> poses -> toolpath. Pure TS, no DOM.
//
// Conventions (also see types.ts):
// - The rubber touches every rosette on the +X side of the machine (same side as the tool), so at
//   spindle angle theta the contact point is at rosette-frame angle phi = -theta, and
//   rock = sum over rock rosettes of amplitude * taper * follower(u),
//   u = lobes * phi / 2pi + (rosette.phase + passPhase) * lobes / 360   (same u as rosetteRadiusAt).
//   The pattern on the work is therefore an upright copy of the rosette's shape.
// - Pump rosettes use the same u with the raw profile (face cam, no rubber envelope).
// - Spiral: each eccentric division is one open stroke, theta in [0, 2pi*passes]. With q = theta/2pi,
//   radius and taper ramp linearly in q (start -> end over q = 0..passes). Linear phase drifts
//   continuously (q * phaseStep). Alternate/custom phases step at revolution boundaries, blended with a
//   smoothstep over the first lobe of the new revolution so the open path stays continuous.
// - End radius: every path (concentric and spiral) runs to effectiveEndRadius(recipe) (src/engine/plate.ts):
//   slide.endRadius, or with machine.fillEdge the radius that carries the last pass past the plate rim.
import type { ProfileKind, Recipe } from '../state/recipe';
import type { Pass, Pose, Prepared, Toolpath } from './types';
import { buildRubberTable, profileValue, sampleTable, RUBBER_TABLE_SIZE } from './rosette';
import { makeChuckXform, toolToWork, workPlacementXf, type ChuckXform } from './chucks';
import { effectiveEndRadius } from './plate';

const TAU = Math.PI * 2;

export const MIN_SAMPLES_PER_REV = 256;
export const MAX_SAMPLES_PER_REV = 8192;
export const BASE_SAMPLES_PER_REV = 1024;
export const SAMPLES_PER_LOBE = 48;
export const MAX_TOTAL_SAMPLES = 1_500_000;

interface RosetteRT {
  /** Index in recipe.rosettes. */
  index: number;
  lobes: number;
  amplitude: number;
  profile: ProfileKind;
  /** rosette.phase converted to lobes (u units). */
  phaseU: number;
  /** Rubber follower table (full amplitude), or null for the raw profile. */
  table: Float64Array | null;
  /** Spiral blend window, revolutions. */
  blend: number;
}

interface EngineData {
  passes: number;
  divisions: number;
  spiral: boolean;
  startR: number;
  endR: number;
  taperEnd: number;
  phaseMode: 'linear' | 'alternate' | 'custom';
  phaseStep: number;
  altEvery: number;
  altFrac: number;
  custom: number[];
  rock: RosetteRT[];
  pump: RosetteRT[];
  all: RosetteRT[];
  xf: ChuckXform;
  samplesPerRev: number;
  maxLobes: number;
}

/** Prepared recipe. `engine` is private to the engine; treat it as opaque. */
export interface EnginePrepared extends Prepared {
  engine: EngineData;
}

export interface PrepareOptions {
  /** Force a samples-per-rev value (still capped by maxSamples unless maxSamples is Infinity). */
  samplesPerRev?: number;
  /** Total sample budget. Default 1.5M. */
  maxSamples?: number;
}

// ---------------------------------------------------------------------------------------------
// Rubber table cache (tables depend only on profile / lobes / amplitude / radii).
// ---------------------------------------------------------------------------------------------
const tableCache = new Map<string, Float64Array>();
const TABLE_CACHE_MAX = 48;

function rubberTable(kind: ProfileKind, lobes: number, amp: number, base: number, r: number): Float64Array {
  const key = `${kind}|${lobes}|${amp}|${base}|${r}`;
  let t = tableCache.get(key);
  if (t) {
    tableCache.delete(key);
    tableCache.set(key, t);
    return t;
  }
  t = buildRubberTable(kind, lobes, amp, base, r, RUBBER_TABLE_SIZE);
  tableCache.set(key, t);
  if (tableCache.size > TABLE_CACHE_MAX) {
    const first = tableCache.keys().next().value;
    if (first !== undefined) tableCache.delete(first);
  }
  return t;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function getEngine(prepared: Prepared): EngineData {
  const e = (prepared as EnginePrepared).engine;
  if (!e) throw new Error('engine: Prepared was not created by prepare()');
  return e;
}

/** Samples per revolution for a given lobe count and stroke/rev layout. */
export function chooseSamplesPerRev(maxLobes: number, totalRevs: number, extraSamples: number, maxSamples = MAX_TOTAL_SAMPLES): number {
  let spr = Math.min(MAX_SAMPLES_PER_REV, Math.max(BASE_SAMPLES_PER_REV, Math.round(maxLobes * SAMPLES_PER_LOBE)));
  const fit = Math.floor((maxSamples - extraSamples) / Math.max(1, totalRevs));
  if (spr > fit) spr = fit;
  return Math.max(MIN_SAMPLES_PER_REV, spr);
}

export function prepare(recipe: Recipe, opts: PrepareOptions = {}): EnginePrepared {
  const s = recipe.slide;
  const passes = Math.max(1, Math.round(num(s.passes, 1)));
  const spiral = !!s.spiral;
  const xf = makeChuckXform(recipe);
  const base = num(recipe.machine?.rosetteRadius, 60);
  const rubber = Math.max(0, num(recipe.machine?.rubberRadius, 0));

  const rock: RosetteRT[] = [];
  const pump: RosetteRT[] = [];
  const all: RosetteRT[] = [];
  let maxLobes = 0;
  recipe.rosettes.forEach((r, index) => {
    if (!r.enabled) return;
    const lobes = Math.max(1, Math.round(num(r.lobes, 1)));
    const amplitude = num(r.amplitude, 0);
    maxLobes = Math.max(maxLobes, lobes);
    const isRock = r.axis !== 'pump';
    const rt: RosetteRT = {
      index,
      lobes,
      amplitude,
      profile: r.profile,
      phaseU: (num(r.phase, 0) * lobes) / 360,
      table: isRock && rubber > 0 && amplitude !== 0 ? rubberTable(r.profile, lobes, amplitude, base, rubber) : null,
      blend: Math.min(0.5, 1 / lobes),
    };
    (isRock ? rock : pump).push(rt);
    all.push(rt);
  });

  const totalRevs = passes * xf.divisions;
  const extra = spiral ? xf.divisions : 0;
  const maxSamples = opts.maxSamples ?? MAX_TOTAL_SAMPLES;
  let spr: number;
  if (opts.samplesPerRev && opts.samplesPerRev > 0) {
    spr = Math.round(opts.samplesPerRev);
    if (Number.isFinite(maxSamples)) spr = Math.min(spr, Math.max(MIN_SAMPLES_PER_REV, Math.floor((maxSamples - extra) / totalRevs)));
  } else {
    spr = chooseSamplesPerRev(maxLobes, totalRevs, extra, maxSamples);
  }

  const engine: EngineData = {
    passes,
    divisions: xf.divisions,
    spiral,
    startR: num(s.startRadius, 0),
    endR: num(effectiveEndRadius(recipe), num(s.endRadius, 0)),
    taperEnd: num(s.amplitudeTaper, 1),
    phaseMode: s.phaseMode,
    phaseStep: num(s.phaseStep, 0),
    altEvery: Math.max(1, Math.round(num(s.alternateEvery, 1))),
    altFrac: num(s.alternateFraction, 0),
    custom: Array.isArray(s.phaseCustom) ? s.phaseCustom.map((v) => num(v, 0)) : [],
    rock,
    pump,
    all,
    xf,
    samplesPerRev: spr,
    maxLobes,
  };
  return { recipe, engine };
}

// ---------------------------------------------------------------------------------------------
// Phase program
// ---------------------------------------------------------------------------------------------

/** Program phase of revolution/pass k for a rosette, in lobes (u units). */
function stepPhaseU(e: EngineData, rt: RosetteRT, k: number): number {
  if (e.phaseMode === 'alternate') {
    return Math.floor(k / e.altEvery) % 2 === 1 ? e.altFrac : 0;
  }
  if (e.phaseMode === 'custom') {
    const n = e.custom.length;
    if (n === 0) return 0;
    return (e.custom[((k % n) + n) % n] * rt.lobes) / 360;
  }
  return (k * e.phaseStep * rt.lobes) / 360;
}

/** Program phase in lobes at continuous revolution coordinate q (spiral) or integer pass q. */
function programPhaseU(e: EngineData, rt: RosetteRT, q: number): number {
  if (!e.spiral || e.phaseMode === 'linear') {
    if (e.phaseMode === 'linear') return (q * e.phaseStep * rt.lobes) / 360;
    return stepPhaseU(e, rt, Math.floor(q));
  }
  const k = Math.max(0, Math.floor(q));
  const cur = stepPhaseU(e, rt, k);
  if (k === 0) return cur;
  const f = q - k;
  if (f >= rt.blend) return cur;
  const prev = stepPhaseU(e, rt, k - 1);
  let d = cur - prev;
  d -= Math.ceil(d - 0.5); // wrap into (-0.5, 0.5]
  const t = f / rt.blend;
  return prev + d * t * t * (3 - 2 * t);
}

/** Total phase in degrees of rosette `rosetteIndex` (recipe order) at a pose: rosette.phase + program offset. */
export function rosettePhaseDeg(prepared: Prepared, rosetteIndex: number, pose: Pose): number {
  const e = getEngine(prepared);
  const r = prepared.recipe.rosettes[rosetteIndex];
  if (!r) return 0;
  const rt = e.all.find((x) => x.index === rosetteIndex);
  if (!rt) return num(r.phase, 0);
  const q = e.spiral ? (pose.spindleAngle - TAU * e.passes * pose.pass) / TAU : pose.slidePass;
  return num(r.phase, 0) + (programPhaseU(e, rt, q) * 360) / rt.lobes;
}

// ---------------------------------------------------------------------------------------------
// Core evaluation (shared by poseAt and computeToolpath)
// ---------------------------------------------------------------------------------------------

// Scratch layout for evalPose.
const P_DIV = 0;
const P_SLIDE = 1;
const P_ANGLE = 2;
const P_ROCK = 3;
const P_PUMP = 4;
const P_RADIUS = 5;
const P_DIVANGLE = 6;

function rosetteSum(e: EngineData, list: RosetteRT[], theta: number, q: number, taper: number): number {
  let sum = 0;
  for (let i = 0; i < list.length; i++) {
    const rt = list[i];
    const u = (-rt.lobes * theta) / TAU + rt.phaseU + programPhaseU(e, rt, q);
    const v = rt.table ? sampleTable(rt.table, u) : rt.amplitude * profileValue(rt.profile, u);
    sum += v;
  }
  return sum * taper;
}

/** Writes the pose of (global pass, local theta) into out. Non-allocating. */
function evalPose(e: EngineData, pass: number, theta: number, out: Float64Array): void {
  let division: number;
  let slidePass: number;
  let q: number;
  let radius: number;
  let taper: number;
  let angle: number;
  if (e.spiral) {
    division = Math.min(e.divisions - 1, Math.max(0, pass | 0));
    q = theta / TAU;
    slidePass = Math.min(e.passes - 1, Math.max(0, Math.floor(q)));
    const f = q / e.passes;
    radius = e.startR + (e.endR - e.startR) * f;
    taper = 1 + (e.taperEnd - 1) * f;
    angle = TAU * e.passes * division + theta;
  } else {
    const total = e.passes * e.divisions;
    const g = Math.min(total - 1, Math.max(0, pass | 0));
    division = Math.floor(g / e.passes);
    slidePass = g - division * e.passes;
    q = slidePass;
    const f = e.passes > 1 ? slidePass / (e.passes - 1) : 0;
    radius = e.startR + (e.endR - e.startR) * f;
    taper = 1 + (e.taperEnd - 1) * f;
    angle = TAU * g + theta;
  }
  out[P_DIV] = division;
  out[P_SLIDE] = slidePass;
  out[P_ANGLE] = angle;
  out[P_ROCK] = e.rock.length ? rosetteSum(e, e.rock, theta, q, taper) : 0;
  out[P_PUMP] = e.pump.length ? rosetteSum(e, e.pump, theta, q, taper) : 0;
  out[P_RADIUS] = radius;
  out[P_DIVANGLE] = division * e.xf.divStep;
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/** Number of strokes (Pass entries) the toolpath will have. */
export function strokeCount(prepared: Prepared): number {
  const e = getEngine(prepared);
  return e.spiral ? e.divisions : e.passes * e.divisions;
}

/**
 * Machine state for global pass `pass` at spindle angle `theta` (radians, local to the pass:
 * 0..2pi for concentric passes, 0..2pi*passes for a spiral stroke). spindleAngle in the result is
 * cumulative across the toolpath (it matches Toolpath.theta).
 */
export function poseAt(prepared: Prepared, pass: number, theta: number): Pose {
  const e = getEngine(prepared);
  const out = new Float64Array(7);
  evalPose(e, pass, theta, out);
  return {
    pass: e.spiral ? out[P_DIV] : Math.min(e.passes * e.divisions - 1, Math.max(0, pass | 0)),
    division: out[P_DIV],
    slidePass: out[P_SLIDE],
    spindleAngle: out[P_ANGLE],
    rock: out[P_ROCK],
    pump: out[P_PUMP],
    slideRadius: out[P_RADIUS],
    divisionAngle: out[P_DIVANGLE],
  };
}

/** Work-frame tool point for a pose: x, y in mm (+Y up), z = pump displacement in mm. */
export function toolPoint(prepared: Prepared, pose: Pose): { x: number; y: number; z: number } {
  const e = getEngine(prepared);
  const o = [0, 0];
  toolToWork(
    e.xf,
    pose.slideRadius + pose.rock,
    Math.cos(pose.spindleAngle),
    Math.sin(pose.spindleAngle),
    Math.cos(pose.divisionAngle),
    Math.sin(pose.divisionAngle),
    o,
  );
  return { x: o[0], y: o[1], z: pose.pump };
}

/** Rigid placement of the work in the machine frame for a pose (see chucks.workPlacementXf). */
export function workPlacement(prepared: Prepared, pose: Pose): { rotation: number; x: number; y: number } {
  return workPlacementXf(getEngine(prepared).xf, pose.spindleAngle, pose.divisionAngle);
}

export function computeToolpath(prepared: Prepared): Toolpath {
  const e = getEngine(prepared);
  const spr = e.samplesPerRev;
  const dTheta = TAU / spr;
  const strokes = e.spiral ? e.divisions : e.passes * e.divisions;
  const perStroke = e.spiral ? e.passes * spr + 1 : spr;
  const total = strokes * perStroke;

  const xs = new Float32Array(total);
  const ys = new Float32Array(total);
  const zs = new Float32Array(total);
  const ts = new Float32Array(total);
  const passes: Pass[] = new Array(strokes);

  const pose = new Float64Array(7);
  const pt = new Float64Array(2);
  const xf = e.xf;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;
  let length = 0;
  let cdCached = 1;
  let sdCached = 0;
  let divCached = 0;

  let k = 0;
  for (let g = 0; g < strokes; g++) {
    const start = k;
    let fx = 0;
    let fy = 0;
    let px = 0;
    let py = 0;
    let division = 0;
    let slidePass = 0;
    for (let i = 0; i < perStroke; i++) {
      const theta = i * dTheta;
      evalPose(e, g, theta, pose);
      const ang = pose[P_ANGLE];
      const da = pose[P_DIVANGLE];
      if (da !== divCached) {
        divCached = da;
        cdCached = Math.cos(da);
        sdCached = Math.sin(da);
      }
      toolToWork(xf, pose[P_RADIUS] + pose[P_ROCK], Math.cos(ang), Math.sin(ang), cdCached, sdCached, pt);
      const x = pt[0];
      const y = pt[1];
      const z = pose[P_PUMP];
      xs[k] = x;
      ys[k] = y;
      zs[k] = z;
      ts[k] = ang;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
      if (i === 0) {
        fx = x;
        fy = y;
        division = pose[P_DIV];
        slidePass = pose[P_SLIDE];
      } else {
        const dx = x - px;
        const dy = y - py;
        length += Math.sqrt(dx * dx + dy * dy);
      }
      px = x;
      py = y;
      k++;
    }
    if (!e.spiral) {
      const dx = fx - px;
      const dy = fy - py;
      length += Math.sqrt(dx * dx + dy * dy);
    }
    passes[g] = {
      index: g,
      division,
      slidePass: e.spiral ? 0 : slidePass,
      closed: !e.spiral,
      start,
      count: perStroke,
    };
  }

  if (total === 0) {
    minX = minY = maxX = maxY = 0;
    zMin = zMax = 0;
  }

  return {
    x: xs,
    y: ys,
    z: zs,
    theta: ts,
    passes,
    samplesPerRev: spr,
    totalSamples: total,
    zMin,
    zMax,
    bounds: { minX, minY, maxX, maxY },
    totalLength: length,
  };
}

/** Index of the stroke containing sample s (binary search on Pass.start). */
export function passAtSample(toolpath: Toolpath, s: number): number {
  const ps = toolpath.passes;
  let lo = 0;
  let hi = ps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ps[mid].start <= s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Pose at a (float) sample index along the toolpath, clamped to [0, totalSamples - 1].
 * Within a closed pass, s in [last, last + 1) runs along the closing segment.
 * Exactly consistent with the toolpath: toolPoint(poseAtSample(s)) == (x[s], y[s]) at integer s.
 */
export function poseAtSample(prepared: Prepared, toolpath: Toolpath, sample: number): Pose {
  const last = Math.max(0, toolpath.totalSamples - 1);
  let s = Number.isFinite(sample) ? sample : 0;
  if (s < 0) s = 0;
  if (s > last) s = last;
  if (toolpath.passes.length === 0) return poseAt(prepared, 0, 0);
  const p = toolpath.passes[passAtSample(toolpath, s)];
  let f = s - p.start;
  const maxF = p.closed ? p.count : p.count - 1;
  if (f > maxF) f = maxF;
  if (f < 0) f = 0;
  return poseAt(prepared, p.index, (f * TAU) / toolpath.samplesPerRev);
}
