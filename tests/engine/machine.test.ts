import { describe, expect, it } from 'vitest';
import { defaultRecipe, defaultRosette, type Recipe, type ProfileKind } from '../../src/state/recipe';
import {
  computeToolpath,
  poseAt,
  poseAtSample,
  prepare,
  toolPoint,
  workPlacement,
  profileValue,
  MAX_TOTAL_SAMPLES,
  MIN_SAMPLES_PER_REV,
} from '../../src/engine';

const TAU = Math.PI * 2;
const PROFILES: ProfileKind[] = ['sine', 'convex', 'concave', 'flame', 'square', 'saw'];

function single(partial: (r: Recipe) => void = () => {}): Recipe {
  const r = defaultRecipe();
  r.slide.passes = 1;
  r.slide.startRadius = 30;
  r.slide.endRadius = 30;
  r.slide.phaseMode = 'linear';
  r.slide.phaseStep = 0;
  r.machine.rubberRadius = 0;
  partial(r);
  return r;
}

function rot(x: number, y: number, a: number) {
  return { x: Math.cos(a) * x - Math.sin(a) * y, y: Math.sin(a) * x + Math.cos(a) * y };
}

describe('rosette symmetry', () => {
  for (const profile of PROFILES) {
    for (const rubber of [0, 3]) {
      it(`${profile}, rubber ${rubber}: n-lobe rosette gives n-fold symmetry`, () => {
        const n = 7;
        const r = single((r) => {
          r.rosettes = [defaultRosette({ lobes: n, amplitude: 2, profile, phase: 11 })];
          r.machine.rubberRadius = rubber;
        });
        const p = prepare(r);
        for (let k = 0; k < 40; k++) {
          const th = (k / 40) * TAU + 0.0123;
          const a = toolPoint(p, poseAt(p, 0, th));
          const b = toolPoint(p, poseAt(p, 0, th + TAU / n));
          // Turning the spindle one more lobe moves the tool by -2pi/n in the work frame.
          const ar = rot(a.x, a.y, -TAU / n);
          expect(b.x).toBeCloseTo(ar.x, 6);
          expect(b.y).toBeCloseTo(ar.y, 6);
        }
      });
    }
  }

  it('n-fold symmetry holds on the sampled toolpath', () => {
    const n = 8; // spr = 1024, divisible by 8
    const r = single((r) => (r.rosettes = [defaultRosette({ lobes: n, amplitude: 2, profile: 'flame' })]));
    const tp = computeToolpath(prepare(r));
    const shift = tp.samplesPerRev / n;
    for (let i = 0; i < tp.samplesPerRev - shift; i += 17) {
      const ar = rot(tp.x[i], tp.y[i], -TAU / n);
      expect(tp.x[i + shift]).toBeCloseTo(ar.x, 4);
      expect(tp.y[i + shift]).toBeCloseTo(ar.y, 4);
    }
  });

  it('a phase shift of 360/n degrees is the identity', () => {
    for (const rubber of [0, 2.5]) {
      const n = 12;
      const mk = (phase: number) =>
        single((r) => {
          r.slide.passes = 5;
          r.slide.endRadius = 40;
          r.slide.phaseStep = 3;
          r.machine.rubberRadius = rubber;
          r.rosettes = [defaultRosette({ lobes: n, amplitude: 1.5, profile: 'concave', phase })];
        });
      const a = computeToolpath(prepare(mk(5)));
      const b = computeToolpath(prepare(mk(5 + 360 / n)));
      expect(b.totalSamples).toBe(a.totalSamples);
      for (let i = 0; i < a.totalSamples; i += 13) {
        expect(b.x[i]).toBeCloseTo(a.x[i], 4);
        expect(b.y[i]).toBeCloseTo(a.y[i], 4);
      }
    }
  });

  it('pattern is an upright copy of the rosette (rosetteRadiusAt convention)', () => {
    const r = single((r) => (r.rosettes = [defaultRosette({ lobes: 5, amplitude: 2, profile: 'flame', phase: 20 })]));
    const p = prepare(r);
    for (let k = 0; k < 20; k++) {
      const th = (k / 20) * TAU;
      const pose = poseAt(p, 0, th);
      const phi = -th;
      const u = (5 * phi) / TAU + (20 / 360) * 5;
      expect(pose.rock).toBeCloseTo(2 * profileValue('flame', u), 9);
      const pt = toolPoint(p, pose);
      expect(Math.atan2(pt.y, pt.x)).toBeCloseTo(Math.atan2(Math.sin(phi), Math.cos(phi)), 9);
    }
  });
});

