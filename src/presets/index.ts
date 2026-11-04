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

const SOURCES: [string, unknown][] = [
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
];

export const PRESETS: { id: string; name: string; recipe: Recipe }[] = SOURCES.map(([id, data]) => {
  const recipe = parsePresetObject(data);
  return { id, name: recipe.name, recipe };
});

/** A fresh copy of a built-in preset's recipe (callers may mutate it). */
export function presetRecipe(id: string): Recipe | null {
  const p = PRESETS.find((x) => x.id === id);
  return p ? structuredClone(p.recipe) : null;
}
