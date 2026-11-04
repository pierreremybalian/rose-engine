import { describe, expect, it } from 'vitest';
import { decodeRecipe, encodeRecipe } from '../../src/state/url';
import { randomRecipe } from '../../src/engine/random';
import { defaultRecipe } from '../../src/state/recipe';

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

  it('decodes through parsePreset (clamps and fills defaults)', async () => {
    const partial = { slide: { passes: 9999 }, mode: 'metal' } as never;
    const r = await decodeRecipe(await encodeRecipe(partial));
    expect(r).not.toBeNull();
    expect(r!.slide.passes).toBe(300);
    expect(r!.mode).toBe('metal');
    expect(r!.machine).toEqual(defaultRecipe().machine);
  });
});
