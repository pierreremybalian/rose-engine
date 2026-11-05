import { describe, expect, it } from 'vitest';
import { analyzeSymmetry, enforceSymmetry, peakAtTwelvePhase } from '../../src/engine/symmetry';
import { computeToolpath, poseAt, prepare, toolPoint } from '../../src/engine/machine';
import { mulberry32, randomRecipe } from '../../src/engine/random';
import { PRESETS } from '../../src/presets';
import { PARAMS, ROSETTE_PARAMS, getPath } from '../../src/state/params';
import { defaultRecipe, defaultRosette, type Recipe, type Rosette } from '../../src/state/recipe';
import type { Toolpath } from '../../src/engine/types';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------------------------------------
// Numeric ground truth: is the toolpath (x, y and the pump depth z) mapped onto itself by a rotation / mirror?

type Map2 = (x: number, y: number) => [number, number];
const rotation = (deg: number): Map2 => {
  const c = Math.cos((deg * Math.PI) / 180);
  const s = Math.sin((deg * Math.PI) / 180);
  return (x, y) => [c * x - s * y, s * x + c * y];
};
/** Reflection about the line through the centre at `deg` (90 = the 12–6 axis). */
const mirror = (deg: number): Map2 => {
  const c = Math.cos((2 * deg * Math.PI) / 180);
  const s = Math.sin((2 * deg * Math.PI) / 180);
  return (x, y) => [c * x + s * y, s * x - c * y];
};

/**
 * Returns dev(map): the largest distance from a mapped sample to the toolpath polyline, matching z too
 * (|Δz| counts 10×, so crossings of passes with other depths are not mistaken for a match).
 */
function deviationIndex(tp: Toolpath) {
  const pairs: number[] = [];
  for (const p of tp.passes) {
    const end = p.start + p.count - 1;
    for (let i = p.start; i < end; i++) pairs.push(i, i + 1);
    if (p.closed && p.count > 1) pairs.push(end, p.start);
  }
  const segs = Int32Array.from(pairs);
  let lmax = 0;
  for (let s = 0; s < segs.length; s += 2) lmax = Math.max(lmax, Math.hypot(tp.x[segs[s + 1]] - tp.x[segs[s]], tp.y[segs[s + 1]] - tp.y[segs[s]]));
  const cell = Math.max(lmax, 0.05);
  const key = (ix: number, iy: number) => (ix + 32768) * 65536 + (iy + 32768);
  const grid = new Map<number, number[]>();
  for (let s = 0; s < segs.length; s += 2) {
    const i = segs[s];
    const j = segs[s + 1];
    const x0 = Math.floor(Math.min(tp.x[i], tp.x[j]) / cell);
    const x1 = Math.floor(Math.max(tp.x[i], tp.x[j]) / cell);
    const y0 = Math.floor(Math.min(tp.y[i], tp.y[j]) / cell);
    const y1 = Math.floor(Math.max(tp.y[i], tp.y[j]) / cell);
    for (let ix = x0; ix <= x1; ix++)
      for (let iy = y0; iy <= y1; iy++) {
        const k = key(ix, iy);
        let l = grid.get(k);
        if (!l) grid.set(k, (l = []));
        l.push(s);
      }
  }
  const dev = (map: Map2, queries = 6000): number => {
    const n = tp.totalSamples;
    let worst = 0;
    const stride = Math.max(1, Math.floor(n / queries));
    for (let q = 0; q < n; q += stride) {
      const [mx, my] = map(tp.x[q], tp.y[q]);
      const mz = tp.z[q];
      const cx = Math.floor(mx / cell);
      const cy = Math.floor(my / cell);
      let best = Infinity;
      for (let ix = cx - 2; ix <= cx + 2; ix++)
        for (let iy = cy - 2; iy <= cy + 2; iy++) {
          const l = grid.get(key(ix, iy));
          if (!l) continue;
          for (const s of l) {
            const i = segs[s];
            const j = segs[s + 1];
            const ax = tp.x[i];
            const ay = tp.y[i];
            const bx = tp.x[j] - ax;
            const by = tp.y[j] - ay;
            const L2 = bx * bx + by * by;
            const t = L2 > 0 ? Math.max(0, Math.min(1, ((mx - ax) * bx + (my - ay) * by) / L2)) : 0;
            const dz = tp.z[i] + t * (tp.z[j] - tp.z[i]) - mz;
            const d = Math.hypot(ax + t * bx - mx, ay + t * by - my, 10 * dz);
            if (d < best) best = d;
          }
        }
      worst = Math.max(worst, Number.isFinite(best) ? best : 99);
    }
    return worst;
  };
  return { dev, lmax };
}

