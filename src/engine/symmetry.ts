// Pattern symmetry: analysis (readout) and enforcement (UI edits, Random, Mutate).
//
// Geometry, in the engine's conventions (machine.ts, chucks.ts). Work angle psi = -theta (the work turns CCW
// under a tool on +X). A rosette with L lobes sits at
//   u = L * psi / 360 + phase * L / 360 + program        (psi, phase in degrees; program in lobes)
// and profile(u) peaks at whole u. So rosette i, pass k puts a peak on work angle psi when
//   psi = -phase - 360 * program_k / L   (mod 360 / L).
// A peak on 12 o'clock (psi = 90°, the +Y work axis) therefore needs   phase ≡ -90 ≡ 270 (mod 360 / L)
// (see peakAtTwelvePhase). L = 12 → 0°, L = 7 → 12.857°, L = 18 → 10°.
//
// One eccentric division of the pattern is B = B_e - C: B_e is the rosette/elliptical pattern centred on the
// spindle axis, C the eccentric offset. Division d is B turned by -delta_d about the work centre, so the whole
// pattern is U = union over d of rot(-delta_d) B.
//
// Rotational order. B's own rotations about the work centre: G = gcd of the active lobe counts when B is centred
// (no offset, no spiral), gcd(G, 2) with the elliptical chuck, 1 when off-centre or spiral (a spiral is never
// rotationally symmetric). The division angles S then combine with those: U is symmetric under every rotation
// that maps the angle set T = S + (360/h_B)Z to itself. That gives G for plain work, lcm(D, G) for an even
// D-division chuck at offset 0, D for an even off-centre chuck (whatever the lobes), and 1 for a lone spiral.
//
// Mirror. Even profiles only (not flame / saw); no spiral (it is chiral). Each rosette's axis set is
// { -phase - 360 * program / L  (mod 180 / L) } and must be one set for every pass (linear drift breaks it unless
// the step is a whole half lobe; alternate needs a half-lobe offset). All rosettes, the elliptical major axis
// (mod 90) and, when off-centre, the eccentric direction (mod 180) must share one axis. Divisions never break it:
// D copies of a mirror-symmetric B, even or fanned, are symmetric about the middle copy's axis.
import type { ProfileKind, Recipe, Rosette } from '../state/recipe';

export interface SymmetryInfo {
  /** N-fold rotational symmetry of the whole pattern (1 = none). Infinity for plain concentric circles. */
  order: number;
  /** Mirror-symmetric about some axis through the centre. */
  mirror: boolean;
  /** When mirror: direction of one mirror axis, degrees in [0, 180) (work frame, 0 = 3 o'clock, 90 = 12 o'clock). */
  axis?: number;
}

/** Most eccentric divisions the chuck has (param max). */
const MAX_DIVISIONS = 36;
/** Largest lobe count (param max). */
const MAX_LOBES = 300;
/** Angle tolerance for set comparisons, degrees. */
const ANG_TOL = 1e-6;
/** Phase tolerance, as a fraction of the constraint period (half a lobe for rosettes). */
const REL_TOL = 1e-3;
const ASYMMETRIC: ReadonlySet<ProfileKind> = new Set<ProfileKind>(['flame', 'saw']);

const fin = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
const lobesOf = (ro: Rosette) => Math.max(1, Math.round(fin(ro.lobes, 1)));
const mod = (a: number, m: number) => ((a % m) + m) % m;

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Distance of x from the nearest multiple of m. */
function offLattice(x: number, m: number): number {
  const f = mod(x, m);
  return Math.min(f, m - f);
}

/** Rosettes that shape the pattern: enabled with a non-zero amplitude. */
function activeRosettes(r: Recipe): Rosette[] {
  return (r.rosettes ?? []).filter((ro) => ro.enabled && fin(ro.amplitude, 0) !== 0);
}

const ellipseOn = (r: Recipe) => !!r.elliptical?.enabled && fin(r.elliptical.e, 0) !== 0;
const eccOn = (r: Recipe) => !!r.eccentric?.enabled;
const offCentre = (r: Recipe) => eccOn(r) && fin(r.eccentric.offset, 0) !== 0;
const divisionsOf = (r: Recipe) => (eccOn(r) ? Math.max(1, Math.round(fin(r.eccentric.divisions, 1))) : 1);

/** Division angle per step in degrees, as chucks.makeChuckXform reads it (0 = 360 / D). */
function divisionStepDeg(r: Recipe): number {
  const D = divisionsOf(r);
  const s = fin(r.eccentric?.divisionStep, 0);
  return s ? s : 360 / D;
}

