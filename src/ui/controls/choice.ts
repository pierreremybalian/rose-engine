// bool (switch), select, color and free-text controls, plus the generic segmented radiogroup.
import { h, uid } from '../dom';
import { icon, type IconName } from '../icons';
import { shell, type Control, type FieldCtx, type FieldDef } from './field';

export function switchButton(label: string, onToggle: (next: boolean) => void, id?: string): { el: HTMLButtonElement; set(v: boolean): void } {
  const el = h('button', {
    id,
    type: 'button',
    role: 'switch',
    class: 're-switch',
    'aria-checked': 'false',
    'aria-label': label,
    onClick: () => onToggle(el.getAttribute('aria-checked') !== 'true'),
  });
  return {
    el,
    set(v) {
      el.setAttribute('aria-checked', String(v));
    },
  };
}

export function boolControl(def: FieldDef, ctx: FieldCtx, hintKey?: string): Control {
  const id = uid('sw');
  const sw = switchButton(def.label, (next) => ctx.write(next), id);
  sw.el.removeAttribute('aria-label'); // the <label for> names it
  const sh = shell(def, ctx, { forId: id, inline: sw.el, hintKey });
  if (sh.helpId) sw.el.setAttribute('aria-describedby', sh.helpId);
  return {
    el: sh.el,
    update(s) {
      sh.lock?.update(s);
      sw.set(!!ctx.read(s.recipe));
    },
  };
}

export function selectControl(def: FieldDef, ctx: FieldCtx, hintKey?: string): Control {
  const id = uid('sel');
  const sel = h(
    'select',
    { id, class: 're-select h-9 w-full pl-3 text-[13px]' },
    (def.options ?? []).map((o) => h('option', { value: o.value }, o.label)),
  );
  sel.addEventListener('change', () => ctx.write(sel.value));
  const sh = shell(def, ctx, { forId: id, body: h('div', { class: 'pb-1 pt-1' }, sel), hintKey });
  if (sh.helpId) sel.setAttribute('aria-describedby', sh.helpId);
  return {
    el: sh.el,
    update(s) {
      sh.lock?.update(s);
      const v = String(ctx.read(s.recipe));
      if (sel.value !== v) sel.value = v;
    },
  };
}

/** Static classes for the metal chips (Tailwind/SCSS need complete strings). */
const METAL_FACE: Record<string, string> = {
  silver: 're-metal re-metal--silver size-7 rounded-full',
  gold: 're-metal re-metal--gold size-7 rounded-full',
  rose: 're-metal re-metal--rose size-7 rounded-full',
  brass: 're-metal re-metal--brass size-7 rounded-full',
  steel: 're-metal re-metal--steel size-7 rounded-full',
  blued: 're-metal re-metal--blued size-7 rounded-full',
};

const METAL_SHORT: Record<string, string> = { silver: 'Silver', gold: 'Gold', rose: 'Rose', brass: 'Brass', steel: 'Steel', blued: 'Blued' };

/** Select rendered as polished-metal swatches (metal.material). */
export function metalControl(def: FieldDef, ctx: FieldCtx): Control {
  const opts = def.options ?? [];
  const seg = segmented({
    label: def.label,
    options: opts.map((o) => ({ value: o.value, label: o.label })),
    onChange: (v) => ctx.write(v),
    groupClass: 'grid grid-cols-6 gap-1.5',
    render: (o) => [h('span', { class: METAL_FACE[o.value] ?? 're-metal size-7 rounded-full' }), h('span', { class: 'text-[10.5px] leading-none tracking-wide' }, METAL_SHORT[o.value] ?? o.label)],
    btnClass: 're-metal-chip flex flex-col items-center gap-1.5 rounded-[3px] px-0.5 py-2 text-smoke aria-checked:text-brass-200 aria-checked:bg-brass-400/10 hover:text-vellum',
    plain: true,
  });
  const name = h('span', { class: 'text-[12px] italic text-brass-300 font-display' });
  const sh = shell(def, ctx, { forId: '', inline: name, body: h('div', { class: 'pt-1.5 pb-1' }, seg.el) });
  sh.el.querySelector('label')?.removeAttribute('for');
  seg.el.setAttribute('aria-label', def.label);
  return {
    el: sh.el,
    update(s) {
      sh.lock?.update(s);
      const v = String(ctx.read(s.recipe));
      seg.set(v);
      name.textContent = opts.find((o) => o.value === v)?.label ?? '';
    },
  };
}

