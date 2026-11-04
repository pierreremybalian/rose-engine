// Left control panel: plate header, rosette stack, then param groups generated from PARAMS.
import { getPath, PARAMS, setPath, type ParamDef, type ParamGroup } from '../state/params';
import type { AppState, Store } from '../state/store';
import { h, reconcile, roman, uid } from './dom';
import { icon } from './icons';
import { HINTS, lockButton, numberListControl, paramControl, switchButton, type Control, type FieldCtx } from './controls';
import { paletteControl } from './palette';
import { rosetteStack } from './rosettes';

type SectionId = 'rosettes' | ParamGroup;

const SECTIONS: { id: SectionId; title: string; enable?: string; off?: string }[] = [
  { id: 'rosettes', title: 'Rosette stack' },
  { id: 'slide', title: 'Slide rest' },
  { id: 'ink', title: 'Ink & paper' },
  { id: 'metal', title: 'Metal & light' },
  { id: 'eccentric', title: 'Eccentric chuck', enable: 'eccentric.enabled', off: 'Disengaged. Set the work off-centre and repeat the cut around a dividing wheel.' },
  { id: 'elliptical', title: 'Elliptical chuck', enable: 'elliptical.enabled', off: 'Disengaged. Draw every ring as an ellipse.' },
  { id: 'machine', title: 'Machine' },
];

interface Section {
  id: SectionId;
  el: HTMLElement;
  body: HTMLElement;
  numeral: HTMLElement;
  /** Header switch for groups gated by an `*.enabled` param. */
  enable?: { def: ParamDef; set(v: boolean): void; lock: ReturnType<typeof lockButton>; offNote: HTMLElement; wrap: HTMLElement };
}

function section(store: Store, spec: (typeof SECTIONS)[number]): Section {
  const bodyId = uid('sec');
  const numeral = h('span', { class: 'w-7 flex-none font-display text-[13px] italic text-brass-500' });
  const title = h('span', { class: 're-sec-title re-caps text-[11.5px] text-vellum-dim transition-colors' }, spec.title);
  const rule = h('span', { class: 're-hairline-r mx-2 flex-1', 'aria-hidden': 'true' });
  const body = h('div', { id: bodyId, class: 'pb-3' });
  // Plain groups collapse; chuck groups are gated by their switch instead.
  const head = spec.enable
    ? h('div', { class: 'flex min-w-0 items-center gap-2 pb-3 pl-5 pr-2 pt-4' }, numeral, title, rule)
    : h(
        'button',
        {
          type: 'button',
          class: 're-sec-head flex w-full items-center gap-2 pb-3 pl-5 pr-5 pt-4 text-left',
          'aria-expanded': 'true',
          'aria-controls': bodyId,
          onClick: () => {
            const open = head.getAttribute('aria-expanded') !== 'true';
            head.setAttribute('aria-expanded', String(open));
            body.hidden = !open;
          },
        },
        numeral,
        title,
        rule,
        icon('chevron', 're-sec-chevron size-3.5 flex-none text-smoke'),
      );

  let enable: Section['enable'];
  let headRow: HTMLElement = h('h2', null, head);
  if (spec.enable) {
    const def = PARAMS.find((d) => d.key === spec.enable)!;
    const key = def.key;
    const sw = switchButton(`Engage ${spec.title.toLowerCase()}`, (next) => store.setRecipe((d) => setPath(d, key, next)));
    sw.el.dataset.tip = HINTS[key] ?? def.help ?? '';
    const lock = lockButton(store, key, spec.title);
    const wrap = h('div', { class: 'flex flex-none items-center gap-2 pr-3 pt-1' }, sw.el, lock.el);
    const offNote = h('p', { class: 'px-5 pb-1 text-[12px] leading-snug text-smoke' }, spec.off ?? '');
    headRow = h('div', { class: 'flex items-center' }, h('h2', { class: 'min-w-0 flex-1' }, head), wrap);
    enable = { def, set: sw.set, lock, offNote, wrap };
  }
  const el = h('section', { class: 're-section', 'data-group': spec.id }, headRow, body);
  return { id: spec.id, el, body, numeral, enable };
}

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
  const ctxFor = (key: string): FieldCtx => ({
    store,
    read: (r) => getPath(r, key),
    write: (v, opts) => store.setRecipe((d) => setPath(d, key, v), opts),
    lockKey: key,
  });

  const controls = new Map<string, Control>();
  const control = (key: string): Control => {
    let c = controls.get(key);
    if (c) return c;
    if (key === 'ink.palette') c = paletteControl(store);
    else if (key === 'slide.phaseCustom') c = numberListControl(PHASE_CUSTOM_DEF, ctxFor(key));
    else c = paramControl(PARAMS.find((d) => d.key === key)!, ctxFor(key));
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
    if (v !== store.get().recipe.name) store.setRecipe((d) => void (d.name = v));
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      if (e.key === 'Escape') nameInput.value = store.get().recipe.name;
      nameInput.blur();
    }
  });
  const meta = h('p', { class: 're-figures mt-1.5 text-[12px] text-smoke' });
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
  );

  const stack = rosetteStack(store);
  const sections = SECTIONS.map((s) => section(store, s));
  sections[0].body.appendChild(stack.el);

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
      if (prev && s.recipe === prev.recipe && s.locks === prev.locks && s.uiMode === prev.uiMode) return;
      const r = s.recipe;

      if (document.activeElement !== nameInput) nameInput.value = r.name;
      seedLine.textContent = r.seed ? `№ ${r.seed}` : 'hand set';
      const passes = r.slide.passes * (r.eccentric.enabled ? r.eccentric.divisions : 1);
      meta.textContent = `${passes} pass${passes === 1 ? '' : 'es'} · Ø ${r.machine.workDiameter} mm · ${r.mode === 'ink' ? 'Ink on paper' : 'Engraved metal'}`;

      stack.update(s);

      let n = 0;
      for (const sec of sections) {
        if (sec.id !== 'rosettes') {
          const keys: string[] = [];
          for (const d of PARAMS) {
            if (d.group !== sec.id || d.key === sec.enable?.def.key || !isParamVisible(d, s)) continue;
            keys.push(d.key);
            if (d.key === 'slide.phaseMode' && r.slide.phaseMode === 'custom') keys.push('slide.phaseCustom');
            if (d.key === 'ink.colorMode') keys.push('ink.palette');
          }
          const items: Element[] = keys.map((k) => {
            const c = control(k);
            c.update(s);
            return c.el;
          });
          let show = items.length > 0;
          if (sec.enable) {
            const on = !!getPath(r, sec.enable.def.key);
            const gateVisible = isParamVisible(sec.enable.def, s);
            sec.enable.set(on);
            sec.enable.lock.update(s);
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
