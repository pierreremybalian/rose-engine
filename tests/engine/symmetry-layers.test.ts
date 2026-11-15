import { describe, expect, it } from 'vitest';
import { analyzeSymmetry, enforceSymmetry, enforceSymmetryAll } from '../../src/engine/symmetry';
import { mutateRecipe, randomRecipe } from '../../src/engine/random';
import { editRecipe } from '../../src/ui/edit';
import { PRESETS } from '../../src/presets';
import { defaultRecipe, defaultRosette, layerFromBase, type Recipe } from '../../src/state/recipe';
import type { Store } from '../../src/state/store';

const ros = (lobes: number, extra: Partial<ReturnType<typeof defaultRosette>> = {}) =>
  defaultRosette({ id: `r${lobes}`, lobes, amplitude: 1, profile: 'sine', phase: 270 % (360 / lobes), ...extra });

function base(edit: (r: Recipe) => void = () => {}): Recipe {
  const r = defaultRecipe();
  r.mode = 'metal';
  r.machine.rubberRadius = 0;
  r.rosettes = [ros(12)];
  r.slide = { ...r.slide, passes: 6, startRadius: 5, endRadius: 30, phaseMode: 'linear', phaseStep: 0, spiral: false };
  r.eccentric = { ...r.eccentric, enabled: false };
  r.elliptical = { ...r.elliptical, enabled: false };
  r.straight = { ...r.straight, enabled: false };
  r.symmetry = { order: 0, mirror: false };
  edit(r);
  return r;
}

/** Base plus one layer per lobe count (each a copy of the base cut with one rosette of that count). */
function layered(lobes: number[], edit: (r: Recipe) => void = () => {}): Recipe {
  return base((r) => {
    r.layers = lobes.map((L) => ({ ...layerFromBase(r, 0.03), rosettes: [ros(L)] }));
    edit(r);
  });
}

describe('enforceSymmetryAll', () => {
  it('returns the same object when nothing changes (presets, unlayered, conforming layers)', () => {
    for (const p of PRESETS) expect(enforceSymmetryAll(p.recipe), p.id).toBe(p.recipe);
    const plain = base((r) => (r.symmetry = { order: 6, mirror: true }));
    expect(enforceSymmetryAll(plain)).toBe(plain);
    const ok = layered([24, 36], (r) => (r.symmetry = { order: 12, mirror: true }));
    expect(enforceSymmetryAll(ok)).toBe(ok);
  });

  it('snaps every cut (enabled or not) and keeps untouched layers by identity', () => {
    const r = layered([24, 7, 10], (x) => {
      x.symmetry = { order: 6, mirror: false };
      x.layers[2].enabled = false;
    });
    const e = enforceSymmetryAll(r);
    expect(e).not.toBe(r);
    expect(e.rosettes).toBe(r.rosettes); // base already 12 lobes
    expect(e.layers[0]).toBe(r.layers[0]);
    expect(e.layers[1].rosettes[0].lobes).toBe(6);
    expect(e.layers[2].rosettes[0].lobes).toBe(12);
    expect(e.layers[1].id).toBe(r.layers[1].id);
    expect(e.layers[1].depth).toBe(r.layers[1].depth);
    expect(e.layers[1].mask).toBe(r.layers[1].mask);
    // the input is never mutated
    expect(r.layers[1].rosettes[0].lobes).toBe(7);
    expect(enforceSymmetryAll(e)).toBe(e);
    expect(analyzeSymmetry(e).order % 6).toBe(0);
  });

  it('snaps the base and the layers together', () => {
    const r = layered([9], (x) => {
      x.rosettes = [ros(13)];
      x.symmetry = { order: 4, mirror: true };
      x.layers[0].rosettes[0].phase = 3;
      x.layers[0].slide.phaseStep = 2;
    });
    const e = enforceSymmetryAll(r);
    expect(e.rosettes[0].lobes).toBe(12);
    expect(e.layers[0].rosettes[0].lobes).toBe(8);
    expect(e.layers[0].slide.phaseStep).toBe(0);
    expect(analyzeSymmetry(e)).toMatchObject({ order: 4, mirror: true, axis: 90 });
  });

  it('is what editRecipe applies', () => {
    let got: Recipe | null = null;
    const start = layered([24], (x) => (x.symmetry = { order: 6, mirror: false }));
    const store = { get: () => ({ recipe: start }), setRecipe: (n: Recipe) => (got = n) } as unknown as Store;
    editRecipe(store, (d) => (d.layers[0].rosettes[0].lobes = 25));
    expect(got!.layers[0].rosettes[0].lobes).toBe(24);
  });
});

