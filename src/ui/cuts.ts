// Cuts section: the base cut plus recipe.layers, made one after another on the same plate. Picking a row sets
// AppState.editCut, which the rosette stack, slide rest, engines, chucks and shape mask then edit.
import { cutDepth, layerRecipe } from '../engine/layers';
import { setPath } from '../state/params';
import { layerFromBase, type Recipe } from '../state/recipe';
import { clampEditCut, cutDepthPath, type AppState, type Store } from '../state/store';
import { h, reconcile } from './dom';
import { editRecipe } from './edit';
import { icon } from './icons';
import { numberControl, switchButton } from './controls';

/** Extra cuts allowed on top of the base cut. */
export const MAX_LAYERS = 4;
const DEPTH_STEP = 0.005;
const MIN_DEPTH = 0.01;

const DEPTH_DEF = {
  key: 'cut.depth',
  label: 'Depth',
  type: 'number' as const,
  unit: 'mm',
  min: MIN_DEPTH,
  max: 0.4,
  step: DEPTH_STEP,
  simple: true,
  help: 'How deep this cut goes. Where cuts cross, the deepest one shows.',
};

export function cutLabel(cut: number): string {
  return `Cut ${cut + 1}`;
}

/** Snap a depth to the slider step, never shallower than MIN_DEPTH. */
export function snapDepth(d: number): number {
  return Math.max(MIN_DEPTH, Number((Math.round(d / DEPTH_STEP) * DEPTH_STEP).toFixed(3)));
}

/** One-line description of a cut: engine, passes, lobes, mask. */
export function cutSummary(r: Recipe, cut: number): string {
  const c = layerRecipe(r, cut);
  const kind = c.straight.enabled ? 'Straight' : c.eccentric.enabled ? 'Eccentric' : c.elliptical.enabled ? 'Elliptical' : 'Rose';
  const lobes = [...new Set(c.rosettes.filter((x) => x.enabled && x.axis === 'rock').map((x) => x.lobes))];
  const parts = [kind, `${c.slide.passes} pass${c.slide.passes === 1 ? '' : 'es'}`];
  if (lobes.length) parts.push(`${lobes.join('/')} lobe${lobes.length === 1 && lobes[0] === 1 ? '' : 's'}`);
  if (c.mask.enabled) parts.push('masked');
  return parts.join(' · ');
}

/**
 * Copy cut `from` as a new extra cut and return the recipe edit plus the new cut's number. `shallower` makes it
 * 0.6× as deep and puts it last ("Add cut"); otherwise it keeps the depth and goes right after its source ("Duplicate").
 */
export function copyCut(r: Recipe, from: number, shallower: boolean): { at: number; edit: (d: Recipe) => void } | null {
  if ((r.layers?.length ?? 0) >= MAX_LAYERS) return null;
  const depth = snapDepth(cutDepth(r, from) * (shallower ? 0.6 : 1));
  const layer = layerFromBase(layerRecipe(r, from), depth);
  const at = shallower ? r.layers.length : Math.min(from, r.layers.length);
  return { at: at + 1, edit: (d) => void d.layers.splice(at, 0, layer) };
}

interface Row {
  el: HTMLElement;
  update(s: AppState, cut: number): void;
}

