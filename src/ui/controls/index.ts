import { boolControl, colorControl, metalControl, selectControl } from './choice';
import type { Control, FieldCtx, FieldDef } from './field';
import { numberControl } from './number';

export type { Control, FieldCtx, FieldDef } from './field';
export { lockButton, HINTS, shell } from './field';
export { numberControl } from './number';
export { segmented, switchButton, numberListControl } from './choice';

/** Build the right control for a param type. `hintKey` picks fallback help text (rosette fields use their bare key). */
export function paramControl(def: FieldDef, ctx: FieldCtx, hintKey?: string): Control {
  if (def.key === 'metal.material') return metalControl(def, ctx);
  switch (def.type) {
    case 'number':
    case 'int':
      return numberControl(def, ctx, hintKey);
    case 'bool':
      return boolControl(def, ctx, hintKey);
    case 'select':
      return selectControl(def, ctx, hintKey);
    case 'color':
      return colorControl(def, ctx, hintKey);
  }
}
