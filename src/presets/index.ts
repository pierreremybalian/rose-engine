// Built-in presets. Each JSON file is a full recipe; all of them go through parsePresetObject so a stale or
// hand-edited file can never feed bad values to the engine.
import type { Recipe } from '../state/recipe';
import { parsePresetObject } from '../export/preset';
import barleycorn from './barleycorn.json';
import basketWeave from './basket-weave.json';
import moireWave from './moire-wave.json';
import flame from './flame.json';
import sunray from './sunray.json';
import rosace from './rosace.json';
import cartouche from './cartouche.json';
import nautilus from './nautilus.json';
import enamelDial from './enamel-dial.json';
import harlequin from './harlequin.json';
import petals from './petals.json';
import bluedFlame from './blued-flame.json';
import grainDOrge from './grain-d-orge.json';
import fineBarleycorn from './fine-barleycorn.json';
import grainDrift from './grain-drift.json';
import clousDeParis from './clous-de-paris.json';
import tapisserie from './tapisserie.json';
import pinstripe from './pinstripe.json';
import wave from './wave.json';
import ecaillesDePoisson from './ecailles-de-poisson.json';
import circular from './circular.json';

/** Menu order. The first entry is also the pattern the app opens with. */
const SOURCES: [string, unknown][] = [
  ['grain-d-orge', grainDOrge],
  ['barleycorn', barleycorn],
  ['clous-de-paris', clousDeParis],
  ['tapisserie', tapisserie],
  ['pinstripe', pinstripe],
  ['wave', wave],
  ['ecailles-de-poisson', ecaillesDePoisson],
  ['circular', circular],
  ['basket-weave', basketWeave],
  ['moire-wave', moireWave],
  ['flame', flame],
  ['sunray', sunray],
  ['rosace', rosace],
  ['cartouche', cartouche],
  ['nautilus', nautilus],
  ['enamel-dial', enamelDial],
  ['harlequin', harlequin],
  ['petals', petals],
  ['blued-flame', bluedFlame],
  ['fine-barleycorn', fineBarleycorn],
  ['grain-drift', grainDrift],
];

export const PRESETS: { id: string; name: string; recipe: Recipe }[] = SOURCES.map(([id, data]) => {
  const recipe = parsePresetObject(data);
  return { id, name: recipe.name, recipe };
});

/** The preset the app opens with on a first visit (no share link in the URL): the first in the menu. */
export const DEFAULT_PRESET_ID = PRESETS[0].id;

/** A fresh copy of a built-in preset's recipe (callers may mutate it). */
export function presetRecipe(id: string): Recipe | null {
  const p = PRESETS.find((x) => x.id === id);
  return p ? structuredClone(p.recipe) : null;
}

/** Which built-in preset a recipe is: `edited` once any setting differs (it still carries the preset's name). */
export interface PresetMatch {
  id: string;
  edited: boolean;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * The built-in preset this recipe is, or was loaded from. Mode (ink / metal), cut direction and the name do not count
 * as edits: they are a view choice, a cutting order and a label. A recipe that differs from every preset but keeps a preset's name is that
 * preset, edited. Random gives recipes new names, so they match nothing.
 */
export function matchPreset(recipe: Recipe): PresetMatch | null {
  const strip = (r: Recipe) => ({ ...r, mode: null, name: null, slide: { ...r.slide, inward: null } });
  const cur = strip(recipe);
  const exact = PRESETS.find((p) => sameValue(strip(p.recipe), cur));
  if (exact) return { id: exact.id, edited: false };
  const named = PRESETS.find((p) => p.name === recipe.name);
  return named ? { id: named.id, edited: true } : null;
}