describe('chucks', () => {
  const base = () =>
    single((r) => {
      r.slide.passes = 4;
      r.slide.endRadius = 40;
      r.rosettes = [defaultRosette({ lobes: 9, amplitude: 1.5 })];
    });

  it('eccentric offset 0 with 1 division is the identity', () => {
    const a = computeToolpath(prepare(base()));
    for (const step of [0, 37]) {
      const r = base();
      r.eccentric = { enabled: true, offset: 0, angle: 63, divisions: 1, divisionStep: step };
      const b = computeToolpath(prepare(r));
      expect(b.totalSamples).toBe(a.totalSamples);
      for (let i = 0; i < a.totalSamples; i += 7) {
        expect(b.x[i]).toBeCloseTo(a.x[i], 5);
        expect(b.y[i]).toBeCloseTo(a.y[i], 5);
      }
    }
  });

  it('eccentric divisions: division-major order, copies rotated about the work centre', () => {
    const r = base();
    r.eccentric = { enabled: true, offset: 10, angle: 30, divisions: 6, divisionStep: 0 };
    const tp = computeToolpath(prepare(r));
    expect(tp.passes.length).toBe(4 * 6);
    tp.passes.forEach((p, i) => {
      expect(p.index).toBe(i);
      expect(p.division).toBe(Math.floor(i / 4));
      expect(p.slidePass).toBe(i % 4);
    });
    // Division d is division 0 rotated by -d*60deg about the work centre.
    const p0 = tp.passes[1];
    const p2 = tp.passes[2 * 4 + 1];
    for (let i = 0; i < p0.count; i += 31) {
      const q = rot(tp.x[p0.start + i], tp.y[p0.start + i], -2 * (TAU / 6));
      expect(tp.x[p2.start + i]).toBeCloseTo(q.x, 4);
      expect(tp.y[p2.start + i]).toBeCloseTo(q.y, 4);
    }
    // Pattern centre (spindle axis) of division 0 sits at -offset in direction angle.
    const plain = single((r) => (r.rosettes = []));
    plain.eccentric = { enabled: true, offset: 10, angle: 30, divisions: 1, divisionStep: 0 };
    const c = computeToolpath(prepare(plain));
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < c.totalSamples; i++) {
      cx += c.x[i];
      cy += c.y[i];
    }
    expect(cx / c.totalSamples).toBeCloseTo(-10 * Math.cos(Math.PI / 6), 4);
    expect(cy / c.totalSamples).toBeCloseTo(-10 * Math.sin(Math.PI / 6), 4);
  });

  it('elliptical e = 0 gives a circle (and matches the chuck disabled)', () => {
    const r = single((r) => (r.rosettes = []));
    r.elliptical = { enabled: true, e: 0, angle: 40 };
    const tp = computeToolpath(prepare(r));
    for (let i = 0; i < tp.totalSamples; i++) expect(Math.hypot(tp.x[i], tp.y[i])).toBeCloseTo(30, 4);
    const a = computeToolpath(prepare(base()));
    const rb = base();
    rb.elliptical = { enabled: true, e: 0, angle: 40 };
    const b = computeToolpath(prepare(rb));
    for (let i = 0; i < a.totalSamples; i += 11) {
      expect(b.x[i]).toBeCloseTo(a.x[i], 5);
      expect(b.y[i]).toBeCloseTo(a.y[i], 5);
    }
  });

  it('elliptical e > 0 maps a circle of radius R to an ellipse R+e by R-e at angle', () => {
    const r = single((r) => (r.rosettes = []));
    const e = 6;
    const ang = (25 * Math.PI) / 180;
    r.elliptical = { enabled: true, e, angle: 25 };
    const tp = computeToolpath(prepare(r));
    let maxR = 0;
    let minR = Infinity;
    for (let i = 0; i < tp.totalSamples; i++) {
      const q = rot(tp.x[i], tp.y[i], -ang);
      const v = (q.x / (30 + e)) ** 2 + (q.y / (30 - e)) ** 2;
      expect(v).toBeCloseTo(1, 4);
      const h = Math.hypot(tp.x[i], tp.y[i]);
      maxR = Math.max(maxR, h);
      minR = Math.min(minR, h);
    }
    expect(maxR).toBeCloseTo(36, 3);
    expect(minR).toBeCloseTo(24, 3);
  });

  it('workPlacement maps the tool point back to (slideRadius + rock, 0)', () => {
    const r = base();
    r.eccentric = { enabled: true, offset: 7, angle: 50, divisions: 5, divisionStep: 20 };
    r.elliptical = { enabled: true, e: 4, angle: 70 };
    const p = prepare(r);
    for (const [pass, th] of [[0, 0.3], [7, 2.1], [19, 5.9]] as const) {
      const pose = poseAt(p, pass, th);
      const t = toolPoint(p, pose);
      const w = workPlacement(p, pose);
      const mx = Math.cos(w.rotation) * t.x - Math.sin(w.rotation) * t.y + w.x;
      const my = Math.sin(w.rotation) * t.x + Math.cos(w.rotation) * t.y + w.y;
      expect(mx).toBeCloseTo(pose.slideRadius + pose.rock, 9);
      expect(my).toBeCloseTo(0, 9);
    }
  });
});

