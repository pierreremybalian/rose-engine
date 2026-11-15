import { describe, expect, it } from 'vitest';
import { getPath } from '../../src/state/params';
import { defaultRecipe, layerFromBase, type Recipe } from '../../src/state/recipe';
import { clampEditCut, cutDepthPath, cutPath, remapEditCut, Store } from '../../src/state/store';

function withLayers(n: number): Recipe {
  const r = defaultRecipe();
  for (let i = 0; i < n; i++) r.layers.push(layerFromBase(r, 0.05));
  return r;
}

describe('cutPath', () => {
  it('leaves base-cut and shared keys alone', () => {
    expect(cutPath('slide.passes', 0)).toBe('slide.passes');
    expect(cutPath('rosettes', 0)).toBe('rosettes');
    expect(cutPath('metal.material', 2)).toBe('metal.material');
    expect(cutPath('machine.fillEdge', 1)).toBe('machine.fillEdge');
    expect(cutPath('symmetry.order', 1)).toBe('symmetry.order');
  });
  it('prefixes per-cut keys with the layer index', () => {
    expect(cutPath('slide.passes', 1)).toBe('layers.0.slide.passes');
    expect(cutPath('rosettes', 2)).toBe('layers.1.rosettes');
    for (const k of ['straight.enabled', 'eccentric.offset', 'elliptical.e', 'mask.radius']) expect(cutPath(k, 3)).toBe(`layers.2.${k}`);
  });
  it('resolves to the right value in a layered recipe', () => {
    const r = withLayers(2);
    r.layers[1].slide.passes = 7;
    expect(getPath(r, cutPath('slide.passes', 2))).toBe(7);
    expect(getPath(r, cutPath('slide.passes', 0))).toBe(r.slide.passes);
  });
  it('depth path', () => {
    expect(cutDepthPath(0)).toBe('metal.baseDepth');
    expect(cutDepthPath(2)).toBe('layers.1.depth');
  });
});

describe('editCut bookkeeping', () => {
  it('clamps to existing cuts', () => {
    const r = withLayers(2);
    expect(clampEditCut(r, 2)).toBe(2);
    expect(clampEditCut(r, 3)).toBe(0);
    expect(clampEditCut(r, -1)).toBe(0);
  });
  it('follows the selected layer by id and drops to the base when it is gone', () => {
    const a = withLayers(3);
    const b = structuredClone(a);
    b.layers.splice(0, 1);
    expect(remapEditCut(a, b, 3)).toBe(2);
    expect(remapEditCut(a, b, 1)).toBe(0);
    expect(remapEditCut(a, defaultRecipe(), 2)).toBe(0);
    expect(remapEditCut(a, b, 0)).toBe(0);
  });
  it('store keeps editCut valid through edits, undo and redo, outside history', () => {
    const store = new Store({ recipe: withLayers(2) });
    store.set({ editCut: 2 });
    expect(store.get().editCut).toBe(2);
    store.set({ editCut: 9 });
    expect(store.get().editCut).toBe(0);
    store.set({ editCut: 2 });
    store.setRecipe((d) => void d.layers.splice(0, 1));
    expect(store.get().editCut).toBe(1);
    store.setRecipe((d) => void d.layers.splice(0, 1));
    expect(store.get().editCut).toBe(0);
    store.undo();
    expect(store.get().recipe.layers).toHaveLength(1);
    expect(store.get().editCut).toBe(0);
    store.set({ editCut: 1 });
    store.redo();
    expect(store.get().editCut).toBe(0);
  });
});
