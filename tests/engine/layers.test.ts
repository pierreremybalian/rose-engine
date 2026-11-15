import { describe, expect, it } from 'vitest';
import { defaultRecipe, defaultRosette, layerFromBase, type Recipe } from '../../src/state/recipe';
import { computeToolpath, prepare, prepareCut, poseAtSample, toolPoint, workPlacement, maskWeightAt, layerRecipe, cutNumbers, profileValue } from '../../src/engine';
import { buildGcode } from '../../src/export/gcode';
import { DEFAULT_GCODE_OPTIONS } from '../../src/export/types';
import { parsePreset, serializePreset } from '../../src/export/preset';

const TAU = Math.PI * 2;

function base(edit: (r: Recipe) => void = () => {}): Recipe {
  const r = defaultRecipe();
  r.mode = 'metal';
  r.machine.rubberRadius = 0;
  r.rosettes = [defaultRosette({ id: 'a', lobes: 12, amplitude: 0.6 })];
  r.slide = { ...r.slide, passes: 6, startRadius: 5, endRadius: 30 };
  edit(r);
  return r;
}

describe('layers', () => {
  it('a recipe without enabled layers is the single-cut engine, unchanged', () => {
    const r = base((x) => (x.layers = [{ ...layerFromBase(x, 0.05), enabled: false }]));
    const a = computeToolpath(prepare(r));
    const b = computeToolpath(prepareCut(r));
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect(a.passes.every((p) => p.cut === undefined)).toBe(true);
  });

  it('cuts are joined in order with global indices, continuous samples and theta, and per-cut depth folded into z', () => {
    const r = base((x) => {
      const l = layerFromBase(x, 0.03);
      l.rosettes = [defaultRosette({ id: 'b', lobes: 5, amplitude: 1, profile: 'triangle' })];
      l.slide = { ...l.slide, passes: 4, startRadius: 8, endRadius: 20 };
      x.layers = [l];
    });
    expect(cutNumbers(r)).toEqual([0, 1]);
    const tp = computeToolpath(prepare(r));
    const t0 = computeToolpath(prepareCut(layerRecipe(r, 0), { samplesPerRev: tp.samplesPerRev, maxSamples: Infinity }));
    const t1 = computeToolpath(prepareCut(layerRecipe(r, 1), { samplesPerRev: tp.samplesPerRev, maxSamples: Infinity }));
    expect(tp.passes).toHaveLength(t0.passes.length + t1.passes.length);
    tp.passes.forEach((p, i) => expect(p.index).toBe(i));
    expect(tp.passes.map((p) => p.cut)).toEqual([...t0.passes.map(() => 0), ...t1.passes.map(() => 1)]);
    expect(tp.totalSamples).toBe(t0.totalSamples + t1.totalSamples);
    for (let i = 1; i < tp.totalSamples; i++) expect(tp.theta[i]).toBeGreaterThanOrEqual(tp.theta[i - 1]);
    const o = t0.totalSamples;
    expect(tp.x[o + 7]).toBeCloseTo(t1.x[7], 5);
    // metal: depth = baseDepth + z is the cut's own depth
    expect(r.metal.baseDepth + tp.z[o + 7]).toBeCloseTo(0.03 + t1.z[7], 6);
    expect(r.metal.baseDepth + tp.z[3]).toBeCloseTo(r.metal.baseDepth + t0.z[3], 6);
    // G-code cuts each cut at its own depth
    const g = buildGcode(r, tp, { ...DEFAULT_GCODE_OPTIONS, profile: 'cnc' });
    const zs = new Set([...g.text.matchAll(/Z(-[\d.]+)/g)].map((m) => Number(m[1]).toFixed(3)));
    expect(zs.has((-r.metal.baseDepth).toFixed(3))).toBe(true);
    expect(zs.has((-0.03).toFixed(3))).toBe(true);
  });

  it('ink: z is left alone', () => {
    const r = base((x) => { x.mode = 'ink'; x.layers = [layerFromBase(x, 0.3)]; });
    const tp = computeToolpath(prepare(r));
    expect(tp.zMax).toBe(0);
  });

  it('poses, tool points and placement agree with the joined samples across the cut boundary', () => {
    const r = base((x) => {
      const l = layerFromBase(x, 0.02);
      l.straight = { enabled: true, angle: 30, crossings: 2, crossAngle: 0 };
      x.layers = [l];
    });
    const p = prepare(r);
    const tp = computeToolpath(p);
    const boundary = tp.passes.find((q) => q.cut === 1)!.start;
    for (const s of [0, boundary - 1, boundary, boundary + 5, tp.totalSamples - 1]) {
      const pose = poseAtSample(p, tp, s);
      expect(pose.cut).toBe(s >= boundary ? 1 : 0);
      const pt = toolPoint(p, pose);
      expect(pt.x).toBeCloseTo(tp.x[s], 3);
      expect(pt.y).toBeCloseTo(tp.y[s], 3);
      expect(pt.z).toBeCloseTo(tp.z[s], 5);
      const w = workPlacement(p, pose);
      expect(Math.cos(w.rotation) * pt.x - Math.sin(w.rotation) * pt.y + w.x).toBeCloseTo(pose.slideRadius + pose.rock, 5);
    }
  });

  it('round-trips through preset JSON (layers, mask, lobesEnd)', () => {
    const r = base((x) => {
      x.rosettes[0].lobesEnd = 24;
      x.mask = { ...x.mask, enabled: true, depth: 0.05 };
      x.layers = [layerFromBase(x, 0.04)];
    });
    expect(parsePreset(serializePreset(r))).toEqual(r);
  });
});

