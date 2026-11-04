// Shared pieces for param rows: the binding contract, lock button, row shell and fallback help text.
import type { ParamDef } from '../../state/params';
import type { Recipe } from '../../state/recipe';
import type { AppState, Store } from '../../state/store';
import { h, toggled, uid } from '../dom';
import { icon } from '../icons';

/** A ParamDef or a ROSETTE_PARAMS entry (no group). */
export type FieldDef = Omit<ParamDef, 'group' | 'key'> & { key: string };

export interface FieldCtx {
  store: Store;
  read(r: Recipe): unknown;
  /** `coalesce` while dragging; the control calls store.endCoalesce() on release. */
  write(v: unknown, opts?: { coalesce?: boolean }): void;
  /** Key toggled in store.locks; null = no lock button. */
  lockKey: string | null;
  /** A parent lock (e.g. 'rosettes') that also covers this field. */
  inheritLockKey?: string;
}

export interface Control {
  el: HTMLElement;
  update(s: AppState): void;
}

/** Help shown for params whose schema entry has no `help`. Rosette fields are keyed without a prefix. */
export const HINTS: Record<string, string> = {
  'machine.workDiameter': 'Diameter of the dial or paper disc on the spindle.',
  'slide.passes': 'How many cuts the slide rest makes, stepping from the start radius to the end radius.',
  'slide.startRadius': 'Radius of the first cut, measured from the spindle axis.',
  'slide.endRadius': 'Radius of the last cut.',
  'slide.phaseMode': 'How the rosette is turned between passes: a steady drift, a half-lobe alternation, or your own sequence.',
  'slide.phaseStep': 'Spindle degrees added before each pass. Small drifts twist the pattern into a moiré.',
  'slide.alternateEvery': 'Passes per group before the phase flips.',
  'slide.alternateFraction': 'How far alternate groups are shifted, in lobes. 0.5 gives a classic barleycorn.',
  'slide.amplitudeTaper': 'Rosette amplitude multiplier reached at the last pass (1 = constant).',
  'slide.spiral': 'Feed the slide continuously so all passes join into one spiral.',
  'slide.phaseCustom': 'Spindle-degree offsets cycled pass by pass, separated by commas.',
  'eccentric.enabled': 'Set the work off-centre and repeat the program around a dividing wheel.',
  'eccentric.offset': 'Distance of the work centre from the spindle axis.',
  'eccentric.angle': 'Direction of the eccentric offset.',
  'eccentric.divisions': 'How many times the slide program repeats around the dividing wheel.',
  'elliptical.enabled': 'Turn circles into ellipses, as an elliptical chuck does.',
  'elliptical.e': 'A circle of radius R becomes an ellipse with semi-axes R+e and R−e.',
  'elliptical.angle': 'Orientation of the major axis.',
  'ink.colorMode': 'One colour, the palette cycled per pass, or a gradient across all passes.',
  'ink.palette': 'Pick a palette (sets ink and paper), then adjust single inks.',
  'ink.paper': 'Paper colour under the ink.',
  'ink.lineWidth': 'Nominal pen width. Pumping rosettes swell and thin it.',
  'ink.opacity': 'Ink transparency: overlapping strokes build up density.',
  'metal.material': 'The metal the plate is cut from.',
  'metal.toolAngle': 'Included angle of the V graver. Wider tools cut broader grooves at the same depth.',
  'metal.baseDepth': 'Nominal groove depth. Pumping rosettes add to it.',
  'metal.lightAngle': 'Direction of the light across the plate.',
  'metal.lightElevation': 'Height of the light. Low light rakes across the grooves.',
  'metal.enamel': 'Flood translucent enamel over the engraving (flinqué).',
  'metal.enamelColor': 'Colour of the enamel.',
  'metal.enamelOpacity': 'Enamel density. It pools darker in deeper cuts.',
  axis: 'Rocking moves the cut sideways (the pattern); pumping moves it in depth (line weight).',
  profile: 'Shape of each lobe on the cam.',
  lobes: 'Bumps per revolution of the rosette.',
  amplitude: 'Height of each lobe: how far the rubber pushes the headstock.',
  phase: 'Turns this rosette relative to the spindle.',
};

export function helpFor(def: FieldDef, hintKey = def.key): string | undefined {
  return def.help ?? HINTS[hintKey];
}

export interface LockButton {
  el: HTMLButtonElement;
  update(s: AppState): void;
}

export function lockButton(store: Store, key: string, label: string, inheritKey?: string): LockButton {
  const el = h(
    'button',
    {
      type: 'button',
      class: 're-lock',
      'aria-pressed': 'false',
      'aria-label': `Lock ${label}`,
      'data-lock': key,
      onClick: () => store.set({ locks: toggled(store.get().locks, key) }),
    },
    icon('lockOpen', 're-lock__open'),
    icon('lockShut', 're-lock__shut'),
  );
  let last = '';
  return {
    el,
    update(s) {
      const pressed = s.locks.includes(key);
      const inherited = !pressed && !!inheritKey && s.locks.includes(inheritKey);
      const sig = `${pressed}|${inherited}`;
      if (sig === last) return;
      last = sig;
      el.setAttribute('aria-pressed', String(pressed));
      el.dataset.inherited = String(inherited);
      el.dataset.tip = pressed
        ? `${label} is locked: Random and Mutate leave it alone`
        : inherited
          ? 'Locked with the whole stack'
          : `Lock ${label} against Random and Mutate`;
    },
  };
}

export interface Shell {
  el: HTMLElement;
  labelRow: HTMLElement;
  lock: LockButton | null;
  helpId: string | undefined;
}

/**
 * Row skeleton: [label (+help) … inline control … lock] and an optional body line below.
 * `forId` links the <label> to the main input.
 */
export function shell(def: FieldDef, ctx: FieldCtx, opts: { forId: string; inline?: Node; body?: Node; hintKey?: string; unitInLabel?: boolean }): Shell {
  const help = helpFor(def, opts.hintKey);
  const helpId = help ? uid('help') : undefined;
  const label = h(
    'label',
    { class: 're-label min-w-0 truncate text-[13px] leading-tight text-vellum-dim', for: opts.forId, 'data-tip': help },
    def.label,
    opts.unitInLabel && def.unit ? h('span', { class: 'ml-1.5 text-[11px] text-smoke' }, def.unit) : null,
  );
  const lock = ctx.lockKey ? lockButton(ctx.store, ctx.lockKey, def.label, ctx.inheritLockKey) : null;
  const labelRow = h(
    'div',
    { class: 'flex min-h-7 items-center gap-2' },
    h('div', { class: 'flex min-w-0 flex-1 items-center' }, label),
    opts.inline ?? null,
    lock ? lock.el : h('span', { class: 'w-7 flex-none', 'aria-hidden': 'true' }),
  );
  const el = h(
    'div',
    { class: 're-field px-5 py-1.5', 'data-field': def.key },
    labelRow,
    opts.body ?? null,
    help ? h('span', { id: helpId, class: 'sr-only' }, help) : null,
  );
  return { el, labelRow, lock, helpId };
}