/** The phase (degrees, in [0, 360 / L)) that puts a peak of an L-lobe rosette on 12 o'clock (+Y) at pass 0. */
export function peakAtTwelvePhase(lobes: number): number {
  const L = Math.max(1, Math.round(lobes));
  const p = 360 / L;
  const v = mod(270, p);
  return p - v < ANG_TOL ? 0 : v;
}

// ---------------------------------------------------------------------------------------------------------
// Rotational order

/** Gcd of the active lobe counts; 0 when there are none (plain circles: any rotation). */
function lobeGcd(rs: Rosette[]): number {
  return rs.reduce((g, ro) => gcd(g, lobesOf(ro)), 0);
}

/** Rotational order of one division of the pattern about the work centre (0 = continuous). */
function baseOrder(r: Recipe, G: number): number {
  if (r.slide?.spiral || offCentre(r)) return 1;
  if (ellipseOn(r)) return gcd(G, 2);
  return G;
}

/** Distinct angles in [0, 360), sorted. */
function angleSet(values: number[]): number[] {
  const a = values.map((v) => mod(v, 360)).sort((x, y) => x - y);
  const out: number[] = [];
  for (const v of a) if (!out.length || v - out[out.length - 1] > ANG_TOL) out.push(v);
  if (out.length > 1 && 360 - out[out.length - 1] + out[0] <= ANG_TOL) out.pop();
  return out;
}

