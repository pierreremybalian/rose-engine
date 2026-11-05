import { describe, expect, it } from 'vitest';
import { scaleRecipe } from '../../src/state/scale';
import { defaultRecipe, defaultRosette, type Recipe } from '../../src/state/recipe';
import { PARAMS, getPath } from '../../src/state/params';
import { PRESETS } from '../../src/presets';
import { randomRecipe, grooveCoverage } from '../../src/engine/random';
import { maxUsefulRadius } from '../../src/engine/plate';

const SCALED = ['machine.workDiameter', 'slide.startRadius', 'slide.endRadius', 'eccentric.offset', 'elliptical.e', 'metal.baseDepth', 'ink.lineWidth'];

function rich(): Recipe {
  const r = defaultRecipe();
  r.mode = 'metal';
  r.machine = { ...r.machine, workDiameter: 80, rubberRadius: 1.5, rosetteRadius: 70 };
  r.rosettes = [
    defaultRosette({ id: 'a', lobes: 24, amplitude: 0.4, phase: 7.5 }),
    defaultRosette({ id: 'b', lobes: 6, amplitude: 0.05, axis: 'pump', profile: 'convex', phase: 30 }),
  ];
  r.slide = { ...r.slide, startRadius: 6, endRadius: 30, passes: 60, phaseMode: 'linear', phaseStep: 1.5, amplitudeTaper: 1.3 };
  r.eccentric = { enabled: true, offset: 4, angle: 33, divisions: 6, divisionStep: 0 };
  r.elliptical = { enabled: true, e: 2, angle: 15 };
  r.metal.baseDepth = 0.12;
  r.ink.lineWidth = 0.3;
  return r;
}

function expectClose(a: Recipe, b: Recipe, digits = 6) {
  for (const key of SCALED) expect(getPath(a, key) as number, key).toBeCloseTo(getPath(b, key) as number, digits);
  a.rosettes.forEach((ro, i) => expect(ro.amplitude, `rosette ${i}`).toBeCloseTo(b.rosettes[i].amplitude, digits));
}