describe('analyzeSymmetry with layers', () => {
  it('order is the gcd of the enabled cuts', () => {
    expect(analyzeSymmetry(layered([8])).order).toBe(4);
    expect(analyzeSymmetry(layered([8, 18])).order).toBe(2);
    expect(analyzeSymmetry(layered([7], (r) => (r.layers[0].enabled = false))).order).toBe(12);
    // plain circles in a layer do not lower the order
    expect(analyzeSymmetry(layered([8], (r) => (r.layers[0].rosettes = []))).order).toBe(12);
    // a straight-line cut is a lattice: no order, no mirror
    expect(analyzeSymmetry(layered([12], (r) => (r.layers[0].straight = { ...r.layers[0].straight, enabled: true })))).toEqual({ order: 1, mirror: false });
  });

  it('mirror only when one axis mirrors every cut', () => {
    expect(analyzeSymmetry(layered([8]))).toMatchObject({ mirror: true, axis: 90 });
    // layer 8 lobes turned by a quarter lobe: its axes are off 12–6 and off the base's axes
    const off = layered([8], (r) => (r.layers[0].rosettes[0].phase = 270 % 45 + 45 / 4));
    expect(analyzeSymmetry(off).mirror).toBe(false);
    // a twisting layer is not mirror-symmetric
    expect(analyzeSymmetry(layered([12], (r) => (r.layers[0].slide.phaseStep = 1))).mirror).toBe(false);
    // same 3-fold offset on both cuts: a common axis exists, not on 12 o'clock
    const turned = layered([6], (r) => {
      r.rosettes = [ros(3, { phase: 10 })];
      r.layers[0].rosettes = [ros(6, { phase: 10 })];
    });
    const a = analyzeSymmetry(turned);
    expect(a.order).toBe(3);
    expect(a.mirror).toBe(true);
    expect(a.axis).not.toBe(90);
  });
});

describe('lobe morph (lobesEnd)', () => {
  it('order counts every pass count', () => {
    // Counts step in multiples of gcd(lobes, lobesEnd): 12 → 24 cuts 12 or 24 only → 12-fold whatever the passes;
    // 12 → 18 (gcd 6) over 4 passes: 12, 12, 18, 18 → 6-fold.
    expect(analyzeSymmetry(base((r) => { r.rosettes = [ros(12, { lobesEnd: 24 })]; r.slide.passes = 3; })).order).toBe(12);
    expect(analyzeSymmetry(base((r) => { r.rosettes = [ros(12, { lobesEnd: 24 })]; r.slide.passes = 5; })).order).toBe(12);
    expect(analyzeSymmetry(base((r) => { r.rosettes = [ros(12, { lobesEnd: 18 })]; r.slide.passes = 4; })).order).toBe(6);
    // lobesEnd 0 or equal to lobes: no morph
    expect(analyzeSymmetry(base((r) => (r.rosettes = [ros(12, { lobesEnd: 0 })]))).order).toBe(12);
    expect(analyzeSymmetry(base((r) => (r.rosettes = [ros(12, { lobesEnd: 12 })]))).order).toBe(12);
  });

  it('enforceSymmetry snaps lobesEnd to a multiple of N; off stays off', () => {
    const e = enforceSymmetry(base((r) => { r.rosettes = [ros(12, { lobesEnd: 17 }), ros(18, { lobesEnd: 0 }), ros(24)]; r.symmetry = { order: 6, mirror: false }; }));
    expect(e.rosettes.map((x) => x.lobesEnd)).toEqual([18, 0, undefined]);
    expect(enforceSymmetry(e)).toBe(e);
    const tiny = enforceSymmetry(base((r) => { r.rosettes = [ros(12, { lobesEnd: 2 })]; r.symmetry = { order: 6, mirror: false }; }));
    expect(tiny.rosettes[0].lobesEnd).toBe(6);
  });

  it('mirror puts a peak on 12 o\'clock for every count of a morph', () => {
    // 12 → 18 over 2 passes: counts 12 and 18, phase ≡ 270 (mod 60)
    const r = base((x) => { x.rosettes = [ros(12, { lobesEnd: 18, phase: 7 })]; x.slide.passes = 2; x.symmetry = { order: 0, mirror: true }; });
    expect(analyzeSymmetry(r)).toMatchObject({ order: 6, mirror: true, axis: 23 }); // the common axis of both counts is -7°
    const e = enforceSymmetry(r);
    expect(((e.rosettes[0].phase - 270) % 60 + 60) % 60).toBeCloseTo(0, 9);
    expect(analyzeSymmetry(e)).toMatchObject({ mirror: true, axis: 90 });
  });
});

describe('Random / Mutate keep the extra cuts and the mask', () => {
  const VIEW = ['symmetry.order', 'symmetry.mirror', 'machine.fillEdge'];
  const cur = layered([24, 36], (r) => {
    r.symmetry = { order: 12, mirror: false };
    r.mask = { ...r.mask, enabled: true, radius: 12, lobes: 6 };
    r.layers[1].mask = { ...r.layers[1].mask, enabled: true, depth: 0.02 };
  });

  it('randomRecipe changes only the base cut', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const out = randomRecipe(seed, cur, VIEW);
      expect(out.layers, `seed ${seed}`).toEqual(cur.layers);
      expect(out.mask).toEqual(cur.mask);
    }
  });

  it('mutateRecipe changes only the base cut', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const out = mutateRecipe(cur, seed, VIEW, 0.5);
      expect(out.layers, `seed ${seed}`).toEqual(cur.layers);
      expect(out.mask).toEqual(cur.mask);
    }
  });

  it('a changed symmetry snaps the layers too', () => {
    const out = randomRecipe(3, { ...cur, symmetry: { order: 5, mirror: false } }, VIEW);
    for (const l of out.layers) for (const ro of l.rosettes) expect(ro.lobes % 5).toBe(0);
  });
});
