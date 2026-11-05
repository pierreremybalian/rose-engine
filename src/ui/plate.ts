// Plate section controls: plate size (rescales the whole design), symmetry order chips, the read-only
// "End radius: auto" line shown while Fill to edge is on, and the symmetry readout for the plate cartouche.
import { effectiveEndRadius } from '../engine/plate';
import { analyzeSymmetry, type SymmetryInfo } from '../engine/symmetry';
import type { ParamDef } from '../state/params';
import type { Recipe } from '../state/recipe';
import { scaleRecipe } from '../state/scale';
import type { AppState, Store } from '../state/store';
import { h, uid } from './dom';
import { numberControl, segmented, shell, type Control, type FieldCtx } from './controls';
import { editRecipe, type EditOpts } from './edit';

/** Quick picks for the plate diameter, mm. */
export const PLATE_SIZES: { d: number; kind: string }[] = [
  { d: 32, kind: 'Watch' },
  { d: 38, kind: 'Watch' },
  { d: 42, kind: 'Watch' },
  { d: 50, kind: 'Pocket' },
  { d: 100, kind: 'Plate' },
];

/** Quick picks for the symmetry order (0 = free). */
export const SYMMETRY_ORDERS = [0, 4, 6, 8, 12, 24];

const ORDER_MAX = 96;

/**
 * Plate size: slider + number box + quick-pick chips. Every change rescales the design with
 * scaleRecipe(recipe, newD / oldD) so it keeps its look. A run of consecutive size edits (a slider drag,
 * or chip after chip) always scales from the recipe the run started from, so clamping never accumulates
 * and 100 → 32 → 100 returns exactly the original.
 */
export function plateSizeControl(def: ParamDef, store: Store): Control {
  let anchor: Recipe | null = null;
  let lastOut: Recipe | null = null;

  const resize = (d: number, opts?: EditOpts) => {
    const cur = store.get().recipe;
    if (!Number.isFinite(d) || d <= 0 || d === cur.machine.workDiameter) return;
    if (!anchor || cur !== lastOut) anchor = cur;
    const from = anchor.machine.workDiameter;
    const scaled = d === from ? anchor : scaleRecipe(anchor, d / from);
    // Keep the diameter exact (no k-multiplication round-off).
    const next = scaled.machine.workDiameter === d ? scaled : { ...scaled, machine: { ...scaled.machine, workDiameter: d } };
    editRecipe(store, next, opts);
    lastOut = store.get().recipe;
  };

  const ctx: FieldCtx = {
    store,
    read: (r) => r.machine.workDiameter,
    write: (v, opts) => resize(Number(v), opts),
    // The workpiece itself: Random never changes it, so it has no lock.
    lockKey: null,
  };
  const base = numberControl({ ...def, help: `${def.help ?? ''} Changing it rescales the whole design to match.`.trim() }, ctx);

  const chips = segmented<string>({
    label: 'Plate size presets',
    options: PLATE_SIZES.map((s) => ({ value: String(s.d), label: `${s.kind}, ${s.d} mm` })),
    onChange: (v) => resize(Number(v)),
    plain: true,
    groupClass: 'grid grid-cols-5 gap-1.5',
    btnClass: 're-size-chip flex min-w-0 flex-col items-center gap-[5px] px-0.5 pb-[7px] pt-2',
    render: (o) => {
      const s = PLATE_SIZES.find((x) => String(x.d) === o.value)!;
      return [
        h('span', { class: 're-figures font-display text-[16px] leading-none' }, String(s.d)),
        h('span', { class: 're-size-kind text-[9px] uppercase leading-none tracking-[0.16em]' }, s.kind),
      ];
    },
  });
  chips.buttons.forEach((b, i) => b.setAttribute('aria-label', `${PLATE_SIZES[i].kind}, ${PLATE_SIZES[i].d} mm`));
  base.el.append(h('div', { class: 'pb-1 pt-2' }, chips.el));

  return {
    el: base.el,
    update(s) {
      base.update(s);
      chips.set(String(s.recipe.machine.workDiameter));
    },
  };
}

/**
 * Symmetry order: Free / 4 / 6 / 8 / 12 / 24 chips (a radiogroup) plus a custom N box.
 * Writes go through editRecipe, so the new order is enforced at once. Free also clears Mirror
 * (Mirror is only offered from order 2 up, so it must not linger as a hidden constraint).
 */