describe('rubber follower', () => {
  it('rubber radius 0 equals the raw profile x amplitude', () => {
    for (const profile of PROFILES) {
      const r = single((r) => (r.rosettes = [defaultRosette({ lobes: 6, amplitude: 1.7, profile, phase: 33 })]));
      const p = prepare(r);
      for (let k = 0; k < 50; k++) {
        const th = (k / 50) * TAU + 0.01;
        const u = (6 * -th) / TAU + (33 / 360) * 6;
        expect(poseAt(p, 0, th).rock).toBeCloseTo(1.7 * profileValue(profile, u), 9);
      }
    }
  });

  it('a tiny rubber is close to the raw profile', () => {
    const r = single((r) => {
      r.rosettes = [defaultRosette({ lobes: 12, amplitude: 1.2, profile: 'sine' })];
      r.machine.rubberRadius = 0.01;
    });
    const p = prepare(r);
    for (let k = 0; k < 50; k++) {
      const th = (k / 50) * TAU;
      expect(Math.abs(poseAt(p, 0, th).rock - 1.2 * Math.cos(12 * -th))).toBeLessThan(0.01);
    }
  });

  it('a larger rubber reduces the peak-to-valley of concave cusps', () => {
    const stats = (rubber: number) => {
      const r = single((r) => {
        r.rosettes = [defaultRosette({ lobes: 72, amplitude: 2, profile: 'concave' })];
        r.machine.rubberRadius = rubber;
      });
      const p = prepare(r);
      let lo = Infinity;
      let hi = -Infinity;
      let mean = 0;
      const n = 20000;
      for (let k = 0; k < n; k++) {
        const v = poseAt(p, 0, (k / n) * TAU).rock;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
        mean += v / n;
      }
      return { lo, hi, ptv: hi - lo, mean };
    };
    const s = [0, 1, 3, 6, 12].map(stats);
    console.log('concave 72 lobes, A=2: ptv by rubber [0,1,3,6,12] =', s.map((x) => x.ptv.toFixed(3)).join(', '));
    expect(s[0].ptv).toBeCloseTo(4, 2);
    for (let i = 1; i < s.length; i++) {
      expect(s[i].ptv).toBeLessThanOrEqual(s[i - 1].ptv + 1e-6);
      // The roller rides higher on the scooped flanks as it grows.
      expect(s[i].mean).toBeGreaterThan(s[i - 1].mean);
    }
    expect(s[3].ptv).toBeLessThan(s[0].ptv - 0.5);
    expect(s[4].ptv).toBeLessThan(s[3].ptv - 0.1);
    // The roller still sits on the cusp tips: peaks are unchanged.
    for (const x of s) expect(x.hi).toBeCloseTo(2, 2);
  });

  it('a rubber never makes the follower dip below the raw profile', () => {
    const r = single((r) => {
      r.rosettes = [defaultRosette({ lobes: 10, amplitude: 2, profile: 'convex' })];
      r.machine.rubberRadius = 5;
    });
    const p = prepare(r);
    for (let k = 0; k < 500; k++) {
      const th = (k / 500) * TAU;
      const raw = 2 * profileValue('convex', (10 * -th) / TAU);
      expect(poseAt(p, 0, th).rock).toBeGreaterThanOrEqual(raw - 1e-3);
    }
  });
});

