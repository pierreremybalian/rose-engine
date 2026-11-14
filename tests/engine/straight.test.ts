import { describe, expect, it } from 'vitest';
import { defaultRecipe, defaultRosette, type Recipe } from '../../src/state/recipe';
import { computeToolpath, poseAt, poseAtSample, prepare, rosettePhaseDeg, toolPoint, workPlacement, profileValue } from '../../src/engine';
import { effectiveEndRadius, plateRadius, straightHalfLength } from '../../src/engine/plate';
import { analyzeSymmetry, enforceSymmetry } from '../../src/engine/symmetry';
import { PRESETS } from '../../src/presets';
import { grooveCoverage, passSpacing, randomRecipe, mutateRecipe } from '../../src/engine/random';
import { buildSVG } from '../../src/export/svg';
import { buildGcode } from '../../src/export/gcode';
import { DEFAULT_GCODE_OPTIONS as GCODE_OPTS, DEFAULT_SVG_OPTIONS as SVG_OPTS } from '../../src/export/types';
import { parsePreset, serializePreset } from '../../src/export/preset';

const TAU = Math.PI * 2;

function straight(edit: (r: Recipe) => void = () => {}): Recipe {
  const r = defaultRecipe();
  r.straight = { enabled: true, angle: 0, crossings: 1, crossAngle: 0 };
  r.rosettes = [];
  r.machine.rubberRadius = 0;
  r.slide = { ...r.slide, passes: 11, startRadius: 7, endRadius: 40, phaseMode: 'linear', phaseStep: 0, spiral: true };
  r.eccentric = { enabled: true, offset: 12, angle: 30, divisions: 5, divisionStep: 0 };
  r.elliptical = { enabled: true, e: 4, angle: 10 };
  edit(r);
  return r;
}

