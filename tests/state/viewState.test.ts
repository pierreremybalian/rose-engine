import { describe, expect, it } from 'vitest';
import { Store } from '../../src/state/store';

describe('tilt and shimmer view state', () => {
  it('defaults to a level plate with the shimmer off', () => {
    const s = new Store().get();
    expect(s.tilt).toEqual({ x: 0, y: 0 });
    expect(s.shimmer).toBe(false);
  });

  it('stays out of the recipe and its undo history', () => {
    const store = new Store();
    store.set({ tilt: { x: 12, y: -4 }, shimmer: true });
    expect(store.canUndo()).toBe(false);
    expect(JSON.stringify(store.get().recipe)).not.toMatch(/tilt|shimmer/);
    store.setRecipe((r) => {
      r.seed += 1;
    });
    store.undo();
    expect(store.get().tilt).toEqual({ x: 12, y: -4 });
    expect(store.get().shimmer).toBe(true);
  });
});