describe('slide program', () => {
  it('radius, taper and alternate phase per pass', () => {
    const r = defaultRecipe();
    r.machine.rubberRadius = 0;
    r.slide = { ...r.slide, passes: 5, startRadius: 10, endRadius: 30, amplitudeTaper: 0.5, phaseMode: 'alternate', alternateEvery: 2, alternateFraction: 0.5 };
    r.rosettes = [defaultRosette({ lobes: 4, amplitude: 2, profile: 'sine' })];
    const p = prepare(r);
    const radii = [0, 1, 2, 3, 4].map((k) => poseAt(p, k, 0).slideRadius);
    expect(radii).toEqual([10, 15, 20, 25, 30]);
    // Pass groups: [0,1] even, [2,3] odd (half lobe -> peak becomes valley), [4] even. Taper 1 -> 0.5.
    const rocks = [0, 1, 2, 3, 4].map((k) => poseAt(p, k, 0).rock);
    const taper = [1, 0.875, 0.75, 0.625, 0.5];
    const sign = [1, 1, -1, -1, 1];
    rocks.forEach((v, k) => expect(v).toBeCloseTo(2 * taper[k] * sign[k], 9));
  });

  it('linear and custom phase programs', () => {
    const r = single((r) => {
      r.slide.passes = 4;
      r.rosettes = [defaultRosette({ lobes: 6, amplitude: 1, profile: 'sine' })];
    });
    r.slide.phaseStep = 10;
    let p = prepare(r);
    for (let k = 0; k < 4; k++) {
      // u = 6*(10k)/360 -> rock = cos(2pi*u)
      expect(poseAt(p, k, 0).rock).toBeCloseTo(Math.cos((TAU * 6 * 10 * k) / 360), 9);
    }
    r.slide.phaseMode = 'custom';
    r.slide.phaseCustom = [0, 15];
    p = prepare(r);
    expect(poseAt(p, 0, 0).rock).toBeCloseTo(1, 9);
    expect(poseAt(p, 1, 0).rock).toBeCloseTo(Math.cos((TAU * 6 * 15) / 360), 9);
    expect(poseAt(p, 2, 0).rock).toBeCloseTo(1, 9);
    r.slide.phaseCustom = [];
    p = prepare(r);
    expect(poseAt(p, 3, 0).rock).toBeCloseTo(1, 9);
  });

  it('pump rosettes feed z, rock rosettes sum, disabled rosettes are ignored', () => {
    const r = single((r) => {
      r.rosettes = [
        defaultRosette({ lobes: 3, amplitude: 1, axis: 'rock' }),
        defaultRosette({ lobes: 5, amplitude: 0.5, axis: 'rock' }),
        defaultRosette({ lobes: 7, amplitude: 9, axis: 'rock', enabled: false }),
        defaultRosette({ lobes: 4, amplitude: 0.2, axis: 'pump' }),
      ];
    });
    const p = prepare(r);
    const th = 0.7;
    const pose = poseAt(p, 0, th);
    expect(pose.rock).toBeCloseTo(Math.cos(3 * -th) + 0.5 * Math.cos(5 * -th), 9);
    expect(pose.pump).toBeCloseTo(0.2 * Math.cos(4 * -th), 9);
    const tp = computeToolpath(p);
    expect(tp.zMax).toBeCloseTo(0.2, 3);
    expect(tp.zMin).toBeCloseTo(-0.2, 3);
    expect(toolPoint(p, pose).z).toBe(pose.pump);
  });
});

