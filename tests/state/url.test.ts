import { describe, expect, it } from 'vitest';
import { decodeRecipe, encodeRecipe } from '../../src/state/url';
import { randomRecipe } from '../../src/engine/random';
import { RECIPE_VERSION, defaultRecipe } from '../../src/state/recipe';
import { V1_PRESET } from './fixtures';

describe('share URL encoding', () => {
  it('round-trips the default recipe', async () => {
    const r = defaultRecipe();
    const s = await encodeRecipe(r);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await decodeRecipe(s)).toEqual(r);
  });

  it('round-trips random recipes in both modes', async () => {
    for (let seed = 0; seed < 20; seed++) {
      const r = randomRecipe(seed, { ...defaultRecipe(), mode: seed % 2 ? 'metal' : 'ink' }, []);
      expect(await decodeRecipe(await encodeRecipe(r))).toEqual(r);
    }
  });

  it('is compact', async () => {
    const s = await encodeRecipe(defaultRecipe());
    expect(s.length).toBeLessThan(800);
  });

  it('returns null on garbage', async () => {
    for (const junk of ['', '   ', 'hello world', '!!!', 'AAAA', 'eJzLSM3JyQcABiwCFQ', '%%%', '____']) {
      expect(await decodeRecipe(junk)).toBeNull();
    }
    // Valid deflate of something that isn't a recipe.
    const notRecipe = await encodeRecipe({ hello: 'world' } as never);
    expect(await decodeRecipe(notRecipe)).toBeNull();
  });

  it('decodes an old v1 share link through the v1 → v2 migration', async () => {
    // Exactly what a v1 build wrote into the hash: base64url(deflate-raw(JSON)) of a version 1 recipe.
    const link = await encodeRecipe(V1_PRESET as never);
    const r = await decodeRecipe(link);
    expect(r).not.toBeNull();
    expect(r!.version).toBe(RECIPE_VERSION);
    expect(r!.machine.fillEdge).toBe(false);
    expect(r!.symmetry).toEqual({ order: 0, mirror: false });
    expect(r!.slide).toEqual(V1_PRESET.slide);
    expect(r!.rosettes).toEqual(V1_PRESET.rosettes);
    // Re-sharing writes a v2 link that decodes to the same recipe.
    expect(await decodeRecipe(await encodeRecipe(r!))).toEqual(r);
  });

  it('decodes through parsePreset (clamps and fills defaults)', async () => {
    const partial = { slide: { passes: 9999 }, mode: 'metal' } as never;
    const r = await decodeRecipe(await encodeRecipe(partial));
    expect(r).not.toBeNull();
    expect(r!.slide.passes).toBe(300);
    expect(r!.mode).toBe('metal');
    expect(r!.machine).toEqual(defaultRecipe().machine);
  });
});
