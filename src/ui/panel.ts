// Left control panel: plate header, plate & symmetry, rosette stack, then param groups generated from PARAMS.
// Every recipe edit made here goes through editRecipe (./edit), which enforces the recipe's symmetry.
// Per-cut sections (rosettes, slide, straight, chucks, mask) edit the cut picked in the Cuts section (AppState.editCut):
// they are shown a view recipe of that cut (layerRecipe) and write through cutPath, resolved on every write.
import { cutNumbers, layerRecipe } from '../engine/layers';
import { getPath, PARAMS, setPath, type ParamDef, type ParamGroup } from '../state/params';
import type { Recipe } from '../state/recipe';
import { CUT_GROUPS, clampEditCut, cutPath, type AppState, type Store } from '../state/store';
import { h, reconcile, roman, uid } from './dom';
import { editRecipe } from './edit';
import { icon } from './icons';
import { HINTS, lockButton, numberListControl, paramControl, switchButton, type Control, type FieldCtx } from './controls';
import { paletteControl } from './palette';
import { autoEndRadiusControl, plateSizeControl, symmetryControl, symmetryReadout } from './plate';
import { cutLabel, cutsSection } from './cuts';
import { rosetteStack } from './rosettes';

type SectionId = 'rosettes' | 'cuts' | ParamGroup;

const SECTIONS: { id: SectionId; title: string; enable?: string; off?: string }[] = [
  { id: 'plate', title: 'Plate & symmetry' },
  { id: 'cuts', title: 'Cuts' },
  { id: 'rosettes', title: 'Rosette stack' },
  { id: 'slide', title: 'Slide rest' },
  { id: 'ink', title: 'Ink & paper' },
  { id: 'metal', title: 'Metal & light' },
  { id: 'straight', title: 'Straight-line engine', enable: 'straight.enabled', off: 'Disengaged. Cut straight lines instead of rings: pinstripes, waves, Clous de Paris.' },
  { id: 'eccentric', title: 'Eccentric chuck', enable: 'eccentric.enabled', off: 'Disengaged. Set the work off-centre and repeat the cut around a dividing wheel.' },
  { id: 'elliptical', title: 'Elliptical chuck', enable: 'elliptical.enabled', off: 'Disengaged. Draw every ring as an ellipse.' },
  { id: 'mask', title: 'Shape mask', enable: 'mask.enabled', off: 'Off. Change the cut inside a star, flower or cog: deeper, shallower, or with the facets flipped.' },
  { id: 'machine', title: 'Machine' },
];

interface Section {
  id: SectionId;
  el: HTMLElement;
  body: HTMLElement;
  numeral: HTMLElement;
  title: HTMLElement;
  /** "Cut 2" tag beside the title of per-cut sections while the recipe has extra cuts. */
  cutTag: HTMLElement;
  /** Header switch for groups gated by an `*.enabled` param. */
  enable?: { def: ParamDef; set(v: boolean): void; lock: ReturnType<typeof lockButton>; offNote: HTMLElement; wrap: HTMLElement };
}

/** Sections the viewer has opened. All start collapsed; the choice is remembered in this browser only. */
const OPEN_KEY = 're-open-sections';
function readOpen(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
const openSections = readOpen();
function rememberOpen(id: string, open: boolean): void {
  if (open) openSections.add(id);
  else openSections.delete(id);
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...openSections]));
  } catch {
    /* storage blocked: the panel still works, it just forgets */
  }
}

/** The recipe the per-cut sections show: the selected cut as a single-cut recipe. */
export function cutView(r: Recipe, editCut: number): Recipe {
  const cut = clampEditCut(r, editCut);
  return cut === 0 ? r : layerRecipe(r, cut);
}

