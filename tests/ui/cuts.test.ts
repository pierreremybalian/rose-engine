import { describe, expect, it } from 'vitest';
import { defaultRecipe, layerFromBase } from '../../src/state/recipe';
import { copyCut, cutSummary, MAX_LAYERS, snapDepth } from '../../src/ui/cuts';

describe('copyCut', () => {
  it('adds a shallower copy of the selected cut at the end', () => {
    const r = defaultRecipe();
    r.layers.push(layerFromBase(r, 0.05));
    r.layers[0].slide.passes = 9;
    const c = copyCut(r, 1, true)!;
    const d = structuredClone(r);
    c.edit(d);
    expect(c.at).toBe(2);
    expect(d.layers).toHaveLength(2);
    expect(d.layers[1].slide.passes).toBe(9);
    expect(d.layers[1].depth).toBe(0.03);
    expect(d.layers[1].id).not.toBe(d.layers[0].id);
    expect(d.layers[1].rosettes[0].id).not.toBe(d.layers[0].rosettes[0].id);
    expect(d.slide).toEqual(r.slide);
  });
  it('duplicates right after its source at the same depth', () => {
    const r = defaultRecipe();
    r.layers.push(layerFromBase(r, 0.05), layerFromBase(r, 0.02));
    const c = copyCut(r, 0, false)!;
    const d = structuredClone(r);
    c.edit(d);
    expect(c.at).toBe(1);
    expect(d.layers[0].depth).toBe(r.metal.baseDepth);
    expect(d.layers[2].depth).toBe(0.02);
  });
  it('stops at the cut limit', () => {
    const r = defaultRecipe();
    for (let i = 0; i < MAX_LAYERS; i++) r.layers.push(layerFromBase(r, 0.05));
    expect(copyCut(r, 0, true)).toBeNull();
  });
  it('snaps depths to the slider step', () => {
    expect(snapDepth(0.048)).toBe(0.05);
    expect(snapDepth(0.001)).toBe(0.01);
  });
  it('summarises a cut', () => {
    const r = defaultRecipe();
    expect(cutSummary(r, 0)).toBe('Rose · 48 passes · 12 lobes');
  });
});
