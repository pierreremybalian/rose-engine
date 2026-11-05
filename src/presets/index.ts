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

/** Menu order. The first entry is also the pattern the app opens with. */
const SOURCES: [string, unknown][] = [
  ['grain-d-orge', grainDOrge],
  ['barleycorn', barleycorn],
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