function section(store: Store, spec: (typeof SECTIONS)[number]): Section {
  const bodyId = uid('sec');
  const numeral = h('span', { class: 'w-7 flex-none font-display text-[13px] italic text-brass-500' });
  const title = h('span', { class: 're-sec-title re-caps text-[11.5px] text-vellum-dim transition-colors' }, spec.title);
  const cutTag = h('span', { class: 're-tag flex-none px-1 py-px text-[9.5px] uppercase leading-none', hidden: true });
  const rule = h('span', { class: 're-hairline-r mx-2 flex-1', 'aria-hidden': 'true' });
  const startOpen = openSections.has(spec.id);
  const body = h('div', { id: bodyId, class: 'pb-3', hidden: !startOpen });
  // Every section collapses from its header; gated (chuck / engine) sections keep their switch beside it.
  const setOpen = (open: boolean) => {
    head.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
    rememberOpen(spec.id, open);
  };
  const head = h(
    'button',
    {
      type: 'button',
      class: `re-sec-head flex w-full items-center gap-2 pb-3 pl-5 pt-4 text-left ${spec.enable ? 'pr-2' : 'pr-5'}`,
      'aria-expanded': String(startOpen),
      'aria-controls': bodyId,
      onClick: () => setOpen(head.getAttribute('aria-expanded') !== 'true'),
    },
    numeral,
    title,
    cutTag,
    rule,
    icon('chevron', 're-sec-chevron size-3.5 flex-none text-smoke'),
  );

  let enable: Section['enable'];
  let headRow: HTMLElement = h('h2', null, head);
  if (spec.enable) {
    const def = PARAMS.find((d) => d.key === spec.enable)!;
    const key = def.key;
    const sw = switchButton(`Engage ${spec.title.toLowerCase()}`, (next) => {
      editRecipe(store, (d) => setPath(d, cutPath(key, store.get().editCut), next));
      // Engaging shows its settings.
      if (next) setOpen(true);
    });
    sw.el.dataset.tip = HINTS[key] ?? def.help ?? '';
    const lock = lockButton(store, () => (store.get().editCut === 0 ? key : null), spec.title);
    const wrap = h('div', { class: 'flex flex-none items-center gap-2 pr-3 pt-1' }, sw.el, lock.el);
    const offNote = h('p', { class: 'px-5 pb-1 text-[12px] leading-snug text-smoke' }, spec.off ?? '');
    headRow = h('div', { class: 'flex items-center' }, h('h2', { class: 'min-w-0 flex-1' }, head), wrap);
    enable = { def, set: sw.set, lock, offNote, wrap };
  }
  const el = h('section', { class: 're-section', 'data-group': spec.id }, headRow, body);
  return { id: spec.id, el, body, numeral, title, cutTag, enable };
}

/** Pseudo-key for the read-only "End radius: auto" line that replaces the slider while Fill to edge is on. */
const AUTO_END = 'slide.endRadius:auto';

const PHASE_CUSTOM_DEF = {
  key: 'slide.phaseCustom',
  label: 'Phase sequence',
  type: 'number' as const,
  unit: '°',
  simple: true,
};

export function isParamVisible(d: ParamDef, s: AppState): boolean {
  const r = s.recipe;
  return (s.uiMode === 'advanced' || d.simple) && (!d.modes || d.modes.includes(r.mode)) && (!d.visible || d.visible(r));
}

