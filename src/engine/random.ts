// Seeded Random / Mutate for recipes.
//
// randomRecipe picks a weighted pattern family, then samples parameters from ranges tuned per family so the
// result reads as guilloché rather than noise. The key relations every family keeps:
//   - rock amplitude is sized against the radial step (passes vs radius range), so lines weave but don't blob;
//   - lobe wavelength at the innermost / outermost pass stays a few amplitudes long, unless the family runs the
//     cut right into the centre (start radius 0), where the lobes close into a star as on a real engine;
//   - extra rosettes use musically related lobe counts (multiples / divisors of the primary).
// Locked values (recipe dot-paths, 'rosettes.<id>.<key>', 'rosettes.<id>', or 'rosettes' for the whole stack)
// always survive unchanged; families read locked values and adapt the free ones around them.
//
// Plate view-state (machine.fillEdge, symmetry) is kept from `current` when locked (the UI default) and drawn
// first otherwise, so every family builds for it:
//   - Fill to edge: the engine runs the cut to effectiveEndRadius (plate + chuck reach + rock reach + margin), so
//     pass counts and spacing are solved over that span and the spacing / coverage rules hold over the real cut.
//   - Symmetry order N: lobes are multiples of N (no coprime beat partners), eccentric divisions = N evenly
//     spaced, spirals only as N-start spirals. Mirror: symmetric profiles, peaks on 12 o'clock, no twist.
//   enforceSymmetry() runs last as a safety net (metal coverage is re-fitted if it changed anything).
import { RECIPE_VERSION, cloneRecipe, newRosetteId } from '../state/recipe';
import type { ColorMode, MetalKind, PhaseMode, ProfileKind, Recipe, Rosette, RosetteAxis } from '../state/recipe';
import { PALETTES, PARAMS, ROSETTE_PARAMS, clampParam, getPath, setPath } from '../state/params';
import type { ParamDef } from '../state/params';
import { profileValue } from './rosette';
import { FILL_MARGIN, effectiveEndRadius, plateRadius } from './plate';
import { enforceSymmetry } from './symmetry';

const TAU = Math.PI * 2;
const MAX_ROSETTES = 8;

// ---------------------------------------------------------------------------------------------------------
// RNG