/** Toolpath of a cut-down copy (few passes) for the numeric checks; symmetry does not depend on the pass count. */
function sampled(r: Recipe, maxPasses = 4) {
  const c = structuredClone(r);
  c.slide.passes = Math.min(c.slide.passes, maxPasses);
  const tp = computeToolpath(prepare(c, { maxSamples: 300_000 }));
  const idx = deviationIndex(tp);
  // A symmetric pattern maps samples onto the curve between samples: allow the chord error.
  return { ...idx, tol: 0.01 + 0.15 * idx.lmax, recipe: c };
}

function base(partial: (r: Recipe) => void = () => {}): Recipe {
  const r = defaultRecipe();
  r.machine.rubberRadius = 0;
  r.slide = { ...r.slide, startRadius: 8, endRadius: 30, passes: 4, phaseMode: 'linear', phaseStep: 0 };
  partial(r);
  return r;
}
const ros = (lobes: number, extra: Partial<Rosette> = {}) => defaultRosette({ lobes, amplitude: 1, ...extra });
const orderOf = (r: Recipe) => analyzeSymmetry(r).order;
const mirrorOf = (r: Recipe) => analyzeSymmetry(r).mirror;

// ---------------------------------------------------------------------------------------------------------

describe('analyzeSymmetry: rotational order', () => {
  it('gcd of the enabled lobe counts (rock and pump)', () => {
    expect(orderOf(base((r) => (r.rosettes = [ros(24), ros(12)])))).toBe(12);
    expect(orderOf(base((r) => (r.rosettes = [ros(18), ros(7)])))).toBe(1);
    expect(orderOf(base((r) => (r.rosettes = [ros(24), ros(6, { axis: 'pump', amplitude: 0.05 })])))).toBe(6);
    expect(orderOf(base((r) => (r.rosettes = [ros(24), ros(7, { enabled: false })])))).toBe(24);
    // A zero-amplitude rosette does not touch the cut.
    expect(orderOf(base((r) => (r.rosettes = [ros(24), ros(7, { amplitude: 0 })])))).toBe(24);
    // Phases and the phase program never change the rotational order.
    expect(orderOf(base((r) => {
      r.rosettes = [ros(24, { phase: 3 }), ros(36, { phase: 41 })];
      r.slide.phaseStep = 2.3;
    }))).toBe(12);
    // Plain circles.
    expect(orderOf(base((r) => (r.rosettes = [])))).toBe(Infinity);
  });

  it('elliptical chuck limits it to gcd(order, 2)', () => {
    expect(orderOf(base((r) => { r.rosettes = [ros(20)]; r.elliptical = { enabled: true, e: 3, angle: 17 }; }))).toBe(2);
    expect(orderOf(base((r) => { r.rosettes = [ros(21)]; r.elliptical = { enabled: true, e: 3, angle: 17 }; }))).toBe(1);
    expect(orderOf(base((r) => { r.rosettes = [ros(21)]; r.elliptical = { enabled: true, e: 0, angle: 17 }; }))).toBe(21);
  });

  it('eccentric divisions: copies about the work centre', () => {
    const ecc = (offset: number, divisions: number, divisionStep = 0, lobes = 12) =>
      orderOf(base((r) => { r.rosettes = [ros(lobes)]; r.eccentric = { enabled: true, offset, angle: 20, divisions, divisionStep }; }));
    // Off-centre: D evenly spaced copies are exactly D-fold, whatever the lobes.
    expect(ecc(6, 5)).toBe(5);
    expect(ecc(6, 12)).toBe(12);
    expect(ecc(6, 8, 0, 12)).toBe(8);
    expect(ecc(6, 5, 144)).toBe(5); // 144° steps still visit every fifth of a turn
    expect(ecc(6, 5, 30)).toBe(1); // a fan
    expect(ecc(6, 1)).toBe(1);
    expect(ecc(6, 4, 180)).toBe(2); // copies coincide in pairs
    // Centred (offset 0): the copies combine with the rosette's own symmetry, lcm(D, lobes).
    expect(ecc(0, 3)).toBe(12);
    expect(ecc(0, 5)).toBe(60);
    expect(ecc(0, 2, 45)).toBe(24);
  });

  it('spiral: 1, or D for a multi-start eccentric spiral', () => {
    expect(orderOf(base((r) => { r.rosettes = [ros(12)]; r.slide.spiral = true; }))).toBe(1);
    expect(orderOf(base((r) => { r.rosettes = [ros(12)]; r.slide.spiral = true; r.eccentric = { enabled: true, offset: 0, angle: 0, divisions: 3, divisionStep: 0 }; }))).toBe(3);
    expect(orderOf(base((r) => { r.rosettes = [ros(7)]; r.slide.spiral = true; r.eccentric = { enabled: true, offset: 4, angle: 0, divisions: 4, divisionStep: 0 }; }))).toBe(4);
  });

  it('matches the toolpath: the claimed rotation maps it onto itself, twice the order does not', () => {
    const cases: Recipe[] = [
      base((r) => (r.rosettes = [ros(24), ros(12, { profile: 'flame', amplitude: 0.6 })])),
      base((r) => (r.rosettes = [ros(18), ros(7, { amplitude: 0.5 })])),
      base((r) => (r.rosettes = [ros(24, { amplitude: 0.6 }), ros(6, { axis: 'pump', amplitude: 0.05 })])),
      base((r) => { r.rosettes = [ros(20)]; r.elliptical = { enabled: true, e: 3, angle: 17 }; }),
      base((r) => { r.rosettes = [ros(12)]; r.eccentric = { enabled: true, offset: 6, angle: 20, divisions: 5, divisionStep: 0 }; }),
      base((r) => { r.rosettes = [ros(12)]; r.eccentric = { enabled: true, offset: 0, angle: 0, divisions: 5, divisionStep: 0 }; }),
      base((r) => { r.rosettes = [ros(12)]; r.eccentric = { enabled: true, offset: 6, angle: 20, divisions: 5, divisionStep: 30 }; }),
      base((r) => { r.rosettes = [ros(12, { amplitude: 0.4 })]; r.elliptical = { enabled: true, e: 2, angle: 30 }; r.eccentric = { enabled: true, offset: 3, angle: 0, divisions: 6, divisionStep: 0 }; }),
      base((r) => { r.rosettes = [ros(7)]; r.slide.spiral = true; r.eccentric = { enabled: true, offset: 4, angle: 0, divisions: 4, divisionStep: 0 }; }),
      base((r) => { r.rosettes = [ros(12)]; r.slide.spiral = true; }),
    ];
    for (const r of cases) {
      const n = orderOf(r);
      const { dev, tol } = sampled(r);
      if (n > 1) expect(dev(rotation(360 / n)), `order ${n}`).toBeLessThan(tol);
      expect(dev(rotation(360 / (2 * n))), `not ${2 * n}`).toBeGreaterThan(0.05);
    }
  });
});