describe('scaleRecipe', () => {
  it('scales the design dimensions by k and leaves the machine physics, program and colours alone', () => {
    const r = rich();
    const s = scaleRecipe(r, 1.5);
    expect(s).not.toBe(r);
    expect(s.machine.workDiameter).toBe(120);
    expect(s.slide.startRadius).toBe(9);
    expect(s.slide.endRadius).toBe(45);
    expect(s.rosettes.map((x) => x.amplitude)).toEqual([0.6, 0.075]);
    expect(s.eccentric.offset).toBe(6);
    expect(s.elliptical.e).toBe(3);
    expect(s.metal.baseDepth).toBe(0.18);
    expect(s.ink.lineWidth).toBe(0.45);
    // Not scaled.
    expect(s.machine.rosetteRadius).toBe(70);
    expect(s.machine.rubberRadius).toBe(1.5);
    expect(s.rosettes.map((x) => [x.lobes, x.phase, x.profile, x.axis])).toEqual(r.rosettes.map((x) => [x.lobes, x.phase, x.profile, x.axis]));
    expect(s.slide.passes).toBe(r.slide.passes);
    expect(s.slide.phaseStep).toBe(r.slide.phaseStep);
    expect(s.slide.amplitudeTaper).toBe(r.slide.amplitudeTaper);
    expect([s.eccentric.angle, s.eccentric.divisions, s.elliptical.angle]).toEqual([33, 6, 15]);
    expect(s.ink.palette).toEqual(r.ink.palette);
    expect(s.metal.toolAngle).toBe(r.metal.toolAngle);
    // The input is not mutated.
    expect(r).toEqual(rich());
  });

  it('k then 1/k is close to the original', () => {
    const recipes = [rich(), defaultRecipe(), ...PRESETS.map((p) => p.recipe)];
    for (let seed = 1; seed <= 20; seed++) recipes.push(randomRecipe(seed, { ...defaultRecipe(), mode: seed % 2 ? 'metal' : 'ink' }, []));
    for (const r of recipes) {
      for (const k of [0.8, 1.25, 0.6]) {
        // Stay inside every param range so nothing clamps on the way out.
        const fits = SCALED.every((key) => {
          const def = PARAMS.find((p) => p.key === key)!;
          const v = (getPath(r, key) as number) * k;
          return v >= (def.min ?? -Infinity) - 1e-9 && v <= (def.max ?? Infinity) + 1e-9;
        }) && r.rosettes.every((ro) => ro.amplitude * k <= 8) && Math.max(r.slide.startRadius, r.slide.endRadius) <= maxUsefulRadius(r);
        if (!fits) continue;
        const back = scaleRecipe(scaleRecipe(r, k), 1 / k);
        expectClose(back, r, 4);
        expect(back.slide.passes).toBe(r.slide.passes);
        expect(back.rosettes.map((x) => x.lobes)).toEqual(r.rosettes.map((x) => x.lobes));
      }
    }
  });

  it('keeps the passes and the metal coverage (same design at another size)', () => {
    for (const p of PRESETS.filter((x) => x.recipe.mode === 'metal')) {
      const r = p.recipe;
      for (const k of [0.8, 1.2]) {
        if (r.metal.baseDepth * k > 0.4 || r.machine.workDiameter * k > 300) continue;
        const s = scaleRecipe(r, k);
        expect(s.slide.passes).toBe(r.slide.passes);
        const before = grooveCoverage(r);
        const after = grooveCoverage(s);
        expect(before, p.id).not.toBeNull();
        expect(after!, `${p.id} × ${k}`).toBeCloseTo(before!, 2);
      }
    }
  });

  it('clamps every scaled value to its param range, the plate to 20–300 mm', () => {
    const big = scaleRecipe(rich(), 10);
    expect(big.machine.workDiameter).toBe(300);
    expect(big.metal.baseDepth).toBe(0.4);
    expect(big.ink.lineWidth).toBeCloseTo(0.3 * 3.75, 9); // the plate clamps at 300 mm, so k = 300 / 80
    expect(big.slide.endRadius).toBeLessThanOrEqual(maxUsefulRadius(big));
    const thick = rich();
    thick.ink.lineWidth = 1;
    expect(scaleRecipe(thick, 3).ink.lineWidth).toBe(1.5);
    const small = scaleRecipe(rich(), 0.01);
    expect(small.machine.workDiameter).toBe(20);
    expect(small.metal.baseDepth).toBeGreaterThanOrEqual(0.01);
    expect(small.ink.lineWidth).toBeGreaterThanOrEqual(0.05);
    for (const def of PARAMS) {
      if (def.type !== 'number' && def.type !== 'int') continue;
      for (const s of [big, small]) {
        const v = getPath(s, def.key) as number;
        if (def.min !== undefined) expect(v, def.key).toBeGreaterThanOrEqual(def.min);
        if (def.max !== undefined) expect(v, def.key).toBeLessThanOrEqual(def.max);
      }
    }
  });

  it('when the plate clamps, the rest scales by the ratio the plate actually moved', () => {
    const r = rich(); // 80 mm plate
    const s = scaleRecipe(r, 5); // 400 mm → clamped to 300, so k = 3.75
    expect(s.machine.workDiameter).toBe(300);
    expect(s.slide.endRadius).toBeCloseTo(30 * 3.75, 6);
    expect(s.eccentric.offset).toBeCloseTo(4 * 3.75, 6);
  });

  it('k = 1 is a no-op copy; bad k returns an unchanged copy', () => {
    const r = rich();
    for (const k of [1, 0, -2, NaN, Infinity]) {
      const s = scaleRecipe(r, k);
      expect(s).toEqual(r);
      expect(s).not.toBe(r);
    }
  });
});