describe('straight-line engine', () => {
  it('cuts open parallel lines from -end to +end; start radius, spiral and the chucks are not used', () => {
    const r = straight();
    const tp = computeToolpath(prepare(r));
    expect(tp.passes).toHaveLength(11);
    const L = straightHalfLength(r);
    tp.passes.forEach((p, k) => {
      expect(p.closed).toBe(false);
      const y = -40 + 8 * k;
      for (let i = p.start; i < p.start + p.count; i++) expect(tp.y[i]).toBeCloseTo(y, 4);
      expect(tp.x[p.start]).toBeCloseTo(-L, 4);
      expect(tp.x[p.start + p.count - 1]).toBeCloseTo(L, 4);
    });
    // The sample clock stays monotonic across strokes.
    for (let i = 1; i < tp.totalSamples; i++) expect(tp.theta[i]).toBeGreaterThanOrEqual(tp.theta[i - 1]);
    expect(tp.totalLength).toBeCloseTo(11 * 2 * L, 1);
  });

  it('line angle turns the lines; crossings repeat the program at evenly spaced angles (or crossAngle)', () => {
    const dirOf = (r: Recipe, stroke: number) => {
      const tp = computeToolpath(prepare(r));
      const p = tp.passes[stroke];
      const a = p.start;
      const b = p.start + p.count - 1;
      return (Math.atan2(tp.y[b] - tp.y[a], tp.x[b] - tp.x[a]) * 180) / Math.PI;
    };
    expect(dirOf(straight((r) => (r.straight.angle = 30)), 0)).toBeCloseTo(30, 3);
    const two = straight((r) => Object.assign(r.straight, { angle: 45, crossings: 2 }));
    expect(computeToolpath(prepare(two)).passes).toHaveLength(22);
    expect(dirOf(two, 0)).toBeCloseTo(45, 3);
    expect(dirOf(two, 11)).toBeCloseTo(135, 3);
    const three = straight((r) => Object.assign(r.straight, { crossings: 3 }));
    expect(dirOf(three, 11)).toBeCloseTo(60, 3);
    expect(dirOf(three, 22)).toBeCloseTo(120, 3);
    const rhomb = straight((r) => Object.assign(r.straight, { crossings: 2, crossAngle: 70 }));
    expect(dirOf(rhomb, 11)).toBeCloseTo(70, 3);
  });

  it('rock rosettes are pattern bars: lobes = bumps across the plate diameter, phase program shifts along the line', () => {
    const r = straight((x) => {
      x.rosettes = [defaultRosette({ lobes: 10, amplitude: 1.5, profile: 'sine', phase: 0 })];
      x.slide = { ...x.slide, passes: 2, phaseMode: 'alternate', alternateEvery: 1, alternateFraction: 0.5 };
    });
    const p = prepare(r);
    const D = r.machine.workDiameter;
    for (const t of [-30, -7.5, 0, 12.25, 40]) {
      const theta = ((t + straightHalfLength(r)) / (2 * straightHalfLength(r))) * TAU;
      const a = poseAt(p, 0, theta);
      const b = poseAt(p, 1, theta);
      expect(a.travel).toBeCloseTo(t, 6);
      expect(a.rock).toBeCloseTo(1.5 * profileValue('sine', (10 * t) / D), 6);
      expect(b.rock).toBeCloseTo(1.5 * profileValue('sine', (10 * t) / D + 0.5), 6);
      const pt = toolPoint(p, a);
      expect(pt.x).toBeCloseTo(t, 6);
      expect(pt.y).toBeCloseTo(a.slideRadius + a.rock, 6);
      // The crank turns the rosettes one turn per plate diameter of travel; the 3D cam (spindle angle plus
      // rosettePhaseDeg) shows the bump being cut at the rubber, phi = -spindleAngle, as on the rose engine.
      expect(a.spindleAngle).toBeCloseTo((-TAU * t) / D, 9);
      const u = (10 * -a.spindleAngle) / TAU + (rosettePhaseDeg(p, 0, a) * 10) / 360;
      expect(1.5 * profileValue('sine', u)).toBeCloseTo(a.rock, 6);
    }
  });

  it('pose, sample and placement agree (2D machine frame and 3D model)', () => {
    const r = straight((x) => {
      x.rosettes = [defaultRosette({ lobes: 7, amplitude: 0.8, profile: 'convex' })];
      Object.assign(x.straight, { angle: 20, crossings: 2 });
    });
    const p = prepare(r);
    const tp = computeToolpath(p);
    for (const s of [0, 17, 1000, tp.totalSamples - 1, Math.floor(tp.totalSamples / 2) + 3]) {
      const pose = poseAtSample(p, tp, s);
      const pt = toolPoint(p, pose);
      expect(pt.x).toBeCloseTo(tp.x[s], 3);
      expect(pt.y).toBeCloseTo(tp.y[s], 3);
      const w = workPlacement(p, pose);
      const c = Math.cos(w.rotation);
      const sn = Math.sin(w.rotation);
      expect(c * pt.x - sn * pt.y + w.x).toBeCloseTo(pose.slideRadius + pose.rock, 6);
      expect(sn * pt.x + c * pt.y + w.y).toBeCloseTo(0, 6);
    }
  });

  it('Fill to edge runs the lines past the rim on both sides; symmetry is left alone', () => {
    const r = straight((x) => {
      x.machine.fillEdge = true;
      x.rosettes = [defaultRosette({ lobes: 12, amplitude: 1 })];
      x.symmetry = { order: 6, mirror: true };
    });
    expect(effectiveEndRadius(r)).toBeGreaterThan(plateRadius(r) + 1);
    const tp = computeToolpath(prepare(r));
    expect(tp.bounds.minY).toBeLessThan(-plateRadius(r));
    expect(tp.bounds.maxY).toBeGreaterThan(plateRadius(r));
    expect(enforceSymmetry(r)).toBe(r);
    expect(analyzeSymmetry(r)).toEqual({ order: 1, mirror: false });
    expect(passSpacing(r)).toBeCloseTo((2 * effectiveEndRadius(r)) / (r.slide.passes - 1), 9);
  });

  it('switching the straight-line engine off gives back the rose engine untouched', () => {
    const r = straight();
    r.straight.enabled = false;
    const tp = computeToolpath(prepare(r));
    expect(tp.passes.every((p) => p.closed === false)).toBe(true); // spiral is back on
    expect(tp.passes).toHaveLength(5);
  });
});