describe('analyzeSymmetry: mirror', () => {
  it('needs even profiles', () => {
    for (const profile of ['sine', 'convex', 'concave', 'square', 'triangle'] as const) expect(mirrorOf(base((r) => (r.rosettes = [ros(12, { profile })]))), profile).toBe(true);
    expect(mirrorOf(base((r) => (r.rosettes = [ros(12, { profile: 'flame' })])))).toBe(false);
    expect(mirrorOf(base((r) => (r.rosettes = [ros(12, { profile: 'saw' })])))).toBe(false);
    expect(mirrorOf(base((r) => (r.rosettes = [ros(12), ros(24, { profile: 'flame', enabled: false })])))).toBe(true);
  });

  it('no twist: linear drift breaks it, alternate by half a lobe keeps it', () => {
    expect(mirrorOf(base((r) => { r.rosettes = [ros(24)]; r.slide.phaseStep = 2; }))).toBe(false);
    expect(mirrorOf(base((r) => { r.rosettes = [ros(24)]; r.slide.phaseStep = 7.5; }))).toBe(true); // exactly half a lobe per pass
    expect(mirrorOf(base((r) => { r.rosettes = [ros(24)]; r.slide.phaseStep = 2; r.slide.passes = 1; }))).toBe(true);
    const alt = (f: number) => base((r) => {
      r.rosettes = [ros(24, { profile: 'triangle' }), ros(12, { amplitude: 0.3, phase: 15 })];
      r.slide = { ...r.slide, phaseMode: 'alternate', alternateEvery: 2, alternateFraction: f };
    });
    expect(mirrorOf(alt(0.5))).toBe(true);
    expect(mirrorOf(alt(0.25))).toBe(false); // odd passes' axes sit a quarter lobe away
    const custom = (list: number[]) => base((r) => { r.rosettes = [ros(12)]; r.slide.phaseMode = 'custom'; r.slide.phaseCustom = list; });
    expect(mirrorOf(custom([0, 15, 30]))).toBe(true);
    expect(mirrorOf(custom([0, 7]))).toBe(false);
  });

  it('every rosette must put a peak or valley on one common axis', () => {
    expect(mirrorOf(base((r) => (r.rosettes = [ros(12, { phase: 0 }), ros(18, { phase: 10 })])))).toBe(true);
    expect(mirrorOf(base((r) => (r.rosettes = [ros(12, { phase: 0 }), ros(18, { phase: 3 })])))).toBe(false);
    expect(mirrorOf(base((r) => (r.rosettes = [ros(7, { phase: 11 })])))).toBe(true); // a single rosette always has axes
  });

  it('chuck angles must agree with that axis', () => {
    const ell = (angle: number) => base((r) => { r.rosettes = [ros(12)]; r.elliptical = { enabled: true, e: 3, angle }; });
    expect(mirrorOf(ell(0))).toBe(true);
    expect(mirrorOf(ell(90))).toBe(true);
    expect(mirrorOf(ell(30))).toBe(true); // 30° is also a peak axis of a 12-lobe rosette at phase 0
    expect(mirrorOf(ell(10))).toBe(false);
    const ecc = (angle: number, offset = 5) => base((r) => { r.rosettes = [ros(12)]; r.eccentric = { enabled: true, offset, angle, divisions: 3, divisionStep: 0 }; });
    expect(mirrorOf(ecc(90))).toBe(true);
    expect(mirrorOf(ecc(15))).toBe(true); // through a valley
    expect(mirrorOf(ecc(195))).toBe(true);
    expect(mirrorOf(ecc(10))).toBe(false);
    expect(mirrorOf(ecc(10, 0))).toBe(true); // centred: the direction does not matter
  });

  it('a spiral is never mirror-symmetric', () => {
    expect(mirrorOf(base((r) => { r.rosettes = [ros(12)]; r.slide.spiral = true; }))).toBe(false);
  });

  it('matches the toolpath: the reported axis is a mirror line', () => {
    const cases: Recipe[] = [
      base((r) => (r.rosettes = [ros(12, { profile: 'concave' }), ros(18, { phase: 10, amplitude: 0.4 })])),
      base((r) => {
        r.rosettes = [ros(24, { profile: 'triangle', amplitude: 0.5 }), ros(6, { axis: 'pump', amplitude: 0.05, phase: 30 })];
        r.slide = { ...r.slide, phaseMode: 'alternate', alternateEvery: 1, alternateFraction: 0.5 };
      }),
      base((r) => (r.rosettes = [ros(7, { phase: 11 })])),
      base((r) => { r.rosettes = [ros(12)]; r.elliptical = { enabled: true, e: 3, angle: 30 }; }),
      base((r) => { r.rosettes = [ros(12)]; r.eccentric = { enabled: true, offset: 5, angle: 15, divisions: 3, divisionStep: 0 }; }),
      base((r) => { r.rosettes = [ros(12, { amplitude: 0.5 })]; r.eccentric = { enabled: true, offset: 6, angle: 90, divisions: 4, divisionStep: 25 }; }),
    ];
    for (const r of cases) {
      const a = analyzeSymmetry(r);
      expect(a.mirror).toBe(true);
      const { dev, tol } = sampled(r);
      expect(dev(mirror(a.axis!)), `axis ${a.axis}`).toBeLessThan(tol);
      expect(dev(mirror(a.axis! + 1.3))).toBeGreaterThan(0.05);
    }
    // And the negative cases really are lopsided about every axis near the candidates.
    for (const r of [base((r) => (r.rosettes = [ros(12, { profile: 'flame' })])), base((r) => (r.rosettes = [ros(12), ros(18, { phase: 3 })]))]) {
      const { dev } = sampled(r);
      let best = Infinity;
      for (let k = 0; k < 360; k++) best = Math.min(best, dev(mirror(k / 2), 300));
      expect(best).toBeGreaterThan(0.05);
    }
  });

  it('presets: readout', () => {
    const got = Object.fromEntries(PRESETS.map((p) => [p.id, analyzeSymmetry(p.recipe)]));
    console.log(Object.entries(got).map(([id, a]) => `${id}: ${a.order}${a.mirror ? ` mirror@${a.axis}` : ''}`).join('; '));
    expect(got['sunray']).toEqual({ order: 72, mirror: true, axis: 90 });
    expect(got['rosace']).toEqual({ order: 12, mirror: true, axis: 90 });
    expect(got['nautilus']).toEqual({ order: 1, mirror: false });
    expect(got['flame'].mirror).toBe(false);
    expect(got['fine-barleycorn'].order).toBe(216);
  });
});

