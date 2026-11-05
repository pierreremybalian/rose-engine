// The UI's single write path for recipe edits. Every hand edit is snapped to the recipe's symmetry
// (enforceSymmetry) before it reaches the store. Random/Mutate enforce on their own; the store and the
// main.ts subscriber never do, so there is no feedback loop.
import { enforceSymmetry } from '../engine/symmetry';
import { cloneRecipe, type Recipe } from '../state/recipe';
import type { Store } from '../state/store';

export interface EditOpts {
  /** While dragging: one drag = one undo step (the control calls store.endCoalesce() on release). */
  coalesce?: boolean;
}

/** Apply an edit (a draft mutator or a finished recipe), enforce symmetry, push it as one undoable step. */
export function editRecipe(store: Store, edit: Recipe | ((draft: Recipe) => void), opts?: EditOpts): void {
  let next: Recipe;
  if (typeof edit === 'function') {
    next = cloneRecipe(store.get().recipe);
    edit(next);
  } else {
    next = edit;
  }
  store.setRecipe(enforceSymmetry(next), opts);
}