function hasAngle(set: number[], v: number): boolean {
  const x = mod(v, 360);
  let lo = 0;
  let hi = set.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (set[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  for (const i of [lo - 1, lo, 0, set.length - 1]) {
    if (i < 0 || i >= set.length) continue;
    const d = Math.abs(set[i] - x);
    if (Math.min(d, 360 - d) <= ANG_TOL * 10) return true;
  }
  return false;
}

/** Largest n such that rotating the finite angle set by 360/n maps it onto itself (n divides its size). */
function setOrder(set: number[]): number {
  const m = set.length;
  for (let n = m; n >= 2; n--) {
    if (m % n) continue;
    const step = 360 / n;
    if (set.every((t) => hasAngle(set, t + step))) return n;
  }
  return 1;
}

function rotationalOrder(r: Recipe): number {
  const G = lobeGcd(activeRosettes(r));
  const h = baseOrder(r, G);
  if (h === 0) return Infinity; // plain concentric circles: any rotation
  const D = divisionsOf(r);
  if (D === 1) return h;
  const step = divisionStepDeg(r);
  if (Math.abs(step - 360 / D) <= 1e-9) return (D * h) / gcd(D, h); // even divisions: lcm(D, h)
  const S: number[] = [];
  for (let d = 0; d < D; d++) S.push(d * step);
  const T: number[] = [];
  for (const s of S) for (let j = 0; j < h; j++) T.push(s + (j * 360) / h);
  return setOrder(angleSet(T));
}

// ---------------------------------------------------------------------------------------------------------
// Mirror

interface AxisConstraint {
  /** axis ≡ a (mod p), degrees */
  a: number;
  p: number;
}

/**
 * The program offset (lobes, mod 1/2) every pass of this rosette shares, or null when passes disagree (the
 * pattern twists or alternates by something other than a half lobe).
 */
function sharedProgramResidue(r: Recipe, L: number): number | null {
  const s = r.slide;
  const P = Math.max(1, Math.round(fin(s.passes, 1)));
  const same = (x: number) => offLattice(x, 0.5) <= REL_TOL * 0.5;
  if (s.phaseMode === 'alternate') {
    const every = Math.max(1, Math.round(fin(s.alternateEvery, 1)));
    if (P > every && !same(fin(s.alternateFraction, 0))) return null;
    return 0;
  }
  if (s.phaseMode === 'custom') {
    const list = Array.isArray(s.phaseCustom) && s.phaseCustom.length ? s.phaseCustom : [0];
    const vals = list.slice(0, Math.min(list.length, P)).map((v) => (fin(v, 0) * L) / 360);
    if (!vals.every((v) => same(v - vals[0]))) return null;
    return vals[0];
  }
  if (P > 1 && !same((fin(s.phaseStep, 0) * L) / 360)) return null;
  return 0;
}

/** Axis constraints of one division B, or null when B cannot be mirror-symmetric at all. */
function mirrorConstraints(r: Recipe): AxisConstraint[] | null {
  if (r.slide?.spiral) return null;
  const out: AxisConstraint[] = [];
  for (const ro of activeRosettes(r)) {
    if (ASYMMETRIC.has(ro.profile)) return null;
    const L = lobesOf(ro);
    const prog = sharedProgramResidue(r, L);
    if (prog === null) return null;
    out.push({ a: -fin(ro.phase, 0) - (360 * prog) / L, p: 180 / L });
  }
  if (ellipseOn(r)) out.push({ a: fin(r.elliptical.angle, 0), p: 90 });
  if (offCentre(r)) out.push({ a: fin(r.eccentric.angle, 0), p: 180 });
  return out;
}

/** Every common mirror axis (degrees in [0, 180)) of the constraints; [90] stands for "any" when there are none. */
function commonAxes(cs: AxisConstraint[]): number[] {
  if (!cs.length) return [90];
  const base = cs.reduce((a, c) => (c.p > a.p ? c : a), cs[0]);
  const n = Math.max(1, Math.round(180 / base.p));
  const out: number[] = [];
  for (let j = 0; j < n; j++) {
    const alpha = mod(base.a + j * base.p, 180);
    if (cs.every((c) => offLattice(alpha - c.a, c.p) <= REL_TOL * c.p)) out.push(alpha);
  }
  return out;
}

/**
 * A mirror axis of the whole pattern (degrees in [0, 180)), or null. With divisions the copies sit at
 * -d * step, so a fan of D copies is symmetric about its middle copy: alpha - (D - 1) * step / 2.
 */
function mirrorAxis(r: Recipe): number | null {
  const cs = mirrorConstraints(r);
  if (!cs) return null;
  const D = divisionsOf(r);
  const shift = D === 1 || Math.abs(divisionStepDeg(r) - 360 / D) <= 1e-9 ? 0 : ((D - 1) * divisionStepDeg(r)) / 2;
  const axes = commonAxes(cs).map((a) => mod(a - shift, 180));
  if (!axes.length) return null;
  const near = (x: number) => axes.find((a) => offLattice(a - x, 180) <= REL_TOL);
  return near(90) ?? near(0) ?? axes[0];
}

/** What symmetry the recipe actually has (readout; independent of recipe.symmetry). */
export function analyzeSymmetry(r: Recipe): SymmetryInfo {
  const order = rotationalOrder(r);
  const axis = mirrorAxis(r);
  const info: SymmetryInfo = { order, mirror: axis !== null };
  if (axis !== null) {
    // With N-fold rotation and one mirror axis the pattern has N axes, 180/N apart. Report 12–6 when it is one of
    // them (the axis enforceSymmetry aims for), else 3–9, else the first one counter-clockwise from 3 o'clock.
    const step = Number.isFinite(order) ? 180 / order : 0;
    const on = (x: number) => (step ? offLattice(x - axis, step) <= REL_TOL * Math.min(1, step) : true);
    info.axis = on(90) ? 90 : on(0) ? 0 : step ? mod(axis, step) : axis;
  }
  return info;
}

// ---------------------------------------------------------------------------------------------------------
// Enforcement

/** Copy-on-write editor: clones once on the first real change. */
class Draft {
  out: Recipe | null = null;
  constructor(readonly src: Recipe) {}
  get cur(): Recipe {
    return this.out ?? this.src;
  }
  edit(fn: (r: Recipe) => void): void {
    if (!this.out) this.out = structuredClone(this.src);
    fn(this.out);
  }
  /** Set a numeric field via fn when it differs by more than tol. */
  num(get: (r: Recipe) => number, set: (r: Recipe, v: number) => void, v: number, tol = 1e-9): void {
    if (Math.abs(get(this.cur) - v) > tol) this.edit((r) => set(r, v));
  }
}

/** Nearest element of xs to x (ties: the larger). */
function nearest(xs: number[], x: number): number {
  let best = xs[0];
  for (const v of xs) {
    const d = Math.abs(v - x);
    const bd = Math.abs(best - x);
    if (d < bd - 1e-12 || (Math.abs(d - bd) <= 1e-12 && v > best)) best = v;
  }
  return best;
}

/** Nearest value to x (degrees) of the form a + k * p inside [lo, hi]; x itself when it already is one. */
function snapAngle(x: number, a: number, p: number, lo: number, hi: number): number {
  if (offLattice(x - a, p) <= 1e-9) return x;
  const k = Math.round((x - a) / p);
  const cands = [k - 1, k, k + 1].map((j) => a + j * p).map((v) => (v < lo - 1e-9 ? v + 360 : v > hi + 1e-9 ? v - 360 : v)).filter((v) => v >= lo - 1e-9 && v <= hi + 1e-9);
  return cands.length ? nearest(cands, x) : mod(a, p);
}

function enforceOrder(d: Draft, N: number): void {
  // Lobe counts: nearest multiple of N in [N, floor(300 / N) * N].
  const maxL = Math.floor(MAX_LOBES / N) * N;
  for (let i = 0; i < d.cur.rosettes.length; i++) {
    const ro = d.cur.rosettes[i];
    if (!ro.enabled) continue;
    const L = Math.min(maxL, Math.max(N, Math.round(fin(ro.lobes, 1) / N) * N));
    d.num((r) => r.rosettes[i].lobes, (r, v) => (r.rosettes[i].lobes = v), L);
  }

  if (eccOn(d.cur)) {
    const r = d.cur;
    const D0 = divisionsOf(r);
    const centred = !r.slide.spiral && !offCentre(r) && !ellipseOn(r);
    // Already the rotations the order needs: keep the chuck exactly as it is.
    const ok = (D: number) => {
      const t = structuredClone(r);
      t.eccentric.divisions = D;
      t.eccentric.divisionStep = 0;
      const o = rotationalOrder(t);
      return o === Infinity || o % N === 0;
    };
    let D: number | null;
    if (centred) {
      // B is already N-fold: copies on divisors of N stay inside the rosette's own symmetry.
      const divs: number[] = [];
      for (let k = 1; k <= Math.min(N, MAX_DIVISIONS); k++) if (N % k === 0) divs.push(k);
      D = nearest(divs, D0);
    } else {
      const cands: number[] = [];
      for (let k = 1; k <= MAX_DIVISIONS; k++) if (ok(k)) cands.push(k);
      D = cands.length ? nearest(cands, D0) : null;
    }
    if (D === null) {
      // No division count reaches N with this offset / ellipse / spiral: drop the chuck.
      d.edit((x) => (x.eccentric.enabled = false));
    } else {
      d.num((x) => x.eccentric.divisions, (x, v) => (x.eccentric.divisions = v), D);
      const even = 360 / D;
      if (fin(d.cur.eccentric.divisionStep, 0) !== 0 && Math.abs(d.cur.eccentric.divisionStep - even) > 1e-9) {
        d.edit((x) => (x.eccentric.divisionStep = 0));
      }
    }
  }
  if (!eccOn(d.cur)) {
    // Without the dividing chuck a spiral has no rotational symmetry and an ellipse only 2-fold.
    if (d.cur.slide.spiral) d.edit((x) => (x.slide.spiral = false));
    if (ellipseOn(d.cur) && N > 2) d.edit((x) => (x.elliptical.enabled = false));
  }

  // Linear drift: total twist across the program (passes - 1 steps; a spiral's `passes` turns) snaps to the nearest
  // whole number of 360/N steps, kept within the ±30°/pass param range. 0 stays 0; a tiny drift may round to 0.
  const s = d.cur.slide;
  const step = fin(s.phaseStep, 0);
  const P = Math.max(1, Math.round(fin(s.passes, 1)));
  const turns = s.spiral ? P : P - 1;
  if (s.phaseMode === 'linear' && step !== 0 && turns > 0) {
    const unit = 360 / N / turns;
    let m = Math.round(step / unit);
    while (m !== 0 && Math.abs(m * unit) > 30 + 1e-9) m -= Math.sign(m);
    d.num((x) => x.slide.phaseStep, (x, v) => (x.slide.phaseStep = v), m * unit);
  }
}

function enforceMirror(d: Draft): void {
  // Even profiles only.
  for (let i = 0; i < d.cur.rosettes.length; i++) {
    const ro = d.cur.rosettes[i];
    if (!ro.enabled) continue;
    if (ro.profile === 'flame') d.edit((r) => (r.rosettes[i].profile = 'sine'));
    else if (ro.profile === 'saw') d.edit((r) => (r.rosettes[i].profile = 'triangle'));
  }
  // A spiral is chiral.
  if (d.cur.slide.spiral) d.edit((r) => (r.slide.spiral = false));

  // No twist: linear drift stops; alternate keeps its mode and grouping but offsets by whole half lobes;
  // custom offsets snap to whole half lobes of every rosette (multiples of 180 / gcd(lobes)).
  const s = d.cur.slide;
  if (s.phaseMode === 'linear') {
    d.num((r) => fin(r.slide.phaseStep, 0), (r, v) => (r.slide.phaseStep = v), 0);
  } else if (s.phaseMode === 'alternate') {
    const f = fin(s.alternateFraction, 0);
    if (offLattice(f, 0.5) > 1e-9) {
      const v = f < 0.25 ? 0 : f > 0.75 ? 1 : 0.5;
      d.edit((r) => (r.slide.alternateFraction = v));
    }
  } else {
    const G = lobeGcd(d.cur.rosettes.filter((ro) => ro.enabled));
    const unit = 180 / Math.max(1, G);
    const list = Array.isArray(s.phaseCustom) ? s.phaseCustom : [];
    const snapped = list.map((v) => {
      const x = fin(v, 0);
      return offLattice(x, unit) <= 1e-9 ? x : Math.max(-360, Math.min(360, Math.round(x / unit) * unit));
    });
    if (snapped.some((v, i) => v !== list[i])) d.edit((r) => (r.slide.phaseCustom = snapped));
  }

  // Peaks on 12 o'clock: phase ≡ 270 (mod 360 / L), the nearest such value in [0, 360].
  for (let i = 0; i < d.cur.rosettes.length; i++) {
    const ro = d.cur.rosettes[i];
    if (!ro.enabled) continue;
    const L = lobesOf(ro);
    const v = snapAngle(fin(ro.phase, 0), peakAtTwelvePhase(L), 360 / L, 0, 360);
    d.num((r) => fin(r.rosettes[i].phase, 0), (r, x) => (r.rosettes[i].phase = x), v);
  }

  // Elliptical major axis along or across 12–6: 0° or 90° (180° is the same axis).
  if (ellipseOn(d.cur)) {
    const a = snapAngle(fin(d.cur.elliptical.angle, 0), 0, 90, 0, 180);
    d.num((r) => fin(r.elliptical.angle, 0), (r, v) => (r.elliptical.angle = v), a);
  }

  // Off-centre work: the offset direction must be a mirror axis of the rosettes (≡ 90 mod 180 / G) and, with even
  // divisions, 12 o'clock must be one of the copies' axes (≡ 90 mod 180 / D): 90° / 270° always qualify.
  if (offCentre(d.cur)) {
    const r = d.cur;
    const G = lobeGcd(activeRosettes(r));
    const D = divisionsOf(r);
    const even = Math.abs(divisionStepDeg(r) - 360 / D) <= 1e-9;
    const g = gcd(G, even ? D : 0) || 1;
    let p = 180 / g;
    if (ellipseOn(r)) p = g % 2 === 0 ? 90 : 180;
    const b = snapAngle(fin(r.eccentric.angle, 0), 90, p, 0, 360);
    d.num((x) => fin(x.eccentric.angle, 0), (x, v) => (x.eccentric.angle = v), b);
  }
}

/**
 * Snap the recipe to recipe.symmetry (order >= 2 and/or mirror). Returns the SAME object when nothing changes,
 * otherwise a new recipe. Order 0 and mirror off = identity.
 *
 * Order N: enabled lobe counts → nearest multiple of N (N..floor(300/N)·N). Eccentric chuck: centred work → divisions
 * on the nearest divisor of N; off-centre (or elliptical / spiral) work → the nearest division count whose copies
 * give a multiple of N (a multiple of N), or the chuck is switched off when none fits; divisionStep → 0 (even).
 * Without the chuck, spiral is switched off and the ellipse too when N > 2. Linear drift snaps so the total twist is
 * the nearest whole number of 360/N steps (0 stays 0). The phase drift itself never breaks rotational symmetry;
 * this keeps the outer pass's lobes in register with the inner one's.
 * Mirror: flame → sine, saw → triangle, spiral off, linear drift → 0, alternate offset → whole half lobes, custom
 * offsets → multiples of 180/gcd(lobes), phases → peak on 12 o'clock (peakAtTwelvePhase), elliptical angle → 0/90°,
 * eccentric angle → nearest axis through 12–6 (90°/270°, or any equivalent under the divisions).
 */
export function enforceSymmetry(r: Recipe): Recipe {
  const sym = r.symmetry;
  const N = Math.round(fin(sym?.order, 0));
  const mirror = !!sym?.mirror;
  if (N < 2 && !mirror) return r;
  const d = new Draft(r);
  if (N >= 2) enforceOrder(d, N);
  if (mirror) enforceMirror(d);
  return d.out ?? r;
}