describe('peak on 12 o’clock', () => {
  it('peakAtTwelvePhase puts a rosette peak on the +Y work axis (engine convention)', () => {
    for (const L of [1, 2, 3, 5, 6, 7, 12, 18, 24, 216]) {
      const phase = peakAtTwelvePhase(L);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(360 / L);
      const r = base((r) => { r.slide.passes = 1; r.slide.startRadius = 30; r.rosettes = [ros(L, { phase, amplitude: 2 })]; });
      const p = prepare(r);
      // Work angle psi = -theta, so 12 o'clock (psi = 90°) is theta = -90° = 270°.
      const top = toolPoint(p, poseAt(p, 0, (3 * TAU) / 4));
      expect(top.x).toBeCloseTo(0, 9);
      expect(top.y).toBeCloseTo(32, 9);
      // ...and it is a maximum of the radius.
      for (const d of [-0.2, -0.05, 0.05, 0.2]) {
        const q = toolPoint(p, poseAt(p, 0, (3 * TAU) / 4 + d / L));
        expect(Math.hypot(q.x, q.y)).toBeLessThan(32);
      }
    }
    expect(peakAtTwelvePhase(12)).toBe(0);
    expect(peakAtTwelvePhase(18)).toBeCloseTo(10, 12);
    expect(peakAtTwelvePhase(7)).toBeCloseTo(90 / 7, 12);
  });

  it('a simple recipe with that phase is mirror-symmetric about the Y axis, sample for sample', () => {
    for (const L of [5, 7, 18]) {
      const r = base((r) => {
        r.rosettes = [ros(L, { phase: peakAtTwelvePhase(L) + 360 / L, profile: 'convex' }), ros(2 * L, { phase: peakAtTwelvePhase(2 * L), amplitude: 0.3 })];
        r.slide = { ...r.slide, phaseMode: 'alternate', alternateFraction: 0.5 };
        r.machine.rubberRadius = 1.5;
      });
      const tp = computeToolpath(prepare(r, { samplesPerRev: 4096 }));
      const spr = tp.samplesPerRev;
      for (const pass of tp.passes) {
        // (x, y) at theta_i mirrors to (-x, y) at theta = pi - theta_i, i.e. sample spr/2 - i.
        for (let i = 0; i < spr; i += 7) {
          const j = pass.start + ((((spr / 2 - i) % spr) + spr) % spr);
          expect(tp.x[j]).toBeCloseTo(-tp.x[pass.start + i], 4);
          expect(tp.y[j]).toBeCloseTo(tp.y[pass.start + i], 4);
        }
      }
      expect(analyzeSymmetry(r)).toMatchObject({ mirror: true, axis: 90 });
    }
  });
});

