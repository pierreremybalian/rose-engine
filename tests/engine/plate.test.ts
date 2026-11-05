import { describe, expect, it } from 'vitest';
import { defaultRecipe, defaultRosette } from '../../src/state/recipe';
import { FILL_MARGIN, chuckReach, effectiveEndRadius, fillEndRadius, maxUsefulRadius, plateRadius, rockReach } from '../../src/engine/plate';

describe('plate geometry', () => {
  it('plate radius, chuck reach and rock reach', () => {
    const r = defaultRecipe();
    r.machine.workDiameter = 32;
    expect(plateRadius(r)).toBe(16);
    expect(chuckReach(r)).toBe(0);
    r.eccentric = { ...r.eccentric, enabled: true, offset: -3 };
    r.elliptical = { enabled: true, e: 2, angle: 10 };
    expect(chuckReach(r)).toBe(5);
    r.eccentric.enabled = false;
    expect(chuckReach(r)).toBe(2);
    r.rosettes = [defaultRosette({ amplitude: 0.5 }), defaultRosette({ amplitude: -0.25 }), defaultRosette({ amplitude: 9, axis: 'pump' }), defaultRosette({ amplitude: 9, enabled: false })];
    expect(rockReach(r)).toBe(0.75);
    r.slide.amplitudeTaper = 2;
    expect(rockReach(r)).toBe(1.5);
    r.slide.amplitudeTaper = 0.5; // taper below 1 never shrinks the first pass
    expect(rockReach(r)).toBe(0.75);
    expect(maxUsefulRadius(r)).toBe(18.8);
  });

  it('effective end radius: slide.endRadius when fill is off, past the rim when on', () => {
    const r = defaultRecipe();
    r.machine.workDiameter = 60;
    r.slide.endRadius = 12;
    expect(effectiveEndRadius(r)).toBe(12);
    r.machine.fillEdge = true;
    expect(effectiveEndRadius(r)).toBeCloseTo(30 + 1.2 + FILL_MARGIN, 9);
    expect(effectiveEndRadius(r)).toBe(fillEndRadius(r));
    // Never ends inside the start radius.
    r.slide.startRadius = 80;
    expect(effectiveEndRadius(r)).toBe(80);
  });

  it('spiral fill runs one turn further so the whole last turn clears the rim', () => {
    const r = defaultRecipe();
    r.machine.workDiameter = 60;
    r.machine.fillEdge = true;
    r.slide = { ...r.slide, spiral: true, startRadius: 4, passes: 10 };
    const F = 30 + 1.2 + FILL_MARGIN;
    const end = effectiveEndRadius(r);
    expect(end - (end - 4) / 10).toBeCloseTo(F, 9);
    r.slide.passes = 1;
    expect(effectiveEndRadius(r)).toBeCloseTo(F, 9);
  });

  it('copes with v1-shaped recipes (no fillEdge field)', () => {
    const r = defaultRecipe() as unknown as { machine: Record<string, unknown> };
    delete r.machine.fillEdge;
    expect(effectiveEndRadius(r as never)).toBe(46);
  });
});