describe('toolpath', () => {
  const combos: [string, (r: Recipe) => void][] = [
    ['default', () => {}],
    ['eccentric+elliptical', (r) => {
      r.eccentric = { enabled: true, offset: 8, angle: 20, divisions: 3, divisionStep: 0 };
      r.elliptical = { enabled: true, e: 3, angle: 15 };
      r.slide.passes = 6;
    }],
    ['spiral', (r) => {
      r.slide.spiral = true;
      r.slide.passes = 6;
      r.slide.phaseMode = 'alternate';
      r.eccentric = { enabled: true, offset: 5, angle: 0, divisions: 2, divisionStep: 0 };
    }],
  ];

  for (const [name, mod] of combos) {
    it(`${name}: toolPoint(poseAtSample(s)) equals toolpath samples`, () => {
      const r = defaultRecipe();
      r.rosettes.push(defaultRosette({ lobes: 5, amplitude: 0.3, axis: 'pump' }));
      mod(r);
      const p = prepare(r);
      const tp = computeToolpath(p);
      for (let s = 0; s < tp.totalSamples; s += 997) {
        const pose = poseAtSample(p, tp, s);
        const pt = toolPoint(p, pose);
        expect(pt.x).toBeCloseTo(tp.x[s], 4);
        expect(pt.y).toBeCloseTo(tp.y[s], 4);
        expect(pt.z).toBeCloseTo(tp.z[s], 5);
        expect(pose.spindleAngle).toBeCloseTo(tp.theta[s], 1);
      }
      const last = tp.totalSamples - 1;
      const pl = toolPoint(p, poseAtSample(p, tp, last));
      expect(pl.x).toBeCloseTo(tp.x[last], 4);
    });
  }

  it('poseAtSample clamps and interpolates float samples', () => {
    const r = defaultRecipe();
    r.slide.passes = 3;
    const p = prepare(r);
    const tp = computeToolpath(p);
    const a = toolPoint(p, poseAtSample(p, tp, -5));
    expect(a.x).toBeCloseTo(tp.x[0], 4);
    const b = toolPoint(p, poseAtSample(p, tp, 1e9));
    expect(b.x).toBeCloseTo(tp.x[tp.totalSamples - 1], 4);
    const m = toolPoint(p, poseAtSample(p, tp, 100.5));
    expect(m.x).toBeCloseTo((tp.x[100] + tp.x[101]) / 2, 2);
    expect(m.y).toBeCloseTo((tp.y[100] + tp.y[101]) / 2, 2);
    // The closing segment of pass 0 heads back to its first point.
    const s = tp.passes[0].count - 1 + 0.999999;
    const c = toolPoint(p, poseAtSample(p, tp, s));
    expect(c.x).toBeCloseTo(tp.x[0], 3);
    expect(c.y).toBeCloseTo(tp.y[0], 3);
  });

  it('closed passes close and do not repeat the first point', () => {
    const r = defaultRecipe();
    r.machine.rubberRadius = 3;
    const tp = computeToolpath(prepare(r));
    for (const pass of tp.passes) {
      expect(pass.closed).toBe(true);
      expect(pass.count).toBe(tp.samplesPerRev);
      let maxSeg = 0;
      for (let i = pass.start + 1; i < pass.start + pass.count; i++) {
        maxSeg = Math.max(maxSeg, Math.hypot(tp.x[i] - tp.x[i - 1], tp.y[i] - tp.y[i - 1]));
      }
      const end = pass.start + pass.count - 1;
      const gap = Math.hypot(tp.x[end] - tp.x[pass.start], tp.y[end] - tp.y[pass.start]);
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThanOrEqual(maxSeg * 1.0001 + 1e-6);
    }
  });

  it('spiral: one open stroke per division with theta 0..2pi*passes', () => {
    const r = defaultRecipe();
    r.slide.spiral = true;
    r.slide.startRadius = 8;
    r.slide.passes = 10;
    r.slide.phaseMode = 'linear';
    r.slide.phaseStep = 2;
    r.eccentric = { enabled: true, offset: 6, angle: 0, divisions: 3, divisionStep: 0 };
    const p = prepare(r);
    const tp = computeToolpath(p);
    expect(tp.passes.length).toBe(3);
    for (const pass of tp.passes) {
      expect(pass.closed).toBe(false);
      expect(pass.count).toBe(10 * tp.samplesPerRev + 1);
    }
    expect(poseAt(p, 0, 0).slideRadius).toBeCloseTo(8, 9);
    expect(poseAt(p, 0, TAU * 10).slideRadius).toBeCloseTo(46, 9);
    expect(poseAt(p, 1, TAU * 4.5).slidePass).toBe(4);
    expect(poseAt(p, 2, 0).spindleAngle).toBeCloseTo(TAU * 20, 9);
    // Continuity: no jumps between consecutive samples, including alternate phase steps.
    for (const mode of ['linear', 'alternate', 'custom'] as const) {
      r.slide.phaseMode = mode;
      r.slide.phaseCustom = [0, 7.5, 15];
      const t2 = computeToolpath(prepare(r));
      let maxSeg = 0;
      for (const pass of t2.passes)
        for (let i = pass.start + 1; i < pass.start + pass.count; i++)
          maxSeg = Math.max(maxSeg, Math.hypot(t2.x[i] - t2.x[i - 1], t2.y[i] - t2.y[i - 1]));
      expect(maxSeg).toBeLessThan(0.5);
    }
  });

  it('theta is cumulative and monotonic; bounds and length are filled', () => {
    const r = defaultRecipe();
    r.slide = { ...r.slide, startRadius: 8, endRadius: 46, passes: 40 };
    r.eccentric = { enabled: true, offset: 5, angle: 0, divisions: 2, divisionStep: 0 };
    const tp = computeToolpath(prepare(r));
    for (let i = 1; i < tp.totalSamples; i++) expect(tp.theta[i]).toBeGreaterThan(tp.theta[i - 1]);
    expect(tp.theta[tp.totalSamples - 1]).toBeCloseTo(TAU * 80 - TAU / tp.samplesPerRev, 1);
    let minX = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < tp.totalSamples; i++) {
      minX = Math.min(minX, tp.x[i]);
      maxY = Math.max(maxY, tp.y[i]);
    }
    expect(tp.bounds.minX).toBeCloseTo(minX, 5);
    expect(tp.bounds.maxY).toBeCloseTo(maxY, 5);
    // 80 roughly circular passes of mean radius ~27 mm (+ wiggles).
    expect(tp.totalLength).toBeGreaterThan(80 * TAU * 27);
    expect(tp.totalLength).toBeLessThan(80 * TAU * 27 * 2);
  });

  it('samples per rev follows lobes x 48 clamped to [1024, 8192]', () => {
    const spr = (lobes: number, passes = 10) => {
      const r = defaultRecipe();
      r.slide.passes = passes;
      r.rosettes = [defaultRosette({ lobes })];
      return computeToolpath(prepare(r)).samplesPerRev;
    };
    expect(spr(3)).toBe(1024);
    expect(spr(40)).toBe(1920);
    expect(spr(96)).toBe(4608);
    const r = defaultRecipe();
    r.rosettes = [defaultRosette({ lobes: 96 }), defaultRosette({ lobes: 200, enabled: false })];
    r.slide.passes = 1;
    expect(computeToolpath(prepare(r)).samplesPerRev).toBe(4608);
  });

  it('respects the total sample cap', () => {
    const r = defaultRecipe();
    r.slide.passes = 300;
    r.rosettes = [defaultRosette({ lobes: 96 })];
    r.eccentric = { enabled: true, offset: 10, angle: 0, divisions: 4, divisionStep: 0 };
    const tp = computeToolpath(prepare(r));
    expect(tp.totalSamples).toBeLessThanOrEqual(MAX_TOTAL_SAMPLES);
    expect(tp.totalSamples).toBeGreaterThan(MAX_TOTAL_SAMPLES * 0.95);
    expect(tp.samplesPerRev).toBeGreaterThanOrEqual(MIN_SAMPLES_PER_REV);
    expect(tp.x.length).toBe(tp.totalSamples);
    const sum = tp.passes.reduce((a, p) => a + p.count, 0);
    expect(sum).toBe(tp.totalSamples);
    r.slide.spiral = true;
    const ts = computeToolpath(prepare(r));
    expect(ts.totalSamples).toBeLessThanOrEqual(MAX_TOTAL_SAMPLES);
  });
});

describe('performance', () => {
  it('120 passes at 4096 samples/rev', () => {
    const r = defaultRecipe();
    r.slide.passes = 120;
    r.machine.rubberRadius = 2;
    r.rosettes = [defaultRosette({ lobes: 24, profile: 'concave' }), defaultRosette({ lobes: 8, amplitude: 0.1, axis: 'pump' })];
    r.elliptical = { enabled: true, e: 2, angle: 10 };
    const p = prepare(r, { samplesPerRev: 4096 });
    computeToolpath(p); // warm-up
    const runs: number[] = [];
    let tp = computeToolpath(p);
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      tp = computeToolpath(p);
      runs.push(performance.now() - t0);
    }
    const t0 = performance.now();
    prepare({ ...r, machine: { ...r.machine, rubberRadius: 2.37 } });
    const prepMs = performance.now() - t0;
    const best = Math.min(...runs);
    console.log(`computeToolpath ${tp.totalSamples} samples: best ${best.toFixed(1)} ms, runs ${runs.map((x) => x.toFixed(1)).join(', ')}; prepare (uncached rubber) ${prepMs.toFixed(1)} ms`);
    expect(tp.samplesPerRev).toBe(4096);
    expect(best).toBeLessThan(250);
  });
});