describe('shape mask', () => {
  const star = { radius: 10, lobes: 5, amplitude: 4, profile: 'triangle' as const, angle: Math.PI / 2, edge: 0.5 };
  it('is 1 inside, 0 outside, smooth across the edge', () => {
    expect(maskWeightAt(star, 0, 0)).toBe(1);
    expect(maskWeightAt(star, 0, 13.5)).toBe(1); // point at 12 o'clock reaches 14
    expect(maskWeightAt(star, 0, 14.5)).toBe(0);
    expect(maskWeightAt(star, 0, 14)).toBeCloseTo(0.5, 6);
    expect(maskWeightAt(star, 30, 0)).toBe(0);
  });

  it('adds depth and phase inside the shape only; disengaged it changes nothing', () => {
    const plain = base((x) => (x.slide = { ...x.slide, passes: 3, startRadius: 4, endRadius: 24 }));
    const masked = base((x) => {
      x.slide = { ...x.slide, passes: 3, startRadius: 4, endRadius: 24 };
      x.mask = { enabled: true, radius: 10, lobes: 1, amplitude: 0, profile: 'sine', angle: 0, edge: 0.01, depth: 0.05, phase: 0.5 };
    });
    const a = computeToolpath(prepare(plain));
    const b = computeToolpath(prepare(masked));
    const spr = a.samplesPerRev;
    // pass 0 (r = 4) is inside: half a lobe on, 0.05 deeper; pass 2 (r = 24) is outside: unchanged
    for (const i of [0, 100, 500]) {
      const th = (i * TAU) / spr;
      const u = (-12 * th) / TAU;
      expect(Math.hypot(b.x[i], b.y[i])).toBeCloseTo(4 + 0.6 * profileValue('sine', u + 0.5), 4);
      expect(b.z[i]).toBeCloseTo(0.05, 6);
      expect(b.x[2 * spr + i]).toBeCloseTo(a.x[2 * spr + i], 5);
      expect(b.z[2 * spr + i]).toBe(0);
    }
    const off = base((x) => (x.mask = { ...x.mask, enabled: false, depth: 1, phase: 0.5 }));
    expect(Array.from(computeToolpath(prepare(off)).x)).toEqual(Array.from(computeToolpath(prepare(base())).x));
  });
});

describe('lobe morph', () => {
  it('steps the lobe count per pass from lobes to lobesEnd; every ring closes', () => {
    const r = base((x) => {
      x.rosettes = [defaultRosette({ id: 'a', lobes: 12, lobesEnd: 48, amplitude: 1, profile: 'sine' })];
      x.slide = { ...x.slide, passes: 4, startRadius: 10, endRadius: 30 };
    });
    const tp = computeToolpath(prepare(r));
    const counts = tp.passes.map((p) => {
      // count local maxima of the radius around the ring
      const rad = (k: number) => Math.hypot(tp.x[p.start + ((k + p.count) % p.count)], tp.y[p.start + ((k + p.count) % p.count)]);
      let n = 0;
      for (let k = 0; k < p.count; k++) if (rad(k) > rad(k - 1) && rad(k) >= rad(k + 1)) n++;
      return n;
    });
    expect(counts).toEqual([12, 24, 36, 48]);
  });
});