export function symmetryControl(def: ParamDef, store: Store): Control {
  const setOrder = (n: number) => {
    const r = store.get().recipe;
    if (n === r.symmetry.order) return;
    editRecipe(store, (d) => {
      d.symmetry.order = n;
      if (n < 2) d.symmetry.mirror = false;
    });
  };

  const seg = segmented<string>({
    label: 'Symmetry',
    options: SYMMETRY_ORDERS.map((n) => ({ value: String(n), label: n ? String(n) : 'Free' })),
    onChange: (v) => setOrder(Number(v)),
    groupClass: 'min-w-0 flex-1',
    btnClass: 'h-8 min-w-0 flex-1 px-0.5 text-[12px]',
  });
  seg.buttons.forEach((b, i) => {
    const n = SYMMETRY_ORDERS[i];
    b.setAttribute('aria-label', n ? `${n}-fold` : 'Free (no symmetry)');
    b.dataset.tip = n ? `${n}-fold: lobe counts snap to multiples of ${n}` : 'Free: no symmetry constraint';
  });

  const customId = uid('sym');
  const custom = h('input', {
    id: customId,
    type: 'number',
    inputmode: 'numeric',
    min: 2,
    max: ORDER_MAX,
    step: 1,
    placeholder: 'Other',
    class:
      're-figures w-full min-w-0 bg-transparent py-1 pl-2 pr-1 text-right font-mono text-[12px] text-vellum placeholder:font-display placeholder:text-[13px] placeholder:italic placeholder:text-smoke',
    'aria-label': 'Custom symmetry order',
  });
  const customBox = h('div', { class: 're-numbox flex h-8 w-[4.6rem] flex-none items-center pr-2', 'data-active': 'false' }, custom);

  let current = Number.NaN;
  const showCustom = (n: number) => {
    const isCustom = n >= 2 && !SYMMETRY_ORDERS.includes(n);
    customBox.dataset.active = String(isCustom);
    if (document.activeElement !== custom) custom.value = isCustom ? String(n) : '';
  };
  custom.addEventListener('change', () => {
    const raw = parseFloat(custom.value);
    if (!Number.isFinite(raw)) {
      showCustom(current);
      return;
    }
    let n = Math.max(0, Math.min(ORDER_MAX, Math.round(raw)));
    if (n < 2) n = 0;
    setOrder(n);
    showCustom(store.get().recipe.symmetry.order);
  });
  custom.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      showCustom(current);
      custom.blur();
    }
  });

  const ctx: FieldCtx = {
    store,
    read: (r) => r.symmetry.order,
    write: (v) => setOrder(Number(v)),
    lockKey: def.key,
  };
  const body = h('div', { class: 'flex items-center gap-3 pb-1 pt-1' }, seg.el, customBox);
  const sh = shell(def, ctx, { forId: '', body });
  sh.el.querySelector('label')?.removeAttribute('for');
  if (sh.helpId) {
    seg.el.setAttribute('aria-describedby', sh.helpId);
    custom.setAttribute('aria-describedby', sh.helpId);
  }

  return {
    el: sh.el,
    update(s) {
      sh.lock?.update(s);
      const n = s.recipe.symmetry.order;
      seg.set(String(n));
      if (n === current) return;
      current = n;
      showCustom(n);
    },
  };
}

/** Read-only stand-in for the End radius slider while Fill to edge is on. */
export function autoEndRadiusControl(): Control {
  const value = h('span', { class: 're-figures font-mono text-[11.5px] text-vellum-dim' });
  const tip = 'Fill to edge is on: the last pass runs past the rim, so the end radius is set for you. Turn Fill to edge off to set it by hand.';
  const el = h(
    'div',
    { class: 're-field px-5 py-1.5', 'data-field': 'slide.endRadius:auto' },
    h(
      'p',
      { class: 're-auto flex min-h-9 items-center gap-2 px-3 py-1.5' },
      h('span', { class: 're-label flex-none text-[13px] leading-tight text-vellum-dim', 'data-tip': tip }, 'End radius', h('span', { class: 'sr-only' }, ': ')),
      h(
        'span',
        { class: 'min-w-0 flex-1 truncate text-right text-[12px] text-smoke' },
        h('span', { class: 'font-display text-[13px] italic text-brass-300' }, 'auto'),
        ' · reaches rim (',
        value,
        ')',
      ),
    ),
  );
  let last = '';
  return {
    el,
    update(s: AppState) {
      const txt = `${effectiveEndRadius(s.recipe).toFixed(1)} mm`;
      if (txt === last) return;
      last = txt;
      value.textContent = txt;
    },
  };
}

export function symmetryText(info: SymmetryInfo): string {
  // Plain circles (no active rosettes) are symmetric under every rotation: analyzeSymmetry reports Infinity.
  if (!Number.isFinite(info.order)) return 'circular';
  const rot = info.order >= 2 ? `${info.order}-fold` : '';
  if (rot) return info.mirror ? `${rot} · mirror` : rot;
  return info.mirror ? 'mirror only' : 'no symmetry';
}

/** Live readout of the pattern's actual symmetry (analyzeSymmetry), for the plate cartouche. */
export function symmetryReadout(): { el: HTMLElement; update(r: Recipe): void } {
  const value = h('span', { class: 'font-display text-[13.5px] italic leading-none text-brass-300', 'data-readout': 'symmetry' });
  const el = h(
    'p',
    { class: 'mt-1.5 flex items-baseline gap-2', 'data-tip': 'The symmetry the pattern actually has, whatever the setting below.' },
    h('span', { class: 're-caps text-[9.5px] text-brass-500' }, 'Symmetry'),
    value,
  );
  let last = '';
  return {
    el,
    update(r) {
      const txt = symmetryText(analyzeSymmetry(r));
      if (txt === last) return;
      last = txt;
      value.textContent = txt;
    },
  };
}