export function createPanel(store: Store, drawerHeader: HTMLElement): { el: HTMLElement; update(s: AppState, prev?: AppState): void } {
  // Per-cut controls are updated with the cut's view state, so `read` uses the plain key; writes and lock keys
  // resolve the selected cut when they happen (controls are cached by key and outlive any one cut).
  const perCut = (key: string) => CUT_GROUPS.has(key.split('.', 1)[0]);
  const ctxFor = (key: string): FieldCtx => ({
    store,
    read: (r) => getPath(r, key),
    write: (v, opts) => editRecipe(store, (d) => setPath(d, cutPath(key, store.get().editCut), v), opts),
    lockKey: perCut(key) ? () => (store.get().editCut === 0 ? key : null) : key,
  });

  const controls = new Map<string, Control>();
  const control = (key: string): Control => {
    let c = controls.get(key);
    if (c) return c;
    const def = () => PARAMS.find((d) => d.key === key)!;
    if (key === 'ink.palette') c = paletteControl(store);
    else if (key === 'slide.phaseCustom') c = numberListControl(PHASE_CUSTOM_DEF, ctxFor(key));
    else if (key === 'machine.workDiameter') c = plateSizeControl(def(), store);
    else if (key === 'symmetry.order') c = symmetryControl(def(), store);
    else if (key === AUTO_END) c = autoEndRadiusControl();
    else c = paramControl(def(), ctxFor(key));
    controls.set(key, c);
    return c;
  };

  // Plate header: the recipe's name, engraved in a cartouche.
  const seedLine = h('span', { class: 're-figures' });
  const nameInput = h('input', {
    type: 'text',
    class: 're-plate-name -mx-0.5 mt-1 w-full px-0.5 font-display text-[26px] italic leading-tight text-vellum',
    'aria-label': 'Recipe name',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  nameInput.addEventListener('change', () => {
    const v = nameInput.value.trim() || 'Untitled';
    if (v !== store.get().recipe.name) editRecipe(store, (d) => void (d.name = v));
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      if (e.key === 'Escape') nameInput.value = store.get().recipe.name;
      nameInput.blur();
    }
  });
  const meta = h('p', { class: 're-figures mt-1.5 text-[12px] text-smoke' });
  const symmetry = symmetryReadout();
  const plate = h(
    'div',
    { class: 're-plate px-6 pb-5 pt-5' },
    h(
      'div',
      { class: 'flex items-center gap-2' },
      h('span', { class: 're-caps text-[10px] text-brass-500' }, 'Plate'),
      h('span', { class: 're-hairline-r flex-1' }),
      h('span', { class: 'font-mono text-[10.5px] text-smoke' }, seedLine),
    ),
    nameInput,
    meta,
    symmetry.el,
  );

  const stack = rosetteStack(store);
  const cuts = cutsSection(store);
  const sections = SECTIONS.map((s) => section(store, s));
  sections.find((sec) => sec.id === 'rosettes')!.body.appendChild(stack.el);
  sections.find((sec) => sec.id === 'cuts')!.body.appendChild(cuts.el);

  const kbd = (k: string) => h('kbd', { class: 'rounded-[3px] border border-rule-strong px-1.5 py-px font-mono text-[10.5px] text-brass-300' }, k);
  const colophon = h(
    'footer',
    { class: 're-rule-top mt-2 grid grid-cols-3 gap-x-3 gap-y-2.5 px-5 py-5 text-[11.5px] text-smoke' },
    h('span', { class: 'flex items-center gap-1.5' }, kbd('Space'), 'play'),
    h('span', { class: 'flex items-center gap-1.5' }, kbd('R'), 'random'),
    h('span', { class: 'flex items-center gap-1.5' }, kbd('M'), 'mutate'),
    h('span', { class: 'flex items-center gap-1.5' }, kbd('E'), 'export'),
    h('span', { class: 'flex items-center gap-1.5' }, kbd('⌘Z'), 'undo'),
    h('span', { class: 'flex items-center gap-1.5' }, kbd('⇧⌘Z'), 'redo'),
  );

  const el = h('div', { class: 'flex min-h-full flex-col' }, drawerHeader, plate, ...sections.map((s) => s.el), h('div', { class: 'flex-1' }), colophon);

  return {
    el,
    update(s, prev) {
      if (prev && s.recipe === prev.recipe && s.locks === prev.locks && s.uiMode === prev.uiMode && s.editCut === prev.editCut) return;
      const r = s.recipe;
      const editCut = clampEditCut(r, s.editCut);
      // What the per-cut sections see: the selected cut as a single-cut recipe.
      const vs: AppState = editCut === 0 ? s : { ...s, recipe: cutView(r, editCut) };
      const multi = r.layers.length > 0;

      if (document.activeElement !== nameInput) nameInput.value = r.name;
      seedLine.textContent = r.seed ? `№ ${r.seed}` : 'hand set';
      const cutList = cutNumbers(r);
      const passes = cutList.reduce((a, c) => {
        const x = c === 0 ? r : layerRecipe(r, c);
        return a + x.slide.passes * (x.straight.enabled ? x.straight.crossings : x.eccentric.enabled ? x.eccentric.divisions : 1);
      }, 0);
      const cutsNote = cutList.length > 1 ? ` in ${cutList.length} cuts` : '';
      meta.textContent = `${passes} pass${passes === 1 ? '' : 'es'}${cutsNote} · Ø ${r.machine.workDiameter} mm · ${r.mode === 'ink' ? 'Ink on paper' : 'Engraved metal'}`;
      if (!prev || r !== prev.recipe) symmetry.update(r);

      stack.update(vs);
      cuts.update(s);

      let n = 0;
      for (const sec of sections) {
        const cutSec = CUT_GROUPS.has(sec.id);
        const tag = cutSec && multi ? cutLabel(editCut) : '';
        sec.cutTag.hidden = !tag;
        if (sec.cutTag.textContent !== tag) sec.cutTag.textContent = tag;
        if (sec.id !== 'rosettes' && sec.id !== 'cuts') {
          // Per-cut groups see the selected cut; shared groups the whole recipe.
          const ss = cutSec ? vs : s;
          const rr = ss.recipe;
          const keys: string[] = [];
          for (const d of PARAMS) {
            if (d.group !== sec.id || d.key === sec.enable?.def.key) continue;
            if (!isParamVisible(d, ss)) {
              // Fill to edge hides the End radius slider; say what it is instead of letting it vanish.
              if (d.key === 'slide.endRadius' && rr.machine.fillEdge && isParamVisible({ ...d, visible: undefined }, ss)) keys.push(AUTO_END);
              continue;
            }
            keys.push(d.key);
            if (d.key === 'slide.phaseMode' && rr.slide.phaseMode === 'custom') keys.push('slide.phaseCustom');
            if (d.key === 'ink.colorMode') keys.push('ink.palette');
          }
          const items: Element[] = keys.map((k) => {
            const c = control(k);
            c.update(ss);
            return c.el;
          });
          let show = items.length > 0;
          if (sec.enable) {
            const on = !!getPath(rr, sec.enable.def.key);
            const gateVisible = isParamVisible(sec.enable.def, ss);
            sec.enable.set(on);
            sec.enable.lock.update(ss);
            if (gateVisible && !on) items.push(sec.enable.offNote);
            show = gateVisible || items.length > 0;
          }
          sec.el.hidden = !show;
          reconcile(sec.body, items);
        }
        if (!sec.el.hidden) {
          n += 1;
          sec.numeral.textContent = `${roman(n).toLowerCase()}.`;
        }
      }
    },
  };
}