export function colorControl(def: FieldDef, ctx: FieldCtx, hintKey?: string): Control {
  const id = uid('col');
  const input = h('input', { id, type: 'color', class: 're-swatch size-6 flex-none' });
  const hex = h('span', { class: 're-figures w-[4.6rem] text-right font-mono text-[11.5px] uppercase text-smoke', 'aria-hidden': 'true' });
  let picking = false;
  input.addEventListener('input', () => {
    picking = true;
    hex.textContent = input.value;
    ctx.write(input.value, { coalesce: true });
  });
  input.addEventListener('change', () => {
    if (picking) ctx.store.endCoalesce();
    picking = false;
  });
  const inline = h('div', { class: 'flex items-center gap-3' }, hex, input);
  const sh = shell(def, ctx, { forId: id, inline, hintKey });
  if (sh.helpId) input.setAttribute('aria-describedby', sh.helpId);
  return {
    el: sh.el,
    update(s) {
      sh.lock?.update(s);
      const v = String(ctx.read(s.recipe) ?? '#000000').toLowerCase();
      if (input.value.toLowerCase() !== v) input.value = v;
      hex.textContent = v;
    },
  };
}

/** Comma-separated number list (slide.phaseCustom). Commits on Enter / blur. */
export function numberListControl(def: FieldDef, ctx: FieldCtx): Control {
  const id = uid('lst');
  const input = h('input', {
    id,
    type: 'text',
    inputmode: 'decimal',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: '0, 7.5, 15',
    class: 're-input re-figures h-9 w-full px-3 font-mono text-[12.5px]',
  });
  const note = h('p', { class: 'mt-1.5 text-[11.5px] leading-snug text-smoke' });
  const sh = shell(def, ctx, { forId: id, body: h('div', { class: 'pt-1 pb-1' }, input, note), unitInLabel: true });
  if (sh.helpId) input.setAttribute('aria-describedby', sh.helpId);
  let current: number[] = [];

  const parse = (text: string): number[] =>
    text
      .split(/[,;\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n));

  const describe = (vals: number[]) => {
    note.textContent = vals.length ? `${vals.length} step${vals.length === 1 ? '' : 's'}, cycled per pass` : 'Enter at least one value';
  };

  input.addEventListener('input', () => {
    const vals = parse(input.value);
    input.setAttribute('aria-invalid', String(vals.length === 0));
    describe(vals);
  });
  input.addEventListener('change', () => {
    const vals = parse(input.value);
    if (!vals.length) {
      input.value = current.join(', ');
      input.setAttribute('aria-invalid', 'false');
      describe(current);
      return;
    }
    if (vals.join(',') !== current.join(',')) ctx.write(vals);
  });

  return {
    el: sh.el,
    update(s) {
      sh.lock?.update(s);
      const v = (ctx.read(s.recipe) as number[] | undefined) ?? [];
      current = v;
      if (document.activeElement !== input) input.value = v.join(', ');
      describe(v);
    },
  };
}

export interface SegOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  tip?: string;
}

/**
 * Radiogroup of buttons with roving tabindex and arrow-key selection.
 * Class strings must be complete static strings (Tailwind scans them).
 */
export function segmented<T extends string>(opts: {
  label: string;
  options: SegOption<T>[];
  onChange: (v: T) => void;
  btnClass: string;
  groupClass?: string;
  /** true = no .re-seg chrome. */
  plain?: boolean;
  iconOnly?: boolean;
  iconClass?: string;
  render?: (o: SegOption<T>) => Node[];
}): { el: HTMLElement; set(v: T): void; buttons: HTMLButtonElement[] } {
  const group = h('div', {
    role: 'radiogroup',
    'aria-label': opts.label,
    class: opts.plain ? (opts.groupClass ?? '') : `re-seg ${opts.groupClass ?? ''}`,
  });
  const buttons = opts.options.map((o, i) => {
    const b = h(
      'button',
      {
        type: 'button',
        role: 'radio',
        'aria-checked': 'false',
        tabindex: i === 0 ? '0' : '-1',
        class: opts.btnClass,
        'data-value': o.value,
        'data-tip': o.tip ?? (opts.iconOnly ? o.label : undefined),
        'aria-label': opts.iconOnly ? o.label : undefined,
        onClick: () => opts.onChange(o.value),
      },
      ...(opts.render
        ? opts.render(o)
        : [o.icon ? icon(o.icon, opts.iconClass ?? 'size-4') : null, opts.iconOnly ? null : h('span', null, o.label)].filter((n): n is SVGSVGElement | HTMLSpanElement => !!n)),
    );
    return b;
  });
  group.append(...buttons);
  group.addEventListener('keydown', (e) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let n = idx < 0 ? 0 : idx;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (n - 1 + buttons.length) % buttons.length;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (n + 1) % buttons.length;
    else if (e.key === 'Home') n = 0;
    else n = buttons.length - 1;
    buttons[n].focus();
    opts.onChange(opts.options[n].value);
  });
  let cur: string | null = null;
  return {
    el: group,
    buttons,
    set(v) {
      if (v === cur) return;
      cur = v;
      for (const b of buttons) {
        const on = b.dataset.value === v;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }
      // No option matches (e.g. a custom value set elsewhere): keep the group reachable by Tab.
      if (!buttons.some((b) => b.tabIndex === 0) && buttons[0]) buttons[0].tabIndex = 0;
    },
  };
}