/** Seeded 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  unit(): number {
    return this.next();
  }
  float(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return Math.min(b, a + Math.floor(this.next() * (b - a + 1)));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))];
  }
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const [, w] of items) total += Math.max(0, w);
    let x = this.next() * total;
    for (const [v, w] of items) {
      x -= Math.max(0, w);
      if (x < 0) return v;
    }
    return items[items.length - 1][0];
  }
  /** Standard normal (Box–Muller). */
  gauss(): number {
    const u = 1 - this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Param helpers

type NumDef = Pick<ParamDef, 'type' | 'min' | 'max' | 'step' | 'random'> & { key: string };

const PARAM_BY_KEY = new Map<string, ParamDef>(PARAMS.map((p) => [p.key, p]));
const ROSETTE_PARAM_BY_KEY = new Map<string, NumDef>(ROSETTE_PARAMS.map((p) => [p.key as string, p as NumDef]));

/** Keys whose values are tuned finer than the UI slider step (drift per pass, pump depth amplitudes...). */
const FINE_KEYS = new Set(['slide.phaseStep', 'amplitude', 'slide.amplitudeTaper', 'metal.baseDepth']);

function decimalsOf(step: number): number {
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** Snap to the param's step (or 0.001 for fine keys), then clamp to its min/max. */
function fitNumber(def: NumDef | undefined, v: number): number {
  if (!Number.isFinite(v)) v = 0;
  if (!def) return Math.round(v * 1000) / 1000;
  let x = v;
  if (def.type === 'int') x = Math.round(x);
  else if (FINE_KEYS.has(def.key) || !def.step) x = Math.round(x * 1000) / 1000;
  else x = Number((Math.round(x / def.step) * def.step).toFixed(decimalsOf(def.step)));
  return clampParam(def, x);
}

const PROFILES: ProfileKind[] = ['sine', 'convex', 'concave', 'flame', 'square', 'saw'];

/** Profiles that are not symmetric about their peak: ruled out by mirror symmetry. */
const ASYMMETRIC = new Set<ProfileKind>(['flame', 'saw']);

/** Largest lobe count a rosette can have (the lobes param max). */
const LOBES_MAX = ROSETTE_PARAM_BY_KEY.get('lobes')?.max ?? 300;

/**
 * Ceiling for lobe counts derived from a primary of L lobes: the classic 96 for classic counts, one octave above
 * fine (metal grain) primaries, never past LOBES_MAX. Keeps the draws musical rather than filling up to 300.
 */
function lobeCeiling(L: number): number {
  return Math.min(LOBES_MAX, Math.max(96, 2 * L));
}

/** Nearest multiple of the symmetry order N (at least N, at most LOBES_MAX); n unchanged when N < 2. */
function snapLobes(n: number, N: number): number {
  if (N < 2) return n;
  return Math.min(Math.floor(LOBES_MAX / N) * N, Math.max(N, Math.round(n / N) * N));
}

/**
 * Rosette phase (degrees, in [0, 360/L)) that puts a peak on 12 o'clock: u(ψ = 90°) = L/4 + phase·L/360 is whole
 * (machine.ts), i.e. phase ≡ 270 (mod 360/L). Exact (not snapped to the 0.5° slider step), as enforceSymmetry wants.
 */
export function mirrorPhase(lobes: number): number {
  const P = 360 / Math.max(1, Math.round(lobes));
  const v = ((270 % P) + P) % P;
  return P - v < 1e-6 ? 0 : v;
}

function divisorsOf(n: number, min = 2): number[] {
  const out: number[] = [];
  for (let d = min; d < n; d++) if (n % d === 0) out.push(d);
  return out;
}

/** A lobe count musically related to L: multiples for fine texture, divisors for slow beats (multiples of N only). */
function relatedLobes(rng: Rng, L: number, prefer: 'up' | 'down' | 'any' = 'any', N = 0): number {
  const ceil = lobeCeiling(L);
  const up = [2, 3, 4].map((k) => L * k).filter((n) => n <= ceil && (N < 2 || n % N === 0));
  const down = divisorsOf(L, 2).filter((d) => d >= 2 && d < L && (N < 2 || d % N === 0));
  const pool: [number, number][] = [];
  if (prefer !== 'down') up.forEach((n, i) => pool.push([n, i === 0 ? 3 : 1.5]));
  if (prefer !== 'up') down.forEach((n) => pool.push([n, 1]));
  if (!pool.length) return N >= 2 ? snapLobes(L, N) : L >= 2 ? Math.max(1, Math.round(L / 2)) : 2;
  return rng.weighted(pool);
}

// ---------------------------------------------------------------------------------------------------------
// Locks

interface LockSet {
  paths: Set<string>;
  stack: boolean;
  /** rosette id -> locked keys ('all' = whole rosette). */
  rosettes: Map<string, Set<string> | 'all'>;
}

const ROSETTE_KEYS = new Set<string>(['id', 'enabled', 'axis', 'lobes', 'amplitude', 'profile', 'phase']);

function parseLocks(locks: readonly string[]): LockSet {
  const ls: LockSet = { paths: new Set(), stack: false, rosettes: new Map() };
  for (const raw of locks ?? []) {
    if (typeof raw !== 'string' || !raw) continue;
    if (raw === 'rosettes') {
      ls.stack = true;
      continue;
    }
    if (raw.startsWith('rosettes.')) {
      const rest = raw.slice('rosettes.'.length);
      const dot = rest.lastIndexOf('.');
      const key = dot > 0 ? rest.slice(dot + 1) : '';
      if (dot > 0 && ROSETTE_KEYS.has(key)) {
        const id = rest.slice(0, dot);
        const cur = ls.rosettes.get(id);
        if (cur === 'all') continue;
        const set = cur ?? new Set<string>();
        set.add(key);
        ls.rosettes.set(id, set);
      } else {
        ls.rosettes.set(rest, 'all');
      }
      continue;
    }
    ls.paths.add(raw);
  }
  return ls;
}

function pathLocked(ls: LockSet, path: string): boolean {
  if (ls.paths.has(path)) return true;
  // A lock on a parent object ('eccentric') locks everything below it.
  let i = path.lastIndexOf('.');
  while (i > 0) {
    path = path.slice(0, i);
    if (ls.paths.has(path)) return true;
    i = path.lastIndexOf('.');
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------
// Build context

class Slot {
  /** false = phantom slot (whole stack locked and nothing matched): values are computed but not emitted. */
  constructor(
    readonly r: Rosette,
    private readonly lockedKeys: Set<string> | 'all',
    readonly attached: boolean,
  ) {}
  locked(key: keyof Rosette): boolean {
    return this.lockedKeys === 'all' || this.lockedKeys.has(key);
  }
  num(key: 'lobes' | 'amplitude' | 'phase', v: number): number {
    if (!this.locked(key)) this.r[key] = fitNumber(ROSETTE_PARAM_BY_KEY.get(key), v);
    return this.r[key];
  }
  profile(p: ProfileKind): ProfileKind {
    if (!this.locked('profile')) this.r.profile = p;
    return this.r.profile;
  }
  axis(a: RosetteAxis): RosetteAxis {
    if (!this.locked('axis')) this.r.axis = a;
    return this.r.axis;
  }
  enabled(b: boolean): boolean {
    if (!this.locked('enabled')) this.r.enabled = b;
    return this.r.enabled;
  }
}

class Ctx {
  readonly out: Recipe;
  /** Work radius scale relative to the 100 mm reference dial the ranges are tuned for. */
  readonly s: number;
  /** Max extent of the pattern from the work centre, mm. */
  readonly rMax: number;
  /** Plate radius as the engine sees it (plate.ts). */
  readonly plateR: number;
  /** Fill to edge: the engine runs the cut to effectiveEndRadius; families solve spacing over that span. */
  fill = false;
  /** Symmetry order (0 = free): lobes are multiples of N. */
  N = 0;
  /** Mirror symmetry about 12–6: symmetric profiles, peaks on 12 o'clock, no twist. */
  mirror = false;
  /** Fill: the pass step the family wants; passes are re-fitted to it once the real rock reach is known. */
  fillStep = 0;
  /** Fill: most passes the family allows (rosace budgets rings × divisions). */
  fillMaxPasses = Infinity;
  /** Pass count must be a multiple of this (basket weave groups). */
  passMultiple = 1;
  /** Metal: shallowest groove width / widest gap chosen by styleMetal (kept when the geometry is re-fitted). */
  coverageK = 1.1;
  private pool: Slot[] = [];
  readonly slots: Slot[] = [];
  /** Filled in by families for styling (line width / cut depth vs line spacing). */
  spacing = 1;
  /** Metal mode: target pass spacing (mm). Grooves are then cut deep enough to meet or overlap. */
  metalSpacing = 0;
  configuredEccentric = false;
  configuredElliptical = false;
  /** Rock rosettes wanted in the stack (decided before geometry: compound stacks bias the amplitude ratio up). */
  stackN = 1;
  /** Set by each family after its geometry; the shared stack / pump / rubber steps build on it. */
  primary: PrimaryInfo | null = null;

  constructor(
    readonly rng: Rng,
    readonly locks: LockSet,
    readonly cur: Recipe,
  ) {
    this.out = cloneRecipe(cur);
    const R = Math.max(10, (cur.machine?.workDiameter ?? 100) / 2);
    this.s = R / 50;
    this.rMax = R - 2 * this.s;
    this.plateR = plateRadius(cur);
    const keep = cur.rosettes.filter((r) => locks.stack || locks.rosettes.has(r.id));
    this.pool = keep.map((r) => new Slot(structuredClone(r), locks.stack ? 'all' : locks.rosettes.get(r.id)!, true));
  }

  locked(path: string): boolean {
    return pathLocked(this.locks, path);
  }

  /** Set a recipe path unless locked; numbers are snapped / clamped through the ParamDef. Returns the effective value. */
  set<T>(path: string, v: T): T {
    if (!this.locked(path)) {
      const def = PARAM_BY_KEY.get(path);
      const value = typeof v === 'number' && def ? fitNumber(def, v) : v;
      setPath(this.out, path, value);
    }
    return getPath(this.out, path) as T;
  }
  num(path: string, v: number): number {
    return this.set<number>(path, v);
  }
  get<T>(path: string): T {
    return getPath(this.out, path) as T;
  }

  /** A profile table with the asymmetric profiles removed under mirror symmetry. */
  profiles(table: [ProfileKind, number][]): [ProfileKind, number][] {
    if (!this.mirror) return table;
    const ok = table.filter(([k]) => !ASYMMETRIC.has(k));
    return ok.length ? ok : [['sine', 1]];
  }

  /** Allocate a rosette for a role. Kept (locked) rosettes are reused first, fresh ones get new ids. */
  rosette(axis: RosetteAxis): Slot {
    const compatible = (s: Slot) => !s.locked('axis') || s.r.axis === axis;
    const usable = (s: Slot) => compatible(s) && (!s.locked('enabled') || s.r.enabled);
    let idx = this.pool.findIndex(usable);
    if (idx < 0) idx = this.pool.findIndex(compatible);
    let slot: Slot;
    if (idx >= 0) {
      slot = this.pool.splice(idx, 1)[0];
    } else if (this.locks.stack || this.slots.length + this.pool.length >= MAX_ROSETTES) {
      slot = new Slot(freshRosette(), new Set(), false);
    } else {
      slot = new Slot(freshRosette(), new Set(), true);
    }
    slot.axis(axis);
    slot.enabled(true);
    this.slots.push(slot);
    return slot;
  }

  /** Locked rosettes the family didn't ask for: fit them in as quiet companions of the primary. */
  leftovers(): Slot[] {
    const left = this.pool;
    this.pool = [];
    this.slots.push(...left);
    return left;
  }

  finishRosettes(): void {
    if (this.locks.stack) {
      this.out.rosettes = structuredClone(this.cur.rosettes);
      return;
    }
    this.out.rosettes = this.slots.filter((s) => s.attached).slice(0, MAX_ROSETTES).map((s) => s.r);
  }
}

function freshRosette(): Rosette {
  return { id: newRosetteId(), enabled: true, axis: 'rock', lobes: 12, amplitude: 1, profile: 'sine', phase: 0 };
}

// ---------------------------------------------------------------------------------------------------------
// Shared geometry

interface RingOpts {
  passes: [number, number];
  start: [number, number];
  end: [number, number];
  /** Rock amplitude / radial step. */
  ratio: [number, number];
  /** Minimum lobe wavelength in amplitudes (higher = gentler waves). */
  kLambda: number;
  /** Amplitude taper reached at the last pass. */
  taper: number;
  /** Basket weave: amplitude is measured against a group of k passes, not one step. */
  stepMul?: number;
  /** Extra radial room reserved outside the slide radius (elliptical e, eccentric offset). */
  outerReserve?: number;
  /** Minimum start radius (e.g. > ellipticity). */
  minStart?: number;
  /** Radius lost on the tightest side (elliptical minor axis = R − e): the wavelength rule uses R − innerReserve. */
  innerReserve?: number;
  /** passes are turns of a continuous spiral (same maths, different meaning). */
  passesFixed?: number;
  /** Basket weave: pass count must be a multiple of the group size. */
  passMultiple?: number;
  /** Interleaved spirals: each spiral's turn spacing = metal spacing × this. */
  spacingMul?: number;
  /** Continuous spiral: the radius ramps over `passes` turns, so step = span / passes. */
  spiral?: boolean;
  /** Metal: keep A on the ratio (start far enough out for the wavelength rule) rather than shrink A to fit. */
  keepRatio?: boolean;
  /** Chance of running the cut right into the centre (start radius 0). Near the axis the rock carries the
   *  cutter across the centre, so the inner passes close into a star / rose the way a real engine's do. */
  centre?: number;
}

interface RingResult {
  start: number;
  end: number;
  passes: number;
  step: number;
  A: number;
}

/**
 * Pick start/end/passes and the primary rock amplitude together so that
 *   A ≈ ratio × step                       (weave without blobbing)
 *   2π r / L ≥ kLambda × A(r)  at both ends  (lobes stay readable near the centre)
 *   end + A × taper ≤ rMax                  (stays on the work)
 * Locked values are taken as given and the free ones adapt.
 */
function ringGeometry(ctx: Ctx, p: Slot, L: number, o: RingOpts): RingResult {
  const { rng, s } = ctx;
  const T = Math.max(1, o.taper);
  // The ratio budget is shared by the whole rock stack, so compound stacks sample its upper part.
  const u = ctx.stackN > 1 ? 0.4 + 0.6 * rng.unit() : rng.unit();
  const ratio = (o.ratio[0] + (o.ratio[1] - o.ratio[0]) * u) * (o.stepMul ?? 1);
  const c = (o.kLambda * L) / TAU; // start ≥ c × A
  const reserve = o.outerReserve ?? 0;
  const inner = o.innerReserve ?? 0;
  const ampLocked = p.locked('amplitude');

  let end = ctx.num('slide.endRadius', rng.float(o.end[0], o.end[1]) * s - reserve);
  const startWish = rng.float(o.start[0], o.start[1]) * s;
  let passes: number;
  let start: number;
  let A = 0;

  // Into the centre: the start is pinned at 0 and the inner wavelength rule is waived (the lobes are meant to
  // crowd into a star there). Drawn unconditionally so the rest of the sequence doesn't depend on the lock.
  const centreDraw = rng.unit();
  const toCentre = !ctx.locked('slide.startRadius') && centreDraw < (o.centre ?? 0);

  const metalSp = ctx.metalSpacing > 0 && o.passesFixed === undefined ? ctx.metalSpacing * (o.spacingMul ?? 1) : 0;
  const passesForSpan = (span: number, sp: number): number => {
    let n = Math.round(span / Math.max(0.05, sp)) + (o.spiral ? 0 : 1);
    const m = o.passMultiple ?? 1;
    if (m > 1) n = Math.max(2 * m, Math.round(n / m) * m);
    return Math.max(2, n);
  };

  if (ctx.fill) {
    // Fill to edge: the engine ignores slide.endRadius and cuts out to plate + chuck reach + rock reach + margin,
    // so the span depends on the amplitude, which depends on the step. Hold the step the contained design would
    // use (metal: the target spacing; ink: the drawn pass count over the nominal span) and solve E = rim + A·T.
    const rim = ctx.plateR + reserve + FILL_MARGIN;
    const nominal = end;
    // The start is the contained design's start (same rule, against the nominal end), so the fill only adds
    // passes outward at the same step.
    let stepWant: number;
    if (ampLocked) {
      A = p.r.amplitude;
      start = ctx.num('slide.startRadius', toCentre ? 0 : Math.max(startWish, inner + c * A, o.minStart ?? 0));
      stepWant = A > 0 ? A / ratio : Math.abs(nominal - start) / 30;
      if (metalSp) stepWant = Math.min(1, Math.max(metalSp, stepWant));
    } else {
      const n0 = o.passesFixed ?? (metalSp ? passesForSpan(Math.abs(nominal - startWish), metalSp) : rng.int(o.passes[0], o.passes[1]));
      const n1 = Math.max(1, n0 - 1);
      let startMin = (inner * n1 + c * ratio * nominal) / (n1 + c * ratio);
      if (metalSp && o.keepRatio) startMin = Math.max(startMin, inner + c * ratio * metalSp);
      start = ctx.num('slide.startRadius', toCentre ? 0 : Math.max(startWish, startMin, o.minStart ?? 0));
      stepWant = metalSp || Math.abs(nominal - start) / Math.max(1, o.spiral ? n0 : n1);
    }
    // Never past the rim (a locked or degenerate start): keep at least a few passes on the plate.
    stepWant = Math.max(0.02, Math.min(stepWant, Math.max(0.05, (rim - start) / 4)));
    let E = rim + (ampLocked ? A : ratio * stepWant) * T;
    passes = 2;
    for (let iter = 0; iter < 8; iter++) {
      passes = ctx.num('slide.passes', o.passesFixed ?? passesForSpan(Math.max(0.1, E - start), stepWant));
      if (ampLocked) break;
      const span = Math.max(0.1, E - start);
      const step = o.spiral ? span / Math.max(1, passes) : passes > 1 ? span / (passes - 1) : span;
      A = ratio * step;
      if (start - inner > 0) A = Math.min(A, (TAU * (start - inner)) / (L * o.kLambda));
      A = Math.min(A, (TAU * Math.max(0.5, E - inner)) / (L * o.kLambda * T));
      const next = rim + A * T;
      const done = Math.abs(next - E) < 1e-3;
      E = next;
      if (done) break;
    }
    if (!ampLocked) A = p.num('amplitude', Math.max(0.05, A));
    ctx.fillStep = stepWant;
    ctx.passMultiple = o.passMultiple ?? 1;
    // Engine ignores it while filling; the plate radius keeps the pattern sensible if Fill is turned off.
    ctx.num('slide.endRadius', ctx.plateR);
    const span = Math.max(0.1, E - start);
    const step = o.spiral ? span / Math.max(1, passes) : passes > 1 ? span / (passes - 1) : span;
    return { start, end: E, passes, step, A };
  }

  if (ampLocked) {
    A = p.r.amplitude;
    start = ctx.num('slide.startRadius', toCentre ? 0 : Math.max(startWish, inner + c * A, o.minStart ?? 0));
    const span = Math.abs(end - start);
    let wantStep = A > 0 ? A / ratio : span / 30;
    // Metal: keep the step fine enough for the cut depth to cover it.
    if (metalSp) wantStep = Math.min(1, Math.max(metalSp, wantStep));
    passes = ctx.num('slide.passes', o.passesFixed ?? Math.round(span / Math.max(0.05, wantStep)) + 1);
  } else {
    passes = ctx.num('slide.passes', o.passesFixed ?? (metalSp ? passesForSpan(Math.abs(end - startWish), metalSp) : rng.int(o.passes[0], o.passes[1])));
    let n1 = Math.max(1, passes - 1);
    // Solve start − inner ≥ c × ratio × (end − start) / n1 for the smallest start.
    let startMin = (inner * n1 + c * ratio * end) / (n1 + c * ratio);
    // Metal re-fits the pass count below, which pins the step to the target spacing: the rule fixes the start.
    if (metalSp && o.keepRatio) startMin = Math.max(startMin, inner + c * ratio * metalSp);
    start = ctx.num('slide.startRadius', toCentre ? 0 : Math.max(startWish, startMin, o.minStart ?? 0));
    if (metalSp) {
      // The start moved in: re-fit the pass count to the real span so the spacing stays on target.
      passes = ctx.num('slide.passes', passesForSpan(Math.abs(end - start), metalSp));
      n1 = Math.max(1, passes - 1);
    }
    for (let iter = 0; iter < 3; iter++) {
      const step = o.spiral ? Math.abs(end - start) / passes : passes > 1 ? Math.abs(end - start) / n1 : Math.max(1, end - start);
      A = ratio * step;
      // Wavelength limits at the inner and outer passes.
      if (start - inner > 0) A = Math.min(A, (TAU * (start - inner)) / (L * o.kLambda));
      A = Math.min(A, (TAU * Math.max(0.5, end - inner)) / (L * o.kLambda * T));
      if (end + A * T + reserve > ctx.rMax && !ctx.locked('slide.endRadius')) {
        end = ctx.num('slide.endRadius', ctx.rMax - A * T - reserve);
        continue;
      }
      break;
    }
    A = p.num('amplitude', Math.max(0.05, A));
  }
  const step = o.spiral ? Math.abs(end - start) / Math.max(1, passes) : passes > 1 ? Math.abs(end - start) / (passes - 1) : Math.abs(end - start) || 1;
  return { start, end, passes, step, A };
}

function rubberFor(ctx: Ctx, L: number, profile: ProfileKind): number {
  const rr = ctx.out.machine.rosetteRadius || 60;
  // The finest rock rosette decides: a rubber sized for the primary would skip a fine companion's valleys.
  const maxL = ctx.slots.reduce((m, x) => (x.r.axis === 'rock' && x.r.enabled ? Math.max(m, x.r.lobes) : m), L);
  const lambdaR = (TAU * rr) / Math.max(1, maxL);
  const sharp = profile === 'concave' || profile === 'saw' || profile === 'flame';
  const hi = Math.min(5, lambdaR * (sharp ? 0.06 : 0.12));
  return ctx.num('machine.rubberRadius', ctx.rng.float(Math.min(0.3, hi), hi));
}

/** Neutral values for every slide / chuck field a family may not touch, so output never depends on `current`. */
function neutral(ctx: Ctx): void {
  ctx.set('slide.phaseMode', 'linear' as PhaseMode);
  ctx.set('slide.phaseStep', 0);
  ctx.set('slide.alternateEvery', 1);
  ctx.set('slide.alternateFraction', 0.5);
  ctx.set('slide.phaseCustom', [0]);
  ctx.set('slide.amplitudeTaper', 1);
  ctx.set('slide.spiral', false);
  ctx.set('eccentric.enabled', false);
  ctx.set('eccentric.offset', 0);
  ctx.set('eccentric.angle', 0);
  ctx.set('eccentric.divisions', 1);
  ctx.set('eccentric.divisionStep', 0);
  ctx.set('elliptical.enabled', false);
  ctx.set('elliptical.e', 0);
  ctx.set('elliptical.angle', 0);
}

/** Phase drift per pass for a total twist of `lobesTotal` lobes over the program. */
function driftStep(L: number, passes: number, lobesTotal: number): number {
  return (lobesTotal * 360) / Math.max(1, L) / Math.max(1, passes - 1);
}

// ---------------------------------------------------------------------------------------------------------
// Compound stacks: secondaries and pump rosettes

interface PrimaryInfo {
  slot: Slot;
  L: number;
  /** Rock amplitude budget for the whole stack (ringGeometry's A). */
  A: number;
  /** Innermost / outermost effective radius for the wavelength rule. */
  rIn: number;
  rOut: number;
  kLambda: number;
  taper: number;
  /** Secondary amplitude as a fraction of the primary's. */
  frac?: [number, number];
}

const STACK_DEFAULT: [number, number][] = [[1, 9], [2, 46], [3, 28], [4, 17]];

const PROFILE_WEIGHTS: [ProfileKind, number][] = [['sine', 4], ['convex', 2], ['concave', 1.5], ['triangle', 1.2], ['flame', 1], ['square', 0.6], ['saw', 0.5]];

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * A lobe count for a secondary rosette, musically related to the primary L: multiples (fine texture),
 * divisors (slow undulation) or a near-coprime partner (12 + 5, 18 + 7: beats and moiré).
 * Symmetry order N ≥ 2: multiples of N only, so no coprime beat partners.
 */
function secondaryLobes(rng: Rng, L: number, used: Set<number>, N = 0): number {
  const ceil = lobeCeiling(L);
  const ok = (n: number) => n >= 3 && n <= ceil && !used.has(n) && (N < 2 || n % N === 0);
  const mult = [2, 3, 4].map((k) => L * k).filter(ok);
  const div = divisorsOf(L, 2).filter(ok);
  const lo = Math.max(3, Math.round(L * 0.3));
  const hi = Math.max(lo, Math.round(L * 0.75));
  const cop: number[] = [];
  if (N < 2) for (let m = lo; m <= hi; m++) if (gcd(m, L) === 1 && ok(m)) cop.push(m);
  const cats: [number[], number][] = [[mult, 0.45], [div, 0.35], [cop, 0.2]];
  const live = cats.filter(([c]) => c.length);
  if (!live.length) {
    if (N >= 2) {
      for (let n = N; n <= LOBES_MAX; n += N) if (n !== L && !used.has(n)) return n;
      return snapLobes(L, N);
    }
    for (let n = L + 1; n <= ceil; n++) if (ok(n)) return n;
    return Math.max(2, L - 1);
  }
  const cat = rng.weighted(live);
  // Within multiples prefer ×2; otherwise uniform.
  return cat === mult ? rng.weighted(mult.map((n, i) => [n, i === 0 ? 3 : 1] as [number, number])) : rng.pick(cat);
}

/** Fill the rock stack around the family's primary: related lobes, a different profile, 20–70 % of its amplitude,
 *  own phase. The family's amplitude budget is shared so the summed rock amplitude keeps its spacing rule. */
function compound(ctx: Ctx): void {
  const P = ctx.primary;
  if (!P) return;
  const { rng } = ctx;
  const used = new Set<number>([P.L]);
  const secs: { q: Slot; f: number; L: number }[] = [];
  const [f0, f1] = P.frac ?? [0.2, 0.7];
  for (let i = 1; i < ctx.stackN; i++) {
    const q = ctx.rosette('rock');
    const L2 = q.num('lobes', secondaryLobes(rng, P.L, used, ctx.N));
    used.add(L2);
    q.profile(rng.weighted(ctx.profiles(PROFILE_WEIGHTS.filter(([k]) => k !== P.slot.r.profile))));
    q.num('phase', rng.float(0, 360));
    secs.push({ q, f: rng.float(f0, f1), L: L2 });
  }
  if (!secs.length) return;
  const sumF = secs.reduce((a, x) => a + x.f, 0);
  const A1 = P.slot.num('amplitude', Math.max(0.05, P.A / (1 + sumF)));
  const T = Math.max(1, P.taper);
  // Visibility floor, but never above the smallest share: on fine metal work a flat 0.02 mm would push the
  // summed amplitude past the family's budget (barleycorn's peaks would cross the next pass's troughs).
  const floor = Math.min(0.02, f0 * A1);
  for (const x of secs) {
    // Each secondary still obeys the wavelength rule at its own lobe count.
    let cap = (TAU * Math.max(0.5, P.rOut)) / (x.L * P.kLambda * T);
    if (P.rIn > 0) cap = Math.min(cap, (TAU * P.rIn) / (x.L * P.kLambda));
    x.q.num('amplitude', Math.max(floor, Math.min(x.f * A1, cap)));
  }
}

/** Pump lobes: slow divisors, the primary itself or its double, rare coprime pulses. Symmetry N: multiples of N only. */
function pumpLobes(rng: Rng, L: number, used: Set<number>, N = 0): number {
  const cap = N >= 2 ? LOBES_MAX : 96;
  const ok = (n: number) => n >= 2 && n <= cap && !used.has(n) && (N < 2 || n % N === 0);
  const opts: [number, number][] = [];
  for (const d of divisorsOf(L, 2)) if (d <= 24 && ok(d)) opts.push([d, 1.5]);
  if (ok(L)) opts.push([L, 2]);
  if (ok(L * 2)) opts.push([L * 2, 1]);
  if (N < 2) for (const m of [5, 7, 9, 11]) if (gcd(m, L) === 1 && m < L && ok(m)) opts.push([m, 0.4]);
  if (opts.length) return rng.weighted(opts);
  return N >= 2 ? snapLobes(L, N) : Math.max(2, Math.round(L / 2));
}

/** Pump (face) rosettes: depth in metal, pen width in ink. Metal amplitudes are sized later by styleMetal. */
function addPumps(ctx: Ctx, L: number, count: number): void {
  const { rng } = ctx;
  const used = new Set<number>();
  for (let i = 0; i < count; i++) {
    const q = ctx.rosette('pump');
    used.add(q.num('lobes', pumpLobes(rng, L, used, ctx.N)));
    q.profile(rng.weighted<ProfileKind>(ctx.profiles([['sine', 4], ['convex', 2], ['square', 1], ['flame', 1]])));
    q.num('phase', rng.float(0, 360));
    q.num('amplitude', pumpAmplitude(ctx) / count);
  }
}

function pumpAmplitude(ctx: Ctx): number {
  // Ink: the renderer normalises z to ×0.4–×1.6 pen width, so this mostly sets how far the headstock pumps.
  // Metal: placeholder, styleMetal re-sizes it against the shallowest cut.
  return ctx.out.mode === 'metal' ? 0.05 : ctx.rng.float(0.12, 0.35) * ctx.s;
}

// ---------------------------------------------------------------------------------------------------------
// Families

interface Family {
  id: string;
  label: string;
  names: string[];
  weight: number;
  /** Weights for the number of rock rosettes (default STACK_DEFAULT). */
  stack?: [number, number][];
  /** Paths this family must set to specific values. A conflicting lock rules the family out. */
  requires: Record<string, unknown>;
  build(ctx: Ctx): void;
}

const LOBES_CLASSIC: [number, number][] = [[8, 1], [10, 1], [12, 3], [15, 1], [16, 2], [18, 2], [20, 2], [24, 3], [30, 1], [32, 1], [36, 2]];

function primaryLobes(p: Slot, ctx: Ctx, table: [number, number][]): number {
  // Symmetry: each entry moves to its nearest multiple of N (same single draw, so free runs are unchanged).
  return p.num('lobes', ctx.rng.weighted(ctx.N >= 2 ? table.map(([n, w]) => [snapLobes(n, ctx.N), w] as [number, number]) : table));
}

/**
 * Metal barleycorn lobes: each grain (one lobe long, two spacings tall) about `aspect` × as long as it is tall at
 * 60 % of the work radius, as on a real dial (≈ 200 lobes at 0.25 mm on 32 mm). Snapped to a multiple of 6.
 */
function grainLobes(ctx: Ctx, aspect: number): number {
  const L = (TAU * 0.6 * ctx.rMax) / (aspect * 2 * ctx.metalSpacing);
  return snapLobes(Math.max(24, Math.min(240, Math.round(L / 6) * 6)), ctx.N);
}

const barleycorn: Family = {
  id: 'barleycorn',
  label: 'Barleycorn',
  names: ['Barleycorn', 'Grain d’Orge', 'Barley'],
  weight: 3,
  requires: { 'slide.phaseMode': 'alternate', 'slide.spiral': false },
  build(ctx) {
    const { rng } = ctx;
    ctx.set('slide.phaseMode', 'alternate');
    ctx.set('slide.alternateEvery', 1);
    // Mirror: only a half-lobe offset keeps the offset passes symmetric about 12–6.
    const frac = rng.weighted([[0.5, 6], [1 / 3, 1], [0.25, 1]]);
    ctx.set('slide.alternateFraction', ctx.mirror ? 0.5 : frac);
    // A gentle taper only: much past 1.15 the outer passes cross into loops again (2·A·taper > ~1.4 s).
    const taper = ctx.num('slide.amplitudeTaper', rng.chance(0.7) ? 1 : rng.float(0.8, 1.15));
    const p = ctx.rosette('rock');
    // Metal's fine spacing would stretch classic lobe counts into slivers: size the grain instead.
    const L = ctx.metalSpacing > 0 ? p.num('lobes', grainLobes(ctx, rng.float(1.8, 4))) : primaryLobes(p, ctx, LOBES_CLASSIC);
    p.profile(rng.weighted<ProfileKind>(ctx.profiles([['sine', 6], ['triangle', 3], ['convex', 2], ['concave', 1], ['square', 0.7]])));
    p.num('phase', rng.float(0, 360));
    // 2·ΣA ≈ 0.9–1.2 × the pass spacing: each pass's peaks just touch the next pass's troughs, so the cuts close
    // into grain-shaped cells (raised diamonds in metal) instead of crossing into loops. Quiet companions only.
    const g = ringGeometry(ctx, p, L, { passes: [24, 60], start: [2, 12], end: [40, 47], ratio: [0.45, 0.6], kLambda: 3, taper, centre: 0.5, keepRatio: true });
    ctx.primary = { slot: p, L, A: g.A, rIn: g.start, rOut: g.end, kLambda: 3, taper, frac: [0.1, 0.3] };
    ctx.spacing = g.step;
  },
};

const basket: Family = {
  id: 'basket',
  label: 'Basket weave',
  names: ['Basket Weave', 'Panier', 'Wicker'],
  weight: 2,
  stack: [[1, 18], [2, 55], [3, 27]],
  requires: { 'slide.phaseMode': 'alternate', 'slide.spiral': false },
  build(ctx) {
    const { rng } = ctx;
    ctx.set('slide.phaseMode', 'alternate');
    const k = ctx.num('slide.alternateEvery', rng.weighted([[2, 3], [3, 3], [4, 2], [5, 1]]));
    ctx.set('slide.alternateFraction', 0.5);
    // Metal: anti-phased groups leave gaps of up to (1 + k) × the spacing; keep them within a 150° graver's
    // reach at the 0.4 mm depth cap so the weave is still cut right through.
    if (ctx.metalSpacing > 0) ctx.metalSpacing = Math.min(ctx.metalSpacing, 2.2 / (1 + k));
    ctx.set('slide.amplitudeTaper', 1);
    const p = ctx.rosette('rock');
    const L = primaryLobes(p, ctx, [[6, 1], [8, 2], [10, 1], [12, 3], [16, 2], [20, 1], [24, 1]]);
    const prof = p.profile(rng.weighted<ProfileKind>(ctx.profiles([['square', 4], ['sine', 3], ['convex', 2]])));
    p.num('phase', rng.float(0, 360));
    const groups = rng.int(7, 13);
    const g = ringGeometry(ctx, p, L, {
      passes: [k * groups, k * groups],
      start: [4, 12],
      end: [40, 46],
      ratio: [0.3, 0.5],
      stepMul: k,
      passMultiple: k,
      kLambda: prof === 'square' ? 4 : 3.2,
      taper: 1,
      centre: 0.35,
    });
    ctx.primary = { slot: p, L, A: g.A, rIn: g.start, rOut: g.end, kLambda: 3.5, taper: 1, frac: [0.2, 0.5] };
    ctx.spacing = g.step;
  },
};

const moire: Family = {
  id: 'moire',
  label: 'Moiré wave',
  names: ['Moiré', 'Moiré Wave', 'Tide', 'Watered Silk'],
  weight: 2.5,
  stack: [[1, 10], [2, 40], [3, 30], [4, 20]],
  requires: { 'slide.phaseMode': 'linear', 'slide.spiral': false },
  build(ctx) {
    const { rng } = ctx;
    ctx.set('slide.phaseMode', 'linear');
    const taper = ctx.num('slide.amplitudeTaper', rng.chance(0.5) ? 1 : rng.float(0.6, 1.8));
    const p = ctx.rosette('rock');
    const L = primaryLobes(p, ctx, [[3, 1], [4, 1.5], [5, 1.5], [6, 2], [7, 1], [8, 2], [9, 1], [10, 1.5], [12, 2], [14, 1], [16, 1], [18, 1], [24, 1]]);
    p.profile(rng.weighted<ProfileKind>(ctx.profiles([['sine', 7], ['convex', 1.5], ['flame', 1]])));
    p.num('phase', rng.float(0, 360));
    const g = ringGeometry(ctx, p, L, { passes: [60, 130], start: [0, 10], end: [40, 47], ratio: [1.5, 4.5], kLambda: 2.6, taper, centre: 0.55 });
    ctx.num('slide.phaseStep', rng.sign() * driftStep(L, g.passes, rng.float(0.6, 2.5)));
    ctx.primary = { slot: p, L, A: g.A, rIn: g.start, rOut: g.end, kLambda: 2.6, taper };
    ctx.spacing = g.step;
  },
};

const flame: Family = {
  id: 'flame',
  label: 'Flame',
  names: ['Flame', 'Flinqué Flame', 'Ember', 'Wildfire'],
  weight: 2.5,
  requires: { 'slide.phaseMode': 'linear', 'slide.spiral': false },
  build(ctx) {
    const { rng } = ctx;
    ctx.set('slide.phaseMode', 'linear');
    const taper = ctx.num('slide.amplitudeTaper', rng.chance(0.7) ? rng.float(1.1, 2.2) : 1);
    const p = ctx.rosette('rock');
    const L = primaryLobes(p, ctx, [[6, 1], [8, 2], [9, 1], [10, 2], [12, 3], [14, 1], [16, 2], [18, 1], [20, 1], [24, 1]]);
    p.profile(rng.weighted<ProfileKind>(ctx.profiles([['flame', 7], ['saw', 1.5], ['sine', 1.5]])));
    p.num('phase', rng.float(0, 360));
    const g = ringGeometry(ctx, p, L, { passes: [40, 100], start: [2, 10], end: [40, 47], ratio: [2.5, 5.5], kLambda: 2.4, taper, centre: 0.5 });
    ctx.num('slide.phaseStep', rng.sign() * driftStep(L, g.passes, rng.float(0.4, 1.6)));
    ctx.primary = { slot: p, L, A: g.A, rIn: g.start, rOut: g.end, kLambda: 2.4, taper };
    ctx.spacing = g.step;
  },
};

const sunburst: Family = {
  id: 'sunburst',
  label: 'Sunray',
  names: ['Sunray', 'Soleil', 'Sunburst', 'Radiance'],
  weight: 1.2,
  stack: [[1, 14], [2, 58], [3, 28]],
  requires: { 'slide.phaseMode': 'linear', 'slide.spiral': false },
  build(ctx) {
    const { rng } = ctx;
    ctx.set('slide.phaseMode', 'linear');
    const taper = ctx.num('slide.amplitudeTaper', rng.float(1.6, 2.8));
    const p = ctx.rosette('rock');
    const L = primaryLobes(p, ctx, [[36, 1], [48, 2], [60, 2], [72, 2], [90, 1], [96, 1]]);
    p.profile(rng.weighted<ProfileKind>(ctx.profiles([['concave', 5], ['sine', 3], ['saw', 1.5]])));
    p.num('phase', rng.float(0, 360));
    const g = ringGeometry(ctx, p, L, { passes: [60, 130], start: [10, 22], end: [42, 47], ratio: [2, 4.5], kLambda: 1.7, taper, centre: 0.45 });
    // Straight rays, or a gentle curve (needs a full slider step per pass to register).
    const curve = rng.chance(0.4) ? rng.sign() * Math.max(0.1, driftStep(L, g.passes, rng.float(0.5, 1.5))) : 0;
    ctx.num('slide.phaseStep', curve);
    ctx.primary = { slot: p, L, A: g.A, rIn: g.start, rOut: g.end, kLambda: 1.7, taper };
    ctx.spacing = g.step;
  },
};

const rosace: Family = {
  id: 'rosace',
  label: 'Eccentric rosace',
  names: ['Rosace', 'Rose Window', 'Bloom', 'Corolla'],
  weight: 2,
  stack: [[1, 10], [2, 50], [3, 30], [4, 10]],
  requires: { 'eccentric.enabled': true, 'slide.spiral': false },
  build(ctx) {
    const { rng, s } = ctx;
    const metal = ctx.metalSpacing > 0;
    ctx.configuredEccentric = true;
    ctx.set('eccentric.enabled', true);
    const dDraw = rng.int(5, 16);
    // Symmetry N: N evenly spaced divisions make the bloom N-fold. Fill: 3–8 divisions, since every ring set
    // covers the whole plate.
    const D = ctx.num('eccentric.divisions', ctx.N >= 2 ? ctx.N : ctx.fill ? 3 + Math.round(((dDraw - 5) * 5) / 11) : dDraw);
    ctx.set('eccentric.divisionStep', 0);
    const ang = rng.weighted([[0, 2], [90, 1], [rng.float(0, 360), 1]]);
    // Mirror: the bloom's first centre on the 12–6 axis (each ring set is symmetric about its own radial line).
    ctx.set('eccentric.angle', ctx.mirror ? (ang < 180 ? 90 : 270) : ang);
    const p = ctx.rosette('rock');
    p.profile(rng.weighted<ProfileKind>(ctx.profiles([['sine', 5], ['convex', 2], ['concave', 1.5]])));
    p.num('phase', rng.float(0, 360));

    // Size the bloom to fill the dial: offset + circle radius + band + amplitude ≈ fill × rMax.
    // Keep the total number of circles (passes × divisions) readable.
    const passChoices: [number, number][] = [[1, 1], [2, 2], [3, 2], [4, 2], [6, 1.5], [8, 1], [12, 0.7]];
    let passes: number;
    let band: number;
    if (metal) {
      // Metal: each circle is a band of touching grooves (2.5–7 mm wide).
      const sp = ctx.metalSpacing;
      passes = ctx.num('slide.passes', Math.max(4, Math.min(Math.floor(480 / D), Math.round((rng.float(2.5, 7) * s) / sp) + 1)));
      band = (passes - 1) * sp;
    } else {
      passes = ctx.num('slide.passes', rng.weighted(passChoices.filter(([n]) => n === 1 || n * D <= 64)));
      band = passes > 1 ? rng.float(0.6, 1.5) * (passes - 1) * s : 0;
    }
    const ampWish = rng.weighted([[0, 0.5], [rng.float(0.3, 1.2) * s, 4.5]]);
    const fill = rng.float(0.82, 0.97) * ctx.rMax;
    const q = rng.float(0.7, 1.5); // circle radius / offset: < 1 leaves an eye in the centre, > 1 overlaps it
    let e: number;
    let start: number;
    let end: number;
    if (ctx.fill) {
      // Fill to edge: each division's rings run out past the far rim (plate + offset from its own centre), so the
      // D ring sets overlap over the whole plate. Far-apart centres cross the rings steeply into noise; a small
      // offset (5–15 % of the plate) keeps them nearly concentric, and they interfere into a D-petal moiré bloom.
      e = ctx.num('eccentric.offset', Math.max(s, (0.05 + (0.1 * (q - 0.7)) / 0.8) * fill));
      start = ctx.num('slide.startRadius', Math.max(s, q * e));
      end = start;
    } else {
      e = ctx.num('eccentric.offset', Math.max(2 * s, (fill - band - ampWish) / (1 + q)));
      const R1 = Math.max(2 * s, Math.min(q * e, fill - e - band - ampWish));
      start = ctx.num('slide.startRadius', R1);
      end = ctx.num('slide.endRadius', start + band);
    }
    const rMin = Math.max(0.5, Math.min(start, end));

    // Lobes that are a multiple of the divisions keep the bloom symmetric; cap so lobes stay readable.
    const maxL = Math.max(3, Math.floor((TAU * rMin) / (3.2 * Math.max(0.3, ampWish))));
    const lobeChoices: [number, number][] = [[D, 1], [2 * D, 2], [3 * D, 1], [snapLobes(rng.pick([6, 8, 10, 12, 16, 18, 24]), ctx.N), 2]];
    const fit = lobeChoices.filter(([n]) => n >= 3 && n <= Math.min(48, maxL) && (ctx.N < 2 || n % ctx.N === 0));
    const fallback = ctx.N >= 2 ? ctx.N : Math.min(maxL, 12);
    const L = p.num('lobes', rng.weighted(fit.length ? fit : [[fallback, 1]]));
    const A = p.num('amplitude', Math.min(ampWish, (TAU * rMin) / (L * 3.2)));

    if (ctx.fill) {
      // Ring count is budgeted against the divisions (ink ≤ 320 circles, metal ≤ 640 grooves); ink rings sit
      // 1.2–2.4 mm apart so the moiré reads. The effective end is re-measured once the stack is final (fillFit).
      const E = ctx.plateR + e + A + FILL_MARGIN;
      const span = Math.max(1, E - start);
      ctx.fillMaxPasses = Math.max(3, Math.floor((metal ? 640 : 320) / D));
      const sp = metal ? ctx.metalSpacing : rng.float(1.2, 2.4) * s;
      passes = ctx.num('slide.passes', Math.max(3, Math.min(ctx.fillMaxPasses, Math.round(span / sp) + 1)));
      ctx.fillStep = span / Math.max(1, passes - 1);
      ctx.num('slide.endRadius', ctx.plateR);
      end = E;
    }
    if (passes > 1) {
      const mode = ctx.set('slide.phaseMode', rng.chance(0.5) ? 'alternate' : 'linear') as PhaseMode;
      if (mode === 'linear') ctx.num('slide.phaseStep', rng.sign() * driftStep(L, passes, rng.float(0.1, 0.5)));
    }
    if (A > 0) ctx.primary = { slot: p, L, A, rIn: rMin, rOut: Math.max(start, end), kLambda: 3.2, taper: 1 };
    ctx.spacing = passes > 1 ? Math.abs(end - start) / (passes - 1) : 1.2;
    // Fill: D ring sets overlap everywhere; a pen sized for one set would ink them into a mesh.
    if (ctx.fill) ctx.spacing = Math.min(ctx.spacing, 1.2 * s) / Math.sqrt(D);
  },
};

const cartouche: Family = {
  id: 'cartouche',
  label: 'Elliptical cartouche',
  names: ['Cartouche', 'Oval', 'Medallion', 'Cameo'],
  weight: 1.5,
  requires: { 'elliptical.enabled': true, 'slide.spiral': false },
  build(ctx) {
    const { rng, s } = ctx;
    ctx.configuredElliptical = true;
    ctx.set('elliptical.enabled', true);
    const e = ctx.num('elliptical.e', rng.float(4, 12) * s);
    const ang = rng.weighted([[0, 3], [90, 2], [rng.float(0, 180), 1]]);
    // Mirror: the ellipse's axes on 12–6 / 3–9 (it is symmetric about both).
    ctx.set('elliptical.angle', ctx.mirror ? (ang < 45 || ang > 135 ? 0 : 90) : ang);
    // Mirror rules out the twisting linear drift: alternate unless the phase mode is locked.
    const altDraw = rng.chance(0.6);
    const alt = (altDraw || ctx.mirror) && !ctx.locked('slide.phaseMode') ? true : ctx.get<PhaseMode>('slide.phaseMode') === 'alternate';
    ctx.set('slide.phaseMode', alt ? 'alternate' : 'linear');
    if (alt) {
      ctx.set('slide.alternateEvery', rng.weighted([[1, 4], [2, 1]]));
      ctx.set('slide.alternateFraction', 0.5);
    }
    const p = ctx.rosette('rock');
    // Metal alternate is a barleycorn on an oval: size the grain, or classic counts stretch into slivers.
    const L =
      ctx.metalSpacing > 0 && alt
        ? p.num('lobes', grainLobes(ctx, rng.float(1.8, 4)))
        : primaryLobes(p, ctx, [[12, 2], [16, 2], [18, 1], [20, 2], [24, 2], [30, 1], [36, 1]]);
    p.profile(rng.weighted<ProfileKind>(ctx.profiles([['sine', 5], ['convex', 2], ['concave', 1]])));
    p.num('phase', rng.float(0, 360));
    const g = ringGeometry(ctx, p, L, {
      passes: [22, 50],
      start: [2, 8],
      end: [40, 46],
      ratio: alt ? [0.45, 0.6] : [1.5, 3.5],
      kLambda: 3,
      taper: 1,
      outerReserve: e,
      innerReserve: e,
      minStart: e + 2 * s,
      // Metal grain: start far enough out for the wavelength rule rather than flatten the grain.
      keepRatio: alt,
    });
    if (!alt) ctx.num('slide.phaseStep', rng.sign() * driftStep(L, g.passes, rng.float(0.5, 1.5)));
    ctx.primary = { slot: p, L, A: g.A, rIn: g.start - e, rOut: g.end - e, kLambda: 3, taper: 1, frac: alt ? [0.2, 0.55] : undefined };
    ctx.spacing = g.step;
  },
};

const spiral: Family = {
  id: 'spiral',
  label: 'Spiral',
  names: ['Spiral', 'Nautilus', 'Vortex', 'Whorl'],
  weight: 1.5,
  stack: [[1, 10], [2, 45], [3, 30], [4, 15]],
  requires: { 'slide.spiral': true },
  build(ctx) {
    const { rng, s } = ctx;
    ctx.set('slide.spiral', true);
    ctx.set('slide.phaseMode', 'linear');
    const taper = ctx.num('slide.amplitudeTaper', rng.chance(0.5) ? 1 : rng.float(1.2, 2.2));
    let reserve = 0;
    let divs = 1;
    // Symmetry N: only an N-start spiral is N-fold symmetric (each start is the first one turned by 360°/N).
    const multi = rng.chance(0.2);
    if ((multi || ctx.N >= 2) && !ctx.locked('eccentric.enabled')) {
      // Multi-start spiral: the dividing wheel lays down 2–4 interleaved spirals. Centred (or nearly) and with
      // lobes a multiple of the divisions, each copy lands on the same pattern; a big offset just tangles them.
      ctx.configuredEccentric = true;
      ctx.set('eccentric.enabled', true);
      const dDraw = rng.int(2, 4);
      divs = ctx.num('eccentric.divisions', ctx.N >= 2 ? ctx.N : dDraw);
      ctx.set('eccentric.divisionStep', 0);
      reserve = ctx.num('eccentric.offset', rng.chance(0.6) ? 0 : rng.float(0.3, 1.2) * s);
    }
    if (divs > 1) ctx.stackN = 1;
    const p = ctx.rosette('rock');
    let L = primaryLobes(p, ctx, [[3, 1], [4, 1], [5, 1.5], [6, 2], [8, 2], [10, 1], [12, 2], [16, 1], [20, 1], [24, 1]]);
    if (divs > 1 && L % divs !== 0) L = p.num('lobes', Math.max(divs, Math.round(L / divs) * divs));
    p.profile(rng.weighted<ProfileKind>(ctx.profiles([['sine', 5], ['convex', 2], ['flame', 2], ['concave', 1]])));
    p.num('phase', rng.float(0, 360));
    const turns: [number, number] = divs > 1 ? [Math.max(2, Math.round(30 / divs)), Math.max(2, Math.round(60 / divs))] : [25, 70];
    const g = ringGeometry(ctx, p, L, { passes: turns, start: [1, 8], end: [40, 47], ratio: [1.3, 3.5], kLambda: 2.6, taper, outerReserve: reserve, stepMul: 1 / divs, spacingMul: divs, spiral: true, centre: 0.6 });
    const twist = divs > 1 ? rng.float(0.2, 0.8) : rng.float(0.4, 1.5);
    ctx.num('slide.phaseStep', rng.chance(0.2) ? 0 : rng.sign() * driftStep(L, g.passes, twist));
    // Multi-start spirals keep their symmetry only if every rosette's lobes are multiples of the divisions.
    ctx.primary = { slot: p, L, A: g.A, rIn: g.start, rOut: g.end, kLambda: 2.6, taper };
    ctx.spacing = g.step / divs;
  },
};

const pumped: Family = {
  id: 'pumped',
  label: 'Pumped',
  names: ['Pulse', 'Clair-Obscur', 'Relief', 'Shimmer'],
  weight: 1,
  requires: { 'slide.spiral': false },
  build(ctx) {
    const { rng } = ctx;
    // Mirror rules out the twisting linear drift: alternate unless the phase mode is locked.
    const alt = ctx.locked('slide.phaseMode') ? ctx.get<PhaseMode>('slide.phaseMode') === 'alternate' : rng.chance(0.5) || ctx.mirror;
    ctx.set('slide.phaseMode', alt ? 'alternate' : 'linear');
    if (alt) {
      ctx.set('slide.alternateEvery', 1);
      ctx.set('slide.alternateFraction', 0.5);
    }
    const p = ctx.rosette('rock');
    // Metal alternate is a barleycorn: size the grain, or classic counts stretch into slivers.
    const L =
      ctx.metalSpacing > 0 && alt
        ? p.num('lobes', grainLobes(ctx, rng.float(1.8, 4)))
        : primaryLobes(p, ctx, [[12, 3], [16, 2], [18, 2], [24, 3], [30, 1], [36, 1]]);
    p.profile(rng.weighted<ProfileKind>(ctx.profiles([['sine', 5], ['convex', 2]])));
    p.num('phase', rng.float(0, 360));
    const g = ringGeometry(ctx, p, L, {
      passes: alt ? [28, 60] : [50, 110],
      start: [3, 12],
      end: [40, 47],
      ratio: alt ? [0.45, 0.6] : [1.5, 3.5],
      kLambda: 3,
      taper: 1,
      centre: 0.45,
      keepRatio: alt,
    });
    if (!alt) ctx.num('slide.phaseStep', rng.sign() * driftStep(L, g.passes, rng.float(0.5, 1.5)));
    ctx.primary = { slot: p, L, A: g.A, rIn: g.start, rOut: g.end, kLambda: 3, taper: 1, frac: alt ? [0.2, 0.55] : undefined };
    ctx.spacing = g.step;
  },
};

const FAMILY_LIST: Family[] = [barleycorn, basket, moire, flame, sunburst, rosace, cartouche, spiral, pumped];

export const FAMILIES: { id: string; label: string; weight: number; names: readonly string[] }[] = FAMILY_LIST.map(({ id, label, weight, names }) => ({ id, label, weight, names }));

// ---------------------------------------------------------------------------------------------------------
// Family choice under locks

function familyAllowed(f: Family, ctx: Ctx): boolean {
  for (const [path, want] of Object.entries(f.requires)) {
    if (ctx.locked(path) && getPath(ctx.cur, path) !== want) return false;
  }
  if (f.id === 'pumped' && ctx.locks.stack && !ctx.cur.rosettes.some((r) => r.axis === 'pump')) return false;
  return true;
}

/**
 * Families that can meet the symmetry: mirror rules out the twisting / chiral ones (flame, moiré, spiral); an
 * ellipse is only 2-fold; the dividing wheel can make at most 36 divisions (rosace and N-start spirals use N).
 */
function familySymmetryOk(f: Family, ctx: Ctx): boolean {
  const { N, mirror } = ctx;
  if (mirror && (f.id === 'flame' || f.id === 'moire' || f.id === 'spiral')) return false;
  if (N >= 3 && f.id === 'cartouche') return false;
  if (N >= 2 && (f.id === 'rosace' || f.id === 'spiral')) {
    const maxDiv = PARAM_BY_KEY.get('eccentric.divisions')?.max ?? 36;
    if (N > maxDiv) return false;
    if (ctx.locked('eccentric.enabled') && !ctx.cur.eccentric?.enabled) return false;
  }
  return true;
}

function familyWeight(f: Family, ctx: Ctx): number {
  let w = f.weight;
  if (f.id === 'pumped') w *= ctx.cur.mode === 'metal' ? 2 : 0.6;
  // Features locked on but not used by the family: still allowed, just less likely.
  if (ctx.locked('eccentric.enabled') && ctx.cur.eccentric.enabled && !('eccentric.enabled' in f.requires)) w *= 0.3;
  if (ctx.locked('elliptical.enabled') && ctx.cur.elliptical.enabled && !('elliptical.enabled' in f.requires)) w *= 0.5;
  return w;
}

// ---------------------------------------------------------------------------------------------------------
// Post-family adaptation and styling

/** Kept rosettes the family didn't use, and chucks locked on that the family didn't configure. */
function adapt(ctx: Ctx): void {
  const { rng, s } = ctx;
  const primary = ctx.slots.find((x) => x.r.axis === 'rock' && x.r.enabled);
  const L = primary?.r.lobes ?? 12;
  const A = primary?.r.amplitude ?? 1;
  for (const q of ctx.leftovers()) {
    q.enabled(true);
    if (q.r.axis === 'pump') {
      q.num('lobes', relatedLobes(rng, L, 'down', ctx.N));
      q.num('amplitude', pumpAmplitude(ctx));
    } else {
      q.num('lobes', relatedLobes(rng, L, 'up', ctx.N));
      q.num('amplitude', A * rng.float(0.1, 0.25));
    }
    q.profile(rng.pick(['sine', 'convex'] as ProfileKind[]));
    q.num('phase', rng.float(0, 360));
  }

  if (ctx.get<boolean>('eccentric.enabled') && !ctx.configuredEccentric) {
    // Symmetry N: N evenly spaced copies (or the largest divisor of N the wheel can index).
    const dDraw = rng.int(3, 8);
    const maxDiv = PARAM_BY_KEY.get('eccentric.divisions')?.max ?? 36;
    ctx.num('eccentric.divisions', ctx.N >= 2 ? (ctx.N <= maxDiv ? ctx.N : Math.max(1, ...divisorsOf(ctx.N, 1).filter((d) => d <= maxDiv))) : dDraw);
    ctx.set('eccentric.divisionStep', 0);
    ctx.num('eccentric.offset', rng.float(2, 8) * s);
  }
  if (ctx.get<boolean>('elliptical.enabled') && !ctx.configuredElliptical) {
    ctx.num('elliptical.e', rng.float(2, 6) * s);
  }

}

/** Keep the whole pattern inside 0.96 × the work radius: shrink free radii if chucks / amplitude push it out.
 *  Runs after finishRosettes so it sees the generated stack, not the current recipe's. A filled pattern runs off
 *  the rim by design and is left alone. */
function fitToWork(ctx: Ctx): void {
  if (ctx.fill) return;
  const rock = ctx.out.rosettes.filter((r) => r.enabled && r.axis === 'rock').reduce((a, r) => a + r.amplitude, 0);
  const T = Math.max(1, ctx.get<number>('slide.amplitudeTaper'));
  const extra = (ctx.out.eccentric.enabled ? ctx.out.eccentric.offset : 0) + (ctx.out.elliptical.enabled ? ctx.out.elliptical.e : 0) + rock * T;
  const rStart = ctx.get<number>('slide.startRadius');
  const rEnd = ctx.get<number>('slide.endRadius');
  const outer = Math.max(rStart, rEnd);
  if (outer + extra > ctx.rMax && outer > 0) {
    const k = Math.max(0.2, (ctx.rMax - extra) / outer);
    // Round down onto the 0.1 mm slider grid: rounding to nearest could push the cut back past the limit.
    const down = (v: number) => Math.floor(v * 10 + 1e-9) / 10;
    if (!ctx.locked('slide.endRadius')) ctx.num('slide.endRadius', down(rEnd * k));
    if (!ctx.locked('slide.startRadius')) ctx.num('slide.startRadius', down(rStart * k));
  }
}

/**
 * Fill to edge: the effective end moves with the final rock stack (compound shares, kept rosettes), so re-fit the
 * pass count to the step the family asked for. Spacing, the barleycorn 2ΣA ≈ s rule and metal coverage then hold
 * over the span the engine actually cuts.
 */
function fillFit(ctx: Ctx): void {
  if (!ctx.fill || !(ctx.fillStep > 0) || ctx.locked('slide.passes')) return;
  const r = ctx.out;
  const span = Math.abs(effectiveEndRadius(r) - r.slide.startRadius);
  let n = Math.round(span / ctx.fillStep) + (r.slide.spiral ? 0 : 1);
  const m = ctx.passMultiple;
  if (m > 1) n = Math.max(2 * m, Math.round(n / m) * m);
  ctx.num('slide.passes', Math.max(2, Math.min(ctx.fillMaxPasses, n)));
}

/**
 * Hold the symmetry the generator aimed for (unlocked values only), in enforceSymmetry's terms so the safety net
 * finds nothing to snap.
 *   Mirror: every rosette's peak on 12 o'clock, no linear twist, half-lobe alternation only.
 *   Order N (no mirror): linear drift twists the whole program by a whole number of 360°/N steps, at least one
 *   (the family asked for drift), at most 30° per pass.
 */
function holdSymmetry(r: Recipe, ls: LockSet, N: number, mirror: boolean): void {
  const sl = r.slide;
  if (mirror) {
    if (!ls.stack) {
      for (const ros of r.rosettes) {
        const lk = ls.rosettes.get(ros.id);
        if (!ros.enabled || lk === 'all' || lk?.has('phase')) continue;
        ros.phase = mirrorPhase(ros.lobes);
      }
    }
    if (sl.phaseMode === 'linear' && !pathLocked(ls, 'slide.phaseStep')) sl.phaseStep = 0;
    if (sl.phaseMode === 'alternate' && !pathLocked(ls, 'slide.alternateFraction') && ![0, 0.5, 1].includes(sl.alternateFraction)) sl.alternateFraction = 0.5;
    return;
  }
  const turns = sl.spiral ? sl.passes : sl.passes - 1;
  if (N >= 2 && sl.phaseMode === 'linear' && sl.phaseStep !== 0 && turns > 0 && !pathLocked(ls, 'slide.phaseStep')) {
    const unit = 360 / N / turns;
    let m = Math.sign(sl.phaseStep) * Math.max(1, Math.round(Math.abs(sl.phaseStep) / unit));
    while (m !== 0 && Math.abs(m * unit) > 30 + 1e-9) m -= Math.sign(m);
    sl.phaseStep = m * unit;
  }
}

/** V-groove depth that cuts a groove `width` mm wide, plus the pump's downward reach; clamped to the param range. */
function depthForWidth(width: number, toolAngle: number, pump = 0): number {
  const d = width / (2 * Math.tan(((toolAngle / 2) * Math.PI) / 180)) + pump;
  return Math.min(0.4, Math.max(0.01, d));
}

/** V-tool angle (degrees) that cuts a groove `width` mm wide at `depth` mm. */
function angleForWidth(width: number, depth: number): number {
  return (2 * Math.atan(width / (2 * Math.max(1e-6, depth))) * 180) / Math.PI;
}

/** Largest downward pump displacement (mm): sum of enabled pump amplitudes × the taper peak. */
function pumpReach(r: Recipe): number {
  const sum = r.rosettes.filter((x) => x.enabled && x.axis === 'pump').reduce((a, x) => a + Math.abs(x.amplitude), 0);
  return sum * Math.max(1, r.slide.amplitudeTaper);
}

/** Distance between neighbouring cuts, mm (null when there is a single pass). Measured over the span the engine
 *  cuts: effectiveEndRadius (the fill end when machine.fillEdge is on). */
export function passSpacing(r: Recipe): number | null {
  const span = Math.abs(effectiveEndRadius(r) - r.slide.startRadius);
  if (r.slide.spiral) {
    const divs = r.eccentric.enabled ? Math.max(1, r.eccentric.divisions) : 1;
    return r.slide.passes >= 1 && span > 0 ? span / r.slide.passes / divs : null;
  }
  return r.slide.passes > 1 && span > 0 ? span / (r.slide.passes - 1) : null;
}

/** Cap on the work maxPassGap does: samples × passes × rosettes. */
const GAP_BUDGET = 300_000;

/**
 * Widest radial gap between radially-adjacent cut centrelines anywhere in the band, mm (null when passSpacing
 * is null). A groove at least this wide cuts the whole surface: no flat survives between neighbouring cuts.
 * 2A = s with anti-phased passes (barleycorn) gives 2s; passes in phase give s.
 *
 * Measured, not estimated: with big amplitudes (moiré, flame, sunray) the nearest centreline is often a
 * pass 2–3 away, so a closed form like s + Σ 2A|sin πf| overshoots badly. Each pass's centreline radius is
 *   k·s + Σ_rock A · taper · profile(u),  u = −L·θ/2π + phase·L/360 + programPhase(k)   (as in machine.ts),
 * sampled over one angular period (2π / gcd of the lobes) for a window of passes at the band's peak taper
 * (max(1, amplitudeTaper)). Per angle the radii are sorted and the widest gap counted, using only the inner
 * part of the window that no pass outside it can reach. Spiral turns count as passes. Rubber is ignored.
 * Radial gaps are an upper bound on the groove width needed (on steep flanks the cuts sit closer than the
 * radial gap says), so sizing to them never leaves flats. Eccentric work with several divisions (rosace,
 * multi-start spirals) returns the plain pass spacing.
 */
export function maxPassGap(r: Recipe): number | null {
  const sp = passSpacing(r);
  if (!sp) return null;
  if (r.eccentric.enabled && Math.round(r.eccentric.divisions) > 1) return sp;
  const rock = r.rosettes.filter((x) => x.enabled && x.axis !== 'pump' && Number.isFinite(x.amplitude) && x.amplitude !== 0);
  if (!rock.length) return sp;

  const sl = r.slide;
  const T = Math.max(1, Number.isFinite(sl.amplitudeTaper) ? sl.amplitudeTaper : 1);
  const reach = rock.reduce((a, x) => a + Math.abs(x.amplitude), 0) * T;
  const every = Math.max(1, Math.round(sl.alternateEvery || 1));
  const custom = sl.phaseCustom?.length ? sl.phaseCustom : [0];
  const period = sl.phaseMode === 'alternate' ? 2 * every : sl.phaseMode === 'custom' ? custom.length : 1;
  // Window j = −M..M around the middle pass. Radii in (lo, hi) can't be reached by any pass outside it, and that
  // stretch is wider than the largest possible gap (s + 2·reach) plus a full period of the phase program.
  const M = Math.ceil((2 * reach) / sp) + period + 1;
  // Degenerate (amplitude hundreds of passes deep): fall back to the bound no gap can exceed.
  if (M > 200) return sp + 2 * reach;
  const n = 2 * M + 1;
  const lo = -(M + 1) * sp + reach;
  const hi = (M + 1) * sp - reach;
  const mid = Math.max(0, Math.floor((Math.max(1, Math.round(sl.passes)) - 1) / 2));
  const dir = effectiveEndRadius(r) >= sl.startRadius ? 1 : -1;

  const lobes = rock.map((x) => Math.max(1, Math.round(x.lobes)));
  const G = lobes.reduce((g, L) => gcd(g, L), lobes[0]);
  const maxL = Math.max(...lobes);
  const S = Math.max(64, Math.min(Math.ceil((48 * maxL) / G), Math.floor(GAP_BUDGET / (n * rock.length))));
  const nr = rock.length;

  // Per (rosette, pass): amplitude × taper and the constant part of u.
  const amp = new Float64Array(nr);
  const off = new Float64Array(nr * n);
  for (let i = 0; i < nr; i++) {
    const x = rock[i];
    const L = lobes[i];
    amp[i] = x.amplitude * T;
    for (let j = 0; j < n; j++) {
      const k = mid + j - M;
      let prog: number;
      if (sl.phaseMode === 'alternate') prog = (((Math.floor(k / every) % 2) + 2) % 2) === 1 ? sl.alternateFraction : 0;
      else if (sl.phaseMode === 'custom') prog = (custom[((k % custom.length) + custom.length) % custom.length] * L) / 360;
      else prog = (k * sl.phaseStep * L) / 360;
      off[i * n + j] = ((x.phase || 0) * L) / 360 + prog;
    }
  }

  const rad = new Float64Array(n);
  let best = 0;
  for (let t = 0; t < S; t++) {
    const turns = t / S / G; // θ / 2π over one angular period
    for (let j = 0; j < n; j++) {
      let v = 0;
      for (let i = 0; i < nr; i++) v += amp[i] * profileValue(rock[i].profile, -lobes[i] * turns + off[i * n + j]);
      rad[j] = dir * (j - M) * sp + v;
    }
    rad.sort();
    for (let j = 0; j + 1 < n; j++) {
      if (rad[j] < lo) continue;
      if (rad[j + 1] > hi) break;
      const g = rad[j + 1] - rad[j];
      if (g > best) best = g;
    }
  }
  return best > 0 ? best : sp;
}

/**
 * Metal coverage: shallowest groove width / maxPassGap. ≥ 1 means the dial is fully cut: the grooves are wide
 * enough that no flat survives anywhere between neighbouring cuts. Uses the effective end (Fill to edge).
 */
export function grooveCoverage(r: Recipe): number | null {
  const gap = maxPassGap(r);
  if (!gap) return null;
  const dMin = r.metal.baseDepth - pumpReach(r);
  return (2 * Math.max(0, dMin) * Math.tan(((r.metal.toolAngle / 2) * Math.PI) / 180)) / gap;
}

// ---------------------------------------------------------------------------------------------------------
// Colour: OKLCH harmonies with a contrast floor against the paper

type Oklch = [number, number, number];

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function hexToLinear(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)];
}

function oklchToLinear([L, C, hDeg]: Oklch): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function linearToOklch([r, g, b]: [number, number, number]): Oklch {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}

/** OKLCH → #rrggbb, pulling chroma in until the colour fits the sRGB gamut. */
function oklchHex(c: Oklch): string {
  const [L, C0, h] = c;
  const inGamut = (rgb: number[]) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  let C = C0;
  let rgb = oklchToLinear([L, C, h]);
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = C0;
    for (let i = 0; i < 18; i++) {
      C = (lo + hi) / 2;
      if (inGamut(oklchToLinear([L, C, h]))) lo = C;
      else hi = C;
    }
    C = lo;
    rgb = oklchToLinear([L, C, h]);
  }
  const to = (v: number) => Math.round(Math.min(1, Math.max(0, linearToSrgb(Math.min(1, Math.max(0, v))))) * 255).toString(16).padStart(2, '0');
  return `#${to(rgb[0])}${to(rgb[1])}${to(rgb[2])}`;
}

function relLuminance(hex: string): number {
  const [r, g, b] = hexToLinear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colours (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Minimum ink-on-paper contrast for fine guilloché lines. */
export const MIN_INK_CONTRAST = 4;

const isDarkPaper = (hex: string) => relLuminance(hex) < 0.18;

/** Move a colour's OKLCH lightness away from the paper until it reaches the contrast floor. */
function withContrast(hex: string, paper: string, min = MIN_INK_CONTRAST): string {
  if (contrastRatio(hex, paper) >= min) return hex;
  const dark = isDarkPaper(paper);
  const [L0, C, h] = linearToOklch(hexToLinear(hex));
  let out = hex;
  for (let i = 1; i <= 50; i++) {
    const L = dark ? Math.min(0.99, L0 + i * 0.02) : Math.max(0.02, L0 - i * 0.02);
    out = oklchHex([L, C, h]);
    if (contrastRatio(out, paper) >= min) return out;
  }
  return dark ? '#ffffff' : '#000000';
}

type PaperKind = 'cream' | 'white' | 'tinted' | 'dark';

function makePaper(rng: Rng, kind: PaperKind, hue: number): string {
  switch (kind) {
    case 'cream':
      return oklchHex([rng.float(0.94, 0.975), rng.float(0.012, 0.03), rng.float(70, 95)]);
    case 'white':
      return oklchHex([rng.float(0.975, 0.995), rng.float(0, 0.006), rng.float(0, 360)]);
    case 'tinted':
      return oklchHex([rng.float(0.92, 0.96), rng.float(0.02, 0.045), hue]);
    case 'dark':
      return oklchHex([rng.float(0.14, 0.24), rng.float(0.01, 0.045), hue]);
  }
}

type Harmony = 'analogous' | 'complementary' | 'split' | 'triadic' | 'mono';

/** Hues for a harmony around h0, n colours, in drawing order (gradient-friendly). */
function harmonyHues(rng: Rng, kind: Harmony, h0: number, n: number): number[] {
  const out: number[] = [];
  const spread = (centres: number[]) => {
    for (let i = 0; i < n; i++) out.push(centres[i % centres.length] + rng.float(-12, 12) + Math.floor(i / centres.length) * rng.float(8, 20));
  };
  switch (kind) {
    case 'analogous': {
      const step = rng.float(14, 32) * rng.sign();
      for (let i = 0; i < n; i++) out.push(h0 + step * i);
      break;
    }
    case 'complementary':
      spread([h0, h0 + 180]);
      break;
    case 'split':
      spread([h0, h0 + 150, h0 + 210]);
      break;
    case 'triadic':
      spread([h0, h0 + 120, h0 + 240]);
      break;
    case 'mono':
      for (let i = 0; i < n; i++) out.push(h0 + rng.float(-6, 6));
      break;
  }
  return out.map((h) => ((h % 360) + 360) % 360);
}

/** A generated ink palette (2–6 colours) and paper. */
function generatePalette(rng: Rng, paperLocked: string | null): { colors: string[]; paper: string } {
  const h0 = rng.float(0, 360);
  const kind = rng.weighted<Harmony>([['analogous', 3], ['complementary', 2], ['split', 2], ['triadic', 1.5], ['mono', 2]]);
  const n = rng.weighted([[2, 1.5], [3, 3], [4, 3], [5, 2], [6, 1]]);
  const paperKind = rng.weighted<PaperKind>([['cream', 3], ['white', 2], ['tinted', 2], ['dark', 2]]);
  // Tinted / dark papers lean on the palette's own hue family (or its complement) so they sit together.
  const paperHue = h0 + rng.pick([0, 0, 180, 30, -30]);
  const paper = paperLocked ?? makePaper(rng, paperKind, paperHue);
  const dark = isDarkPaper(paper);
  const hues = harmonyHues(rng, kind, h0, n);
  const chroma = rng.float(0.07, 0.17);
  const colors = hues.map((h, i) => {
    let L: number;
    if (kind === 'mono') {
      // Lightness ramp, kept clear of the paper.
      const t = n > 1 ? i / (n - 1) : 0;
      L = dark ? 0.68 + 0.26 * t : 0.22 + 0.32 * t;
    } else {
      L = dark ? rng.float(0.76, 0.92) : rng.float(0.26, 0.52);
    }
    const c = chroma * rng.float(0.75, 1.15) * (kind === 'mono' ? 0.9 : 1);
    return withContrast(oklchHex([L, c, h]), paper);
  });
  return { colors, paper };
}

/** Enamel colour: rich, mid-dark, any hue. */
function generateEnamel(rng: Rng): string {
  return oklchHex([rng.float(0.3, 0.55), rng.float(0.07, 0.17), rng.float(0, 360)]);
}

/** Rotate a colour's hue in OKLCH (keeps lightness and chroma). */
function rotateHue(hex: string, deg: number): string {
  const [L, C, h] = linearToOklch(hexToLinear(hex));
  return oklchHex([L, C, (((h + deg) % 360) + 360) % 360]);
}

function styleInk(ctx: Ctx): void {
  const { rng } = ctx;
  const paperLocked = ctx.locked('ink.paper') ? ctx.cur.ink.paper : null;
  if (!ctx.locked('ink.palette')) {
    // PALETTES stay one source among several; most palettes are generated.
    let colors: string[];
    let paper: string;
    if (rng.chance(0.25)) {
      let pals = PALETTES;
      if (paperLocked) {
        const m = PALETTES.filter((x) => isDarkPaper(x.paper) === isDarkPaper(paperLocked));
        if (m.length) pals = m;
      }
      const pal = rng.weighted(pals.map((x) => [x, x.colors.length === 1 ? 0.6 : x.name === 'Banknote' ? 1.5 : 1] as const));
      paper = paperLocked ?? pal.paper;
      colors = pal.colors.map((c) => withContrast(c, paper));
    } else {
      ({ colors, paper } = generatePalette(rng, paperLocked));
    }
    ctx.set('ink.palette', colors);
    ctx.set('ink.paper', paper);
  } else if (!paperLocked) {
    // Palette kept: choose a paper it reads on.
    const pal = ctx.get<string[]>('ink.palette');
    const meanLum = pal.reduce((a, c) => a + relLuminance(c), 0) / Math.max(1, pal.length);
    const paper = makePaper(rng, meanLum > 0.3 ? 'dark' : rng.pick(['cream', 'white', 'tinted'] as PaperKind[]), rng.float(0, 360));
    ctx.set('ink.paper', paper);
  }
  const n = ctx.get<string[]>('ink.palette').length;
  const fewPasses = ctx.out.slide.passes <= 3 && ctx.out.eccentric.enabled;
  ctx.set<ColorMode>(
    'ink.colorMode',
    n <= 1 ? 'single' : rng.weighted<ColorMode>([['single', 15], ['cycle', fewPasses ? 60 : 40], ['gradient', fewPasses ? 25 : 45]]),
  );
  // Pumped pens swell to ×1.6, so start a little thinner.
  const pumped = ctx.out.rosettes.some((x) => x.enabled && x.axis === 'pump');
  const w = ctx.spacing * (pumped ? rng.float(0.14, 0.3) : rng.float(0.18, 0.4));
  ctx.num('ink.lineWidth', Math.min(0.5, Math.max(0.08, w)));
  ctx.num('ink.opacity', rng.float(0.72, 1));
}

function styleMetal(ctx: Ctx): void {
  const { rng } = ctx;
  ctx.set<MetalKind>('metal.material', rng.weighted<MetalKind>([['silver', 2.5], ['gold', 2], ['rose', 2], ['brass', 1.5], ['steel', 1.5], ['blued', 1.5]]));
  // Full coverage: the shallowest groove is 1.0–1.2 × the widest gap between neighbouring centrelines, so the
  // whole surface is cut and neighbouring groove walls meet in ridges (raised diamonds on barleycorn).
  // ctx.out's geometry is final here (compound, pumps, fitToWork have run); pumps don't move the centrelines.
  const gap = maxPassGap(ctx.out) ?? (ctx.spacing > 0 ? ctx.spacing : 0.4);
  const k = rng.float(1.0, 1.2);
  ctx.coverageK = k;
  const width = k * gap;
  const pumps = ctx.slots.filter((x) => x.attached && x.r.enabled && x.r.axis === 'pump');
  // Alternate phasing (barleycorn, basket, cartouche) gets broad gravers: wide, flashing facets.
  const alt = ctx.out.slide.phaseMode === 'alternate';
  let angle = alt ? rng.int(125, 150) : rng.int(95, 145);
  // Widen the graver until the shallowest cut fits its depth budget (under the 0.4 mm cap, and with a pump,
  // shallow enough to leave depth room for the modulation).
  angle = Math.max(angle, Math.ceil(angleForWidth(width, pumps.length ? 0.2 : 0.38)));
  angle = ctx.num('metal.toolAngle', angle);
  const shallow = depthForWidth(width, angle);
  const T = Math.max(1, ctx.get<number>('slide.amplitudeTaper'));
  if (pumps.length) {
    const bdLocked = ctx.locked('metal.baseDepth');
    const bd = ctx.out.metal.baseDepth;
    // Pump reach 50–100 % of the shallowest depth: depth visibly breathes but never lifts out of the cut.
    const room = bdLocked ? Math.max(0.005, Math.min(0.6 * bd, bd - shallow)) : Math.min(shallow * rng.float(0.5, 1.0), 0.395 - shallow);
    for (const q of pumps) q.num('amplitude', Math.max(0.005, room / T / pumps.length));
  }
  ctx.num('metal.baseDepth', depthForWidth(width, angle, pumpReach(ctx.out)));
  ctx.num('metal.lightAngle', rng.float(20, 70));
  ctx.num('metal.lightElevation', rng.float(28, 55));
  const enamel = ctx.set('metal.enamel', rng.chance(0.35));
  if (enamel) {
    ctx.set('metal.enamelColor', generateEnamel(rng));
    // Translucent, so the guilloché sparkles through.
    ctx.num('metal.enamelOpacity', rng.float(0.3, 0.55));
  }
}

/**
 * Re-size the metal cut for changed geometry: the shallowest groove = k × the widest gap (k = coverage, 1.0–1.2).
 * The graver is widened first if the depth would pass the 0.4 mm cap. Shared by Mutate and the post-symmetry fit.
 */
function fitMetalCut(r: Recipe, ls: LockSet, k: number): void {
  if (r.mode !== 'metal' || pathLocked(ls, 'metal.baseDepth')) return;
  const gap = maxPassGap(r);
  if (!gap) return;
  const width = k * gap;
  const reach = pumpReach(r);
  // The 0.4 mm depth cap would leave flats: widen the graver first (if it's free).
  if (!pathLocked(ls, 'metal.toolAngle') && width / (2 * Math.tan(((r.metal.toolAngle / 2) * Math.PI) / 180)) + reach > 0.4) {
    const angle = Math.max(r.metal.toolAngle, Math.ceil(angleForWidth(width, Math.max(0.05, 0.395 - reach))));
    r.metal.toolAngle = fitNumber(PARAM_BY_KEY.get('metal.toolAngle') as NumDef, angle);
  }
  r.metal.baseDepth = fitNumber(PARAM_BY_KEY.get('metal.baseDepth') as NumDef, depthForWidth(width, r.metal.toolAngle, reach));
}

/** Symmetry orders Random picks when 'symmetry.order' is unlocked (0 = free). */
const SYMMETRY_ORDERS: [number, number][] = [[0, 3], [6, 1], [8, 1], [12, 2], [24, 1]];

/** Plate view-state carried over from `current` (a v1 recipe may lack it: off and free). */
function currentView(cur: Recipe): { fill: boolean; order: number; mirror: boolean } {
  const order = Number(cur.symmetry?.order ?? 0);
  return { fill: !!cur.machine?.fillEdge, order: Number.isFinite(order) ? order : 0, mirror: !!cur.symmetry?.mirror };
}

// ---------------------------------------------------------------------------------------------------------
// Public API

/**
 * Deterministic for a given (seed, current, locks), except fresh rosette ids (newRosetteId).
 * Keeps current.mode and every locked value.
 */
export function randomRecipe(seed: number, current: Recipe, locks: string[]): Recipe {
  const rng = new Rng(seed);
  const ctx = new Ctx(rng, parseLocks(locks), current);
  ctx.out.version = RECIPE_VERSION;
  ctx.out.mode = current.mode;

  // Plate view-state first, so every family builds for it. Locked (the UI default): kept from `current`, with no
  // RNG draw, so the rest of the sequence is unchanged. Unlocked: drawn here. The plate size is never randomized.
  const view = currentView(current);
  const order = ctx.locked('symmetry.order') ? view.order : rng.weighted(SYMMETRY_ORDERS);
  const mirror = ctx.locked('symmetry.mirror') ? view.mirror : order >= 2 && rng.chance(0.4);
  const fill = ctx.locked('machine.fillEdge') ? view.fill : rng.chance(0.35);
  ctx.out.machine.fillEdge = fill;
  ctx.out.symmetry = { order, mirror };
  ctx.fill = fill;
  ctx.N = order >= 2 ? Math.round(order) : 0;
  ctx.mirror = mirror;

  let pool = FAMILY_LIST.filter((f) => familyAllowed(f, ctx));
  if (!pool.length) pool = FAMILY_LIST;
  const symOk = pool.filter((f) => familySymmetryOk(f, ctx));
  if (symOk.length) pool = symOk;
  const family = rng.weighted(pool.map((f) => [f, familyWeight(f, ctx)] as const));

  neutral(ctx);
  // Metal: fine pass spacing so the V-grooves can meet (full-coverage engraving, no flats between cuts).
  // 0.25–0.6 mm on the 100 mm reference; small plates go finer (to ×0.5: 0.125–0.3 mm on a 28–50 mm watch dial,
  // 50–120 rings) so a dial reads as finely as a real one instead of as a magnified 100 mm plate.
  if (current.mode === 'metal') ctx.metalSpacing = rng.float(0.25, 0.6) * Math.min(1, Math.max(0.5, ctx.s));
  ctx.stackN = rng.weighted(family.stack ?? STACK_DEFAULT);
  family.build(ctx);

  // Shared for every family: compound rock stack, pump rosettes (about half the time, both modes), rubber.
  compound(ctx);
  const first = ctx.slots.find((x) => x.r.axis === 'rock');
  const L = ctx.primary?.L ?? first?.r.lobes ?? 12;
  const pumpN = family.id === 'pumped' ? (rng.chance(0.25) ? 2 : 1) : rng.chance(0.48) ? (rng.chance(0.15) ? 2 : 1) : 0;
  if (pumpN) addPumps(ctx, L, pumpN);
  rubberFor(ctx, L, first?.r.profile ?? 'sine');
  adapt(ctx);
  ctx.finishRosettes();
  fitToWork(ctx);
  fillFit(ctx);
  holdSymmetry(ctx.out, ctx.locks, ctx.N, ctx.mirror);

  if (current.mode === 'metal') styleMetal(ctx);
  else styleInk(ctx);

  ctx.out.seed = seed;
  ctx.set('name', `${rng.pick(family.names)} No. ${(seed >>> 0) % 10000}`);

  // Safety net: snap anything the families missed. If that moved lobes or phases, the widest gap moved with
  // them: re-fit the cut so coverage stays where styleMetal put it.
  const out = enforceSymmetry(ctx.out);
  if (out !== ctx.out) fitMetalCut(out, ctx.locks, ctx.coverageK);
  return out;
}

/** Numeric params Mutate nudges: everything with a Random range that is relevant to the current recipe. */
function mutableParams(r: Recipe): ParamDef[] {
  return PARAMS.filter(
    (d) => (d.type === 'number' || d.type === 'int') && d.random && (!d.modes || d.modes.includes(r.mode)) && (!d.visible || d.visible(r)),
  );
}

function nudge(rng: Rng, def: NumDef, v: number, amount: number): number {
  const [lo, hi] = def.random ?? [def.min ?? 0, def.max ?? 1];
  const width = Math.max(1e-6, hi - lo);
  if (def.key === 'phase') {
    const x = v + rng.gauss() * amount * 60;
    return fitNumber(def, ((x % 360) + 360) % 360);
  }
  // Scale-like: about amount/2 of the value (amount 0.15 → ~7%), floored at a tenth of the range so zeros still move.
  const sigma = 0.5 * amount * Math.min(width, Math.max(Math.abs(v), 0.1 * width));
  return fitNumber(def, v + rng.gauss() * sigma);
}

/**
 * Occasionally grow or shrink the stack: add a related secondary (or a pump), or drop an unlocked secondary
 * (never the last rock rosette). The summed rock amplitude is kept, so the spacing rule still holds.
 */
function mutateStack(out: Recipe, rng: Rng, ls: LockSet, amount: number, N: number, mirror: boolean): void {
  const unlocked = (r: Rosette) => !ls.rosettes.has(r.id);
  const ampFree = (r: Rosette) => {
    const k = ls.rosettes.get(r.id);
    return !k || (k !== 'all' && !k.has('amplitude'));
  };
  const rocks = () => out.rosettes.filter((r) => r.enabled && r.axis === 'rock');
  const rockSum = () => rocks().reduce((a, r) => a + r.amplitude, 0);
  const rescaleTo = (target: number) => {
    const free = rocks().filter(ampFree);
    const fixed = rockSum() - free.reduce((a, r) => a + r.amplitude, 0);
    const freeSum = rockSum() - fixed;
    if (freeSum <= 0) return;
    const k = Math.max(0.2, (target - fixed) / freeSum);
    for (const r of free) r.amplitude = fitNumber(ROSETTE_PARAM_BY_KEY.get('amplitude'), r.amplitude * k);
  };
  const p = Math.min(1, amount / 0.15);
  const primary = rocks()[0];
  if (!primary) return;

  if (rng.chance(0.12 * p) && rocks().length < 4 && out.rosettes.length < MAX_ROSETTES) {
    const before = rockSum();
    const used = new Set(rocks().map((r) => r.lobes));
    const L2 = secondaryLobes(rng, primary.lobes, used, N);
    out.rosettes.push({
      id: newRosetteId(),
      enabled: true,
      axis: 'rock',
      lobes: L2,
      amplitude: fitNumber(ROSETTE_PARAM_BY_KEY.get('amplitude'), primary.amplitude * rng.float(0.2, 0.5) * Math.min(1, primary.lobes / L2)),
      profile: rng.weighted(PROFILE_WEIGHTS.filter(([k]) => k !== primary.profile && !(mirror && ASYMMETRIC.has(k)))),
      phase: fitNumber(ROSETTE_PARAM_BY_KEY.get('phase'), rng.float(0, 360)),
    });
    rescaleTo(before);
  } else if (rng.chance(0.1 * p) && rocks().length >= 2) {
    const victims = rocks().slice(1).filter(unlocked);
    if (victims.length) {
      const before = rockSum();
      const v = rng.pick(victims);
      out.rosettes = out.rosettes.filter((r) => r !== v);
      rescaleTo(before);
    }
  }

  const pumps = out.rosettes.filter((r) => r.axis === 'pump');
  if (!pumps.length && rng.chance(0.06 * p) && out.rosettes.length < MAX_ROSETTES) {
    const depthRoom = Math.max(0.01, out.metal.baseDepth - pumpReach(out));
    out.rosettes.push({
      id: newRosetteId(),
      enabled: true,
      axis: 'pump',
      lobes: pumpLobes(rng, primary.lobes, new Set(), N),
      amplitude: fitNumber(ROSETTE_PARAM_BY_KEY.get('amplitude'), out.mode === 'metal' ? Math.min(depthRoom * rng.float(0.4, 0.8), 0.39 - depthRoom) : rng.float(0.12, 0.35)),
      profile: rng.weighted<ProfileKind>([['sine', 4], ['convex', 2], ['square', 1]]),
      phase: fitNumber(ROSETTE_PARAM_BY_KEY.get('phase'), rng.float(0, 360)),
    });
  } else if (pumps.length && rng.chance(0.05 * p)) {
    const victims = pumps.filter(unlocked);
    if (victims.length) {
      const v = rng.pick(victims);
      out.rosettes = out.rosettes.filter((r) => r !== v);
    }
  }
}

/** Small Gaussian nudges to unlocked numeric params; occasionally flips the phase mode or swaps a profile. */
export function mutateRecipe(current: Recipe, seed: number, locks: string[], amount = 0.15): Recipe {
  const rng = new Rng((seed ^ 0x5bd1e995) >>> 0);
  const ls = parseLocks(locks);
  const out = cloneRecipe(current);
  // Plate view-state is never mutated (locked or not); symmetry steers the nudges below.
  const view = currentView(current);
  out.machine.fillEdge = view.fill;
  out.symmetry = { order: view.order, mirror: view.mirror };
  const N = view.order >= 2 ? Math.round(view.order) : 0;
  const mirror = view.mirror;
  // Values the symmetry pins: N evenly spaced divisions; mirror has no twist and only half-lobe alternation.
  const pinned = new Set<string>([...(N >= 2 ? ['eccentric.divisions'] : []), ...(mirror ? ['slide.phaseStep', 'slide.alternateFraction'] : [])]);

  // Radii move together (centre + span) so narrow bands, e.g. a rosace's, keep their shape.
  const radiiFree = !pathLocked(ls, 'slide.startRadius') && !pathLocked(ls, 'slide.endRadius');
  if (radiiFree) {
    const { startRadius: a, endRadius: b } = out.slide;
    const centre = (a + b) / 2 + rng.gauss() * 0.5 * amount * 0.2 * Math.max(5, (a + b) / 2);
    const half = ((b - a) / 2) * (1 + rng.gauss() * 0.5 * amount);
    if (Math.min(a, b) <= 0.05) {
      // A cut that runs into the centre stays there: only its outer radius moves.
      const outer = Math.max(a, b) * (1 + rng.gauss() * 0.5 * amount * 0.2);
      const fitOuter = fitNumber(PARAM_BY_KEY.get(a <= b ? 'slide.endRadius' : 'slide.startRadius') as NumDef, outer);
      out.slide.startRadius = a <= b ? 0 : fitOuter;
      out.slide.endRadius = a <= b ? fitOuter : fitNumber(PARAM_BY_KEY.get('slide.endRadius') as NumDef, 0);
    } else {
      out.slide.startRadius = fitNumber(PARAM_BY_KEY.get('slide.startRadius') as NumDef, centre - half);
      out.slide.endRadius = fitNumber(PARAM_BY_KEY.get('slide.endRadius') as NumDef, centre + half);
    }
  }

  for (const def of mutableParams(current)) {
    if (pathLocked(ls, def.key) || pinned.has(def.key)) continue;
    if (radiiFree && (def.key === 'slide.startRadius' || def.key === 'slide.endRadius')) continue;
    const v = getPath(out, def.key);
    if (typeof v !== 'number') continue;
    setPath(out, def.key, nudge(rng, def as NumDef, v, amount));
  }

  if (!pathLocked(ls, 'slide.phaseMode') && !out.slide.spiral && rng.chance(0.08)) {
    if (out.slide.phaseMode === 'linear') out.slide.phaseMode = 'alternate';
    else if (out.slide.phaseMode === 'alternate') out.slide.phaseMode = 'linear';
  }

  if (!ls.stack) {
    for (const ros of out.rosettes) {
      const lk = ls.rosettes.get(ros.id);
      if (lk === 'all') continue;
      const isLocked = (k: string) => !!lk && lk.has(k);
      for (const key of ['lobes', 'amplitude', 'phase'] as const) {
        if (isLocked(key)) continue;
        const def = ROSETTE_PARAM_BY_KEY.get(key)!;
        if (key === 'amplitude' && ros.axis === 'pump') {
          // Pump amplitudes live far below the rock range: nudge relatively.
          ros.amplitude = fitNumber(def, ros.amplitude * (1 + rng.gauss() * amount));
        } else if (key === 'lobes') {
          // Lobes change the character a lot: only sometimes, and by a lobe or two (by N under symmetry).
          if (rng.chance(0.25)) {
            const d = rng.sign() * Math.max(1, Math.round(Math.abs(rng.gauss()) * amount * 0.5 * ros.lobes));
            ros.lobes = N >= 2 ? snapLobes(ros.lobes + Math.sign(d) * N * Math.max(1, Math.round(Math.abs(d) / N)), N) : fitNumber(def, ros.lobes + d);
          }
        } else {
          ros[key] = nudge(rng, def, ros[key], amount);
        }
      }
      if (!isLocked('profile') && rng.chance(0.06)) {
        const others = PROFILES.filter((p) => p !== ros.profile && !(mirror && ASYMMETRIC.has(p)));
        ros.profile = rng.pick(others);
      }
    }
  }

  if (!ls.stack) mutateStack(out, rng, ls, amount, N, mirror);

  // Metal: spacing drifted a lot (passes vs span, the effective span with Fill on): bring it back with the pass
  // count. Before the symmetry step, whose whole-twist drift depends on the pass count.
  if (out.mode === 'metal') {
    const sp0 = passSpacing(current);
    const sp1 = passSpacing(out);
    if (sp0 && sp1 && !pathLocked(ls, 'slide.passes') && (sp1 < sp0 / 1.3 || sp1 > sp0 * 1.3)) {
      const span = Math.abs(effectiveEndRadius(out) - out.slide.startRadius);
      const divs = out.slide.spiral && out.eccentric.enabled ? Math.max(1, out.eccentric.divisions) : 1;
      const n = out.slide.spiral ? Math.round(span / (sp0 * divs)) : Math.round(span / sp0) + 1;
      out.slide.passes = Math.max(2, fitNumber(PARAM_BY_KEY.get('slide.passes') as NumDef, n));
    }
  }
  holdSymmetry(out, ls, N, mirror);

  // Colour drifts with the pattern: rotate the whole palette (or the enamel) a little in OKLCH hue.
  if (out.mode === 'ink' && !pathLocked(ls, 'ink.palette') && rng.chance(0.6)) {
    const dh = rng.gauss() * amount * 60;
    out.ink.palette = out.ink.palette.map((c) => withContrast(rotateHue(c, dh), out.ink.paper));
  }
  if (out.mode === 'metal' && out.metal.enamel && !pathLocked(ls, 'metal.enamelColor') && rng.chance(0.5)) {
    out.metal.enamelColor = rotateHue(out.metal.enamelColor, rng.gauss() * amount * 60);
  }

  // Safety net for symmetry, before the metal fit below measures the final geometry.
  const res = enforceSymmetry(out);
  // Metal: keep the dial fully cut. Hold the previous coverage (clamped to 1.0–1.2) against the new widest gap.
  fitMetalCut(res, ls, Math.min(1.2, Math.max(1.0, grooveCoverage(current) ?? 1.1)));

  res.seed = seed;
  return res;
}