describe('enforceSymmetry', () => {
  it('is the identity when free, or when nothing changes', () => {
    const r = base((r) => (r.rosettes = [ros(18), ros(7, { profile: 'flame' })]));
    expect(enforceSymmetry(r)).toBe(r);
    expect(enforceSymmetry({ ...r, symmetry: { order: 1, mirror: false } })).toEqual({ ...r, symmetry: { order: 1, mirror: false } });
    const ok = { ...base((r) => (r.rosettes = [ros(24), ros(12)])), symmetry: { order: 12, mirror: true } };
    expect(enforceSymmetry(ok)).toBe(ok);
    for (const p of PRESETS) expect(enforceSymmetry(p.recipe), p.id).toBe(p.recipe);
  });

  it('order N: lobes snap to multiples of N within 1..300', () => {
    const r = base((r) => {
      r.rosettes = [ros(7), ros(13), ros(2), ros(299), ros(5, { enabled: false })];
      r.symmetry = { order: 6, mirror: false };
    });
    const e = enforceSymmetry(r);
    expect(e).not.toBe(r);
    expect(e.rosettes.map((x) => x.lobes)).toEqual([6, 12, 6, 300, 5]);
    expect(r.rosettes.map((x) => x.lobes)).toEqual([7, 13, 2, 299, 5]); // input untouched
    const big = enforceSymmetry({ ...r, symmetry: { order: 96, mirror: false } });
    expect(big.rosettes.map((x) => x.lobes)).toEqual([96, 96, 96, 288, 5]);
  });

  it('order N with the eccentric chuck', () => {
    const mk = (offset: number, divisions: number, divisionStep: number, order: number) =>
      enforceSymmetry(base((r) => {
        r.rosettes = [ros(24)];
        r.eccentric = { enabled: true, offset, angle: 0, divisions, divisionStep };
        r.symmetry = { order, mirror: false };
      }));
    // Centred: divisions snap to the nearest divisor of N, evenly spaced.
    expect(mk(0, 5, 17, 12).eccentric).toMatchObject({ enabled: true, divisions: 6, divisionStep: 0 });
    expect(mk(0, 7, 0, 8).eccentric.divisions).toBe(8);
    // Off-centre: the copies carry the symmetry, so divisions become a multiple of N.
    expect(mk(5, 5, 0, 6).eccentric.divisions).toBe(6);
    expect(mk(5, 10, 0, 6).eccentric.divisions).toBe(12);
    expect(mk(5, 20, 0, 6).eccentric.divisions).toBe(18);
    // Off-centre and N above 36 divisions: no way to keep the chuck.
    expect(mk(5, 20, 0, 48).eccentric.enabled).toBe(false);
    // 360/D written out is left alone.
    const r = base((r) => { r.rosettes = [ros(24)]; r.eccentric = { enabled: true, offset: 5, angle: 0, divisions: 6, divisionStep: 60 }; r.symmetry = { order: 6, mirror: false }; });
    expect(enforceSymmetry(r)).toBe(r);
  });

  it('order N: spiral and ellipse without a dividing chuck, linear twist', () => {
    const spiral = enforceSymmetry(base((r) => { r.rosettes = [ros(12)]; r.slide.spiral = true; r.symmetry = { order: 4, mirror: false }; }));
    expect(spiral.slide.spiral).toBe(false);
    const multi = enforceSymmetry(base((r) => { r.rosettes = [ros(12)]; r.slide.spiral = true; r.eccentric = { enabled: true, offset: 0, angle: 0, divisions: 5, divisionStep: 0 }; r.symmetry = { order: 4, mirror: false }; }));
    expect(multi.slide.spiral).toBe(true);
    expect(multi.eccentric.divisions).toBe(4);
    expect(enforceSymmetry(base((r) => { r.rosettes = [ros(12)]; r.elliptical = { enabled: true, e: 3, angle: 0 }; r.symmetry = { order: 6, mirror: false }; })).elliptical.enabled).toBe(false);
    const two = base((r) => { r.rosettes = [ros(12)]; r.elliptical = { enabled: true, e: 3, angle: 0 }; r.symmetry = { order: 2, mirror: false }; });
    expect(enforceSymmetry(two)).toBe(two);
    // Total twist over 49 passes → whole 360/12 = 30° steps: 0.9°/pass × 48 = 43.2° → 30°.
    const tw = enforceSymmetry(base((r) => { r.rosettes = [ros(12)]; r.slide.passes = 49; r.slide.phaseStep = 0.9; r.symmetry = { order: 12, mirror: false }; }));
    expect(tw.slide.phaseStep * 48).toBeCloseTo(30, 9);
    const zero = base((r) => { r.rosettes = [ros(12)]; r.slide.passes = 49; r.symmetry = { order: 12, mirror: false }; });
    expect(enforceSymmetry(zero)).toBe(zero);
  });

  it('mirror: even profiles, no twist, peaks on 12 o’clock, chuck angles on the axis', () => {
    const r = base((r) => {
      r.rosettes = [ros(12, { profile: 'flame', phase: 4 }), ros(18, { profile: 'saw', phase: 100 }), ros(7, { profile: 'flame', enabled: false })];
      r.slide = { ...r.slide, phaseStep: 3, spiral: true };
      r.elliptical = { enabled: true, e: 2, angle: 50 };
      r.eccentric = { enabled: true, offset: 4, angle: 30, divisions: 3, divisionStep: 0 };
      r.symmetry = { order: 0, mirror: true };
    });
    const e = enforceSymmetry(r);
    expect(e.rosettes.map((x) => x.profile)).toEqual(['sine', 'triangle', 'flame']);
    expect(e.slide.phaseStep).toBe(0);
    expect(e.slide.spiral).toBe(false);
    expect(e.rosettes[0].phase).toBe(0);
    expect(e.rosettes[1].phase).toBeCloseTo(110, 9);
    expect(e.elliptical.angle).toBe(90);
    expect(e.eccentric.angle).toBe(90);
    expect(analyzeSymmetry(e)).toMatchObject({ mirror: true, axis: 90 });
    // Alternate keeps its mode and grouping; the offset snaps to a whole half lobe.
    const alt = enforceSymmetry(base((r) => { r.rosettes = [ros(12)]; r.slide = { ...r.slide, phaseMode: 'alternate', alternateEvery: 3, alternateFraction: 0.4 }; r.symmetry = { order: 0, mirror: true }; }));
    expect(alt.slide).toMatchObject({ phaseMode: 'alternate', alternateEvery: 3, alternateFraction: 0.5 });
    const custom = enforceSymmetry(base((r) => { r.rosettes = [ros(12), ros(24)]; r.slide.phaseMode = 'custom'; r.slide.phaseCustom = [0, 7, 22, -40]; r.symmetry = { order: 0, mirror: true }; }));
    expect(custom.slide.phaseCustom).toEqual([0, 0, 15, -45]); // multiples of 180 / gcd(12, 24) = 15°
    expect(mirrorOf(custom)).toBe(true);
  });

  it('is idempotent and always reaches the requested symmetry (random recipes)', () => {
    const orders = [0, 2, 3, 4, 5, 6, 7, 8, 12, 16, 24, 36, 48, 72, 96];
    let checked = 0;
    for (let seed = 1; seed <= 160; seed++) {
      const r0 = randomRecipe(seed, { ...defaultRecipe(), mode: seed % 2 ? 'metal' : 'ink' }, []);
      const N = orders[seed % orders.length];
      const m = seed % 3 !== 0;
      const r = { ...r0, symmetry: { order: N, mirror: m } };
      const e = enforceSymmetry(r);
      expect(enforceSymmetry(e), `seed ${seed}`).toBe(e);
      const a = analyzeSymmetry(e);
      if (N >= 2) {
        expect(a.order === Infinity || a.order % N === 0, `seed ${seed}: order ${a.order} for N ${N}`).toBe(true);
        for (const ro of e.rosettes) if (ro.enabled) expect(ro.lobes % N).toBe(0);
      }
      if (m) {
        expect(a.mirror, `seed ${seed}`).toBe(true);
        const D = e.eccentric.enabled ? e.eccentric.divisions : 1;
        const even = !e.eccentric.enabled || e.eccentric.divisionStep === 0 || Math.abs(e.eccentric.divisionStep - 360 / D) < 1e-9;
        if (even) expect(a.axis, `seed ${seed}`).toBe(90);
      }
      // Everything stays inside the param ranges.
      for (const def of PARAMS) {
        if (def.type !== 'number' && def.type !== 'int') continue;
        const v = getPath(e, def.key) as number;
        if (def.min !== undefined) expect(v, def.key).toBeGreaterThanOrEqual(def.min);
        if (def.max !== undefined) expect(v, def.key).toBeLessThanOrEqual(def.max);
      }
      for (const ro of e.rosettes)
        for (const def of ROSETTE_PARAMS) {
          const v = ro[def.key];
          if (typeof v !== 'number') continue;
          if (def.min !== undefined) expect(v).toBeGreaterThanOrEqual(def.min);
          if (def.max !== undefined) expect(v).toBeLessThanOrEqual(def.max);
        }
      // Numeric check on a sample of them: N-fold rotation, mirror about 12–6.
      if (seed % 8 === 0 && (N >= 2 || m)) {
        checked++;
        const { dev, tol } = sampled(e, 3);
        if (N >= 2) expect(dev(rotation(360 / N)), `seed ${seed} rotation`).toBeLessThan(tol);
        if (m) expect(dev(mirror(a.axis!)), `seed ${seed} mirror`).toBeLessThan(tol);
      }
    }
    expect(checked).toBeGreaterThan(10);
  }, 120_000);

  it('handles every chuck / spiral / phase-program combination (synthetic recipes)', () => {
    const orders = [2, 3, 4, 5, 6, 8, 9, 12, 24, 40, 72];
    const profiles = ['sine', 'convex', 'concave', 'flame', 'square', 'saw', 'triangle'] as const;
    let checked = 0;
    for (let seed = 1; seed <= 240; seed++) {
      const rnd = mulberry32(seed * 7919);
      const r = randomRecipe(seed, defaultRecipe(), []);
      r.slide.passes = 3 + Math.floor(rnd() * 40);
      r.rosettes = r.rosettes.slice(0, 3).map((ro) => ({ ...ro, profile: profiles[Math.floor(rnd() * profiles.length)], phase: Math.round(rnd() * 720) / 2 }));
      if (rnd() < 0.6) {
        r.eccentric = { enabled: true, offset: rnd() < 0.3 ? 0 : Math.round(rnd() * 150) / 10, angle: Math.round(rnd() * 360), divisions: 1 + Math.floor(rnd() * 36), divisionStep: rnd() < 0.5 ? 0 : Math.round(rnd() * 360) / 2 };
      }
      if (rnd() < 0.4) r.elliptical = { enabled: true, e: Math.round(rnd() * 80) / 10, angle: Math.round(rnd() * 180) };
      r.slide.spiral = rnd() < 0.3;
      r.slide.phaseMode = (['linear', 'alternate', 'custom'] as const)[Math.floor(rnd() * 3)];
      r.slide.phaseStep = rnd() < 0.3 ? 0 : Math.round((rnd() * 20 - 10) * 10) / 10;
      r.slide.alternateFraction = Math.round(rnd() * 100) / 100;
      r.slide.phaseCustom = [0, Math.round(rnd() * 90), Math.round(rnd() * 90)];
      const N = seed % 4 === 0 ? 0 : orders[seed % orders.length];
      const m = seed % 3 !== 1;
      r.symmetry = { order: N, mirror: m };
      if (seed % 5 === 0) {
        // The raw recipe's readout holds on its toolpath too.
        const raw = analyzeSymmetry(r);
        const { dev, tol } = sampled(r, 3);
        if (raw.order > 1 && Number.isFinite(raw.order)) expect(dev(rotation(360 / raw.order)), `seed ${seed} raw order ${raw.order}`).toBeLessThan(tol);
        if (raw.mirror) expect(dev(mirror(raw.axis!)), `seed ${seed} raw mirror`).toBeLessThan(tol);
      }
      const e = enforceSymmetry(r);
      expect(enforceSymmetry(e), `seed ${seed} idempotent`).toBe(e);
      const a = analyzeSymmetry(e);
      if (N >= 2) expect(a.order === Infinity || a.order % N === 0, `seed ${seed}: order ${a.order} for N ${N}`).toBe(true);
      if (m) expect(a.mirror, `seed ${seed} mirror`).toBe(true);
      if (seed % 6 === 0) {
        checked++;
        const { dev, tol } = sampled(e, 3);
        if (N >= 2 && Number.isFinite(a.order)) expect(dev(rotation(360 / N)), `seed ${seed} rotation`).toBeLessThan(tol);
        if (m) expect(dev(mirror(a.axis!)), `seed ${seed} mirror`).toBeLessThan(tol);
        if (a.order > 1 && Number.isFinite(a.order)) expect(dev(rotation(360 / a.order)), `seed ${seed} claimed order`).toBeLessThan(tol);
      }
    }
    expect(checked).toBeGreaterThan(30);
  }, 120_000);
});
