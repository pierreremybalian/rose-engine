import { describe, expect, it } from 'vitest';
import { fileBaseName, fileName, slugify } from '../../src/export/filename';
import { recipeWith } from './fixtures';

describe('fileBaseName', () => {
  it('slugs the name and appends the seed', () => {
    expect(fileBaseName(recipeWith((r) => ((r.name = 'Barleycorn'), (r.seed = 4172))))).toBe('barleycorn-4172');
    expect(fileBaseName(recipeWith((r) => ((r.name = '  Rosace Excentrique №3 (bleu)! '), (r.seed = 7))))).toBe(
      'rosace-excentrique-no3-bleu-7',
    );
    expect(fileBaseName(recipeWith((r) => ((r.name = 'Guillochée'), (r.seed = 0))))).toBe('guillochee-0');
    expect(fileBaseName(recipeWith((r) => ((r.name = '***'), (r.seed = 12))))).toBe('rose-engine-12');
    expect(fileName(recipeWith((r) => ((r.name = 'Barleycorn'), (r.seed = 4172))), '.svg')).toBe('barleycorn-4172.svg');
  });
  it('keeps slugs short and clean', () => {
    const s = slugify('a'.repeat(47) + ' bcd');
    expect(s.length).toBeLessThanOrEqual(48);
    expect(s.endsWith('-')).toBe(false);
  });
});
