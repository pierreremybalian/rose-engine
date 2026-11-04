import type { Recipe } from '../state/recipe';

/** Lowercase ASCII slug: diacritics stripped, anything else collapsed to single dashes, max 48 chars. */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

/** File base name for exports: slug of the recipe name plus the seed, e.g. `barleycorn-4172`. */
export function fileBaseName(recipe: Recipe): string {
  const slug = slugify(recipe.name ?? '') || 'rose-engine';
  const seed = Number.isFinite(recipe.seed) ? Math.abs(Math.trunc(recipe.seed)) : 0;
  return `${slug}-${seed}`;
}

/** `fileBaseName(recipe)` plus an extension, e.g. `fileName(r, 'svg')` → `barleycorn-4172.svg`. */
export function fileName(recipe: Recipe, ext: string): string {
  return `${fileBaseName(recipe)}.${ext.replace(/^\./, '')}`;
}