function createRow(store: Store, layerId: string | null): Row {
  /** This row's cut number right now (rows are cached by layer id; indices move). */
  const cutNow = (): number => (layerId === null ? 0 : store.get().recipe.layers.findIndex((l) => l.id === layerId) + 1);

  const name = h('span', { class: 'font-display text-[15px] italic leading-none text-vellum' });
  const depthFig = h('span', { class: 're-figures ml-auto pr-1 font-mono text-[11px] text-smoke' });
  const summary = h('span', { class: 're-figures mt-1 block truncate text-[11.5px] text-smoke' });
  const pick = h(
    'button',
    {
      type: 'button',
      role: 'radio',
      class: 're-cut-pick flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-2.5 pr-1 text-left',
      onClick: () => {
        const c = cutNow();
        if (c >= 0) store.set({ editCut: c });
      },
    },
    h('span', { class: 're-cut-dot size-2.5 flex-none rounded-full', 'aria-hidden': 'true' }),
    h('span', { class: 'min-w-0 flex-1' }, h('span', { class: 'flex items-baseline gap-2' }, name, depthFig), summary),
  );

  const enable = switchButton('Enable cut', (next) => {
    const c = cutNow();
    if (c >= 1) editRecipe(store, (d) => void (d.layers[c - 1].enabled = next));
  });
  const slot = h('span', { class: 'flex w-11 flex-none items-center justify-center' }, layerId === null ? h('span', { class: 're-tag px-1 py-px text-[9.5px] uppercase leading-none' }, 'Base') : enable.el);

  const dup = h(
    'button',
    {
      type: 'button',
      class: 're-quiet size-8 flex-none',
      onClick: () => {
        const r = store.get().recipe;
        const c = cutNow();
        const copy = c >= 0 ? copyCut(r, c, false) : null;
        if (!copy) return;
        editRecipe(store, copy.edit);
        store.set({ editCut: copy.at });
      },
    },
    icon('copy', 'size-4'),
  );
  const remove = h(
    'button',
    {
      type: 'button',
      class: 're-quiet size-8 flex-none hover:text-garnet',
      onClick: () => {
        const c = cutNow();
        if (c >= 1) editRecipe(store, (d) => void d.layers.splice(c - 1, 1));
      },
    },
    icon('trash', 'size-4'),
  );
  if (layerId === null) remove.classList.add('invisible');

  const el = h('div', { class: 're-cut flex items-center gap-1 pr-1', 'data-cut': layerId ?? 'base' }, pick, slot, dup, remove);

  let last = '';
  return {
    el,
    update(s, cut) {
      const r = s.recipe;
      const selected = s.editCut === cut;
      const on = cut === 0 || !!r.layers[cut - 1]?.enabled;
      const full = r.layers.length >= MAX_LAYERS;
      const label = cutLabel(cut);
      const depthTxt = r.mode === 'metal' ? `${cutDepth(r, cut).toFixed(3)} mm` : '';
      const sig = `${cut}|${selected}|${on}|${full}|${depthTxt}|${cutSummary(r, cut)}`;
      if (sig === last) return;
      last = sig;
      name.textContent = label;
      summary.textContent = cutSummary(r, cut);
      depthFig.textContent = depthTxt;
      pick.setAttribute('aria-checked', String(selected));
      pick.setAttribute('aria-label', `Edit ${label}: ${summary.textContent}${depthTxt ? `, ${depthTxt} deep` : ''}`);
      el.dataset.selected = String(selected);
      el.dataset.enabled = String(on);
      enable.set(on);
      enable.el.setAttribute('aria-label', `Enable ${label}`);
      enable.el.dataset.tip = on ? `Leave out ${label}` : `Cut ${label} again`;
      dup.disabled = full;
      dup.setAttribute('aria-label', `Duplicate ${label}`);
      dup.dataset.tip = full ? `At most ${MAX_LAYERS + 1} cuts` : `Duplicate ${label}`;
      remove.disabled = cut === 0;
      remove.setAttribute('aria-label', `Remove ${label}`);
      remove.dataset.tip = `Remove ${label}`;
    },
  };
}

export function cutsSection(store: Store): { el: HTMLElement; update(s: AppState): void } {
  const list = h('div', { class: 're-cuts mx-4 flex flex-col', role: 'radiogroup', 'aria-label': 'Cut being edited' });
  const add = h(
    'button',
    {
      type: 'button',
      class: 're-socket mx-4 mt-2.5 flex h-10 items-center justify-center gap-2 text-[13px] tracking-wide',
      'data-action': 'add-cut',
      onClick: () => {
        const s = store.get();
        const copy = copyCut(s.recipe, clampEditCut(s.recipe, s.editCut), true);
        if (!copy) return;
        editRecipe(store, copy.edit);
        store.set({ editCut: copy.at });
      },
    },
    icon('plus', 'size-4'),
    'Add cut',
  );
  const depth = numberControl(DEPTH_DEF, {
    store,
    read: (r) => cutDepth(r, clampEditCut(r, store.get().editCut)),
    write: (v, opts) => editRecipe(store, (d) => setPath(d, cutDepthPath(clampEditCut(d, store.get().editCut)), v), opts),
    lockKey: () => (store.get().editCut === 0 ? 'metal.baseDepth' : null),
  });
  const depthWrap = h('div', { class: 'mt-2' }, depth.el);
  const note = h('p', { class: 'px-5 pt-2 text-[12px] leading-snug text-smoke' }, 'Cuts are made in order on the same plate; where they overlap, the deepest wins.');
  const el = h('div', { class: 'flex flex-col pb-2' }, list, add, depthWrap, note);

  const rows = new Map<string, Row>();
  return {
    el,
    update(s) {
      const r = s.recipe;
      const keys = ['base', ...r.layers.map((l) => l.id)];
      for (const k of [...rows.keys()]) if (!keys.includes(k)) rows.delete(k);
      const ordered = keys.map((k) => {
        let row = rows.get(k);
        if (!row) {
          row = createRow(store, k === 'base' ? null : k);
          rows.set(k, row);
        }
        return row;
      });
      reconcile(list, ordered.map((x) => x.el));
      ordered.forEach((row, i) => row.update(s, i));

      const full = r.layers.length >= MAX_LAYERS;
      add.disabled = full;
      add.dataset.tip = full ? `At most ${MAX_LAYERS + 1} cuts` : `Add a shallower copy of ${cutLabel(clampEditCut(r, s.editCut))}`;
      depthWrap.hidden = r.mode !== 'metal';
      if (!depthWrap.hidden) depth.update(s);
    },
  };
}