describe('straight-line and circular presets', () => {
  const get = (id: string) => PRESETS.find((p) => p.id === id)!.recipe;

  it('Clous de Paris: two sets crossed at 90°, V-grooves just meeting (pyramids)', () => {
    const r = get('clous-de-paris');
    expect(r.straight).toMatchObject({ enabled: true, crossings: 2, crossAngle: 0 });
    expect(r.rosettes.filter((x) => x.enabled)).toHaveLength(0);
    expect(r.mode).toBe('metal');
    const cov = grooveCoverage(r)!;
    expect(cov).toBeGreaterThanOrEqual(1);
    expect(cov).toBeLessThan(1.05);
    // Watch scale with a 90° graver: tall, sharp pyramids.
    expect(r.machine.workDiameter).toBe(38);
    expect(r.metal.toolAngle).toBe(90);
  });

  it('Tapisserie: square grid on the 12–6 axis with flat-topped tiles left between the grooves', () => {
    const r = get('tapisserie');
    expect(r.straight).toMatchObject({ enabled: true, angle: 0, crossings: 2 });
    const cov = grooveCoverage(r)!;
    expect(cov).toBeGreaterThan(0.3);
    expect(cov).toBeLessThan(0.7);
  });

  it('Pinstripe: one set of plain vertical lines', () => {
    const r = get('pinstripe');
    expect(r.straight).toMatchObject({ enabled: true, angle: 90, crossings: 1 });
    expect(r.rosettes.filter((x) => x.enabled)).toHaveLength(0);
  });

  it('Wave: one set of in-phase sine lines', () => {
    const r = get('wave');
    expect(r.straight).toMatchObject({ enabled: true, crossings: 1 });
    expect(r.rosettes).toEqual([expect.objectContaining({ enabled: true, profile: 'sine', axis: 'rock' })]);
    expect(r.slide).toMatchObject({ phaseMode: 'linear', phaseStep: 0 });
  });

  it('Écailles de poisson: rose-engine rings of round scallops; groups of 3 passes in phase, the next group half a scale over, with a slow swirl', () => {
    const r = get('ecailles-de-poisson');
    expect(r.straight.enabled).toBe(false);
    const [scale, wave] = r.rosettes;
    expect(scale).toMatchObject({ profile: 'convex', enabled: true, axis: 'rock' });
    expect(wave).toMatchObject({ profile: 'sine', enabled: true, lobes: 12 });
    expect(r.slide.phaseMode).toBe('custom');
    expect(r.slide.phaseCustom).toHaveLength(r.slide.passes);
    // 30° is a whole number of wave lobes and an odd number of half scales: it moves the scales half a scale
    // and leaves the wave where it was.
    expect(((30 * scale.lobes) / 360) % 1).toBeCloseTo(0.5, 9);
    expect(((30 * wave.lobes) / 360) % 1).toBeCloseTo(0, 9);
    const c = r.slide.phaseCustom;
    expect(c[3] - c[2]).toBeCloseTo(30 + (c[1] - c[0]), 6);
    expect(c[2] - c[1]).toBeCloseTo(c[1] - c[0], 6);
    const cov = grooveCoverage(r)!;
    expect(cov).toBeGreaterThanOrEqual(1);
  });

  it('Circular: plain concentric rings on the rose engine', () => {
    const r = get('circular');
    expect(r.straight.enabled).toBe(false);
    expect(r.rosettes.filter((x) => x.enabled)).toHaveLength(0);
    expect(analyzeSymmetry(r).order).toBe(Infinity);
  });
});

describe('straight-line engine end to end', () => {
  const r = PRESETS.find((p) => p.id === 'wave')!.recipe;
  const tp = computeToolpath(prepare(r));

  it('exports SVG and G-code clipped to the plate', () => {
    const svg = buildSVG(r, tp, SVG_OPTS);
    expect(svg).toContain('<path');
    const g = buildGcode(r, tp, GCODE_OPTS);
    const xs = [...g.text.matchAll(/X(-?[\d.]+) Y(-?[\d.]+)/g)].map((m) => Math.hypot(+m[1], +m[2]));
    expect(xs.length).toBeGreaterThan(100);
    expect(Math.max(...xs)).toBeLessThanOrEqual(plateRadius(r) + 1e-3);
  });

  it('round-trips through preset JSON and share links', () => {
    expect(parsePreset(serializePreset(r))).toEqual(r);
  });

  it('Random and Mutate keep the straight-line engine and give valid toolpaths', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const a = randomRecipe(seed, r, []);
      const b = mutateRecipe(r, seed, []);
      for (const x of [a, b]) {
        const t = computeToolpath(prepare(x));
        expect(t.totalSamples).toBeGreaterThan(0);
        expect(Number.isFinite(t.totalLength)).toBe(true);
        if (x.straight.enabled) expect(t.passes.every((p) => !p.closed)).toBe(true);
      }
    }
  });
});
