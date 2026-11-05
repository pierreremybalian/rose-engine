// Ink palette: preset proofs (set palette + paper) and editable individual inks.
import { PALETTES } from '../state/params';
import type { AppState, Store } from '../state/store';
import { h, uid } from './dom';
import { editRecipe } from './edit';
import { icon } from './icons';
import { HINTS, lockButton, type Control } from './controls';

const NS = 'http://www.w3.org/2000/svg';
const MAX_INKS = 8;

/** A tiny proof: one wavy engraved line per ink on the palette's paper. */
function proof(colors: string[], paper: string): SVGSVGElement {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 80 26');
  s.setAttribute('preserveAspectRatio', 'none');
  s.setAttribute('class', 're-chip-proof block h-7 w-full rounded-[2px]');
  s.setAttribute('aria-hidden', 'true');
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', '80');
  bg.setAttribute('height', '26');
  bg.setAttribute('fill', paper);
  s.appendChild(bg);
  const n = colors.length;
  colors.forEach((c, i) => {
    for (let k = 0; k < 2; k++) {
      const y0 = 5 + ((i * 2 + k) * 16) / Math.max(1, n * 2 - 1);
      let d = '';
      for (let x = 0; x <= 80; x += 2) {
        const y = y0 + 1.6 * Math.sin((x / 80) * Math.PI * 6 + i * 1.3 + k * Math.PI);
        d += `${x === 0 ? 'M' : 'L'}${x} ${y.toFixed(2)}`;
      }
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', c);
      p.setAttribute('stroke-width', '1.1');
      s.appendChild(p);
    }
  });
  return s;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function paletteControl(store: Store): Control {
  const lock = lockButton(store, 'ink.palette', 'Palette');
  const current = h('span', { class: 'ml-2 truncate font-display text-[12.5px] italic text-brass-300' });
  const labelRow = h(
    'div',
    { class: 'flex min-h-7 items-center gap-2' },
    h('div', { class: 'flex min-w-0 flex-1 items-baseline' }, h('span', { class: 're-label text-[13px] text-vellum-dim', 'data-tip': HINTS['ink.palette'] }, 'Palette'), current),
    lock.el,
  );

  const chips = PALETTES.map((p) =>
    h(
      'button',
      {
        type: 'button',
        class: 're-chip flex flex-col gap-1.5 p-1.5 text-left',
        'aria-pressed': 'false',
        'aria-label': `${p.name} palette`,
        onClick: () =>
          editRecipe(store, (d) => {
            d.ink.palette = [...p.colors];
            d.ink.paper = p.paper;
          }),
      },
      proof(p.colors, p.paper),
      h('span', { class: 'px-0.5 text-[11px] leading-none text-vellum-dim' }, p.name),
    ),
  );
  const grid = h('div', { class: 'mt-1.5 grid grid-cols-3 gap-2', role: 'group', 'aria-label': 'Palettes' }, chips);

  const inks = h('div', { class: 'flex flex-wrap items-center gap-x-3.5 gap-y-3', role: 'group', 'aria-label': 'Inks' });
  const inkRow = h(
    'div',
    { class: 'mt-3 flex items-center gap-3' },
    h('span', { class: 'w-9 flex-none text-[11px] uppercase tracking-[0.16em] text-smoke' }, 'Inks'),
    inks,
  );

  const el = h('div', { class: 're-field px-5 pb-3 pt-1.5', 'data-field': 'ink.palette' }, labelRow, grid, inkRow);

  let renderedLen = -1;
  let inputs: HTMLInputElement[] = [];
  let picking = false;

  function buildInks(palette: string[]) {
    const hadFocusAdd = document.activeElement?.hasAttribute('data-add-ink') ?? false;
    inks.replaceChildren();
    inputs = palette.map((c, i) => {
      const id = uid('ink');
      const input = h('input', { id, type: 'color', value: c, class: 're-swatch size-7', 'aria-label': `Ink ${i + 1}` });
      input.addEventListener('input', () => {
        picking = true;
        editRecipe(
          store,
          (d) => {
            d.ink.palette[i] = input.value;
          },
          { coalesce: true },
        );
      });
      input.addEventListener('change', () => {
        if (picking) store.endCoalesce();
        picking = false;
      });
      const wrap = h('div', { class: 'group/ink relative' }, input);
      if (palette.length > 1) {
        wrap.appendChild(
          h(
            'button',
            {
              type: 'button',
              class: 'absolute -right-2.5 -top-2.5 grid size-5 place-items-center rounded-full bg-ink-800 text-smoke opacity-0 ring-1 ring-rule-strong transition hover:text-garnet focus-visible:text-garnet focus-visible:opacity-100 group-hover/ink:opacity-100 [@media(hover:none)]:opacity-100',
              'aria-label': `Remove ink ${i + 1}`,
              'data-tip': 'Remove ink',
              onClick: () =>
                editRecipe(store, (d) => {
                  d.ink.palette.splice(i, 1);
                }),
            },
            icon('close', 'size-2.5'),
          ),
        );
      }
      inks.appendChild(wrap);
      return input;
    });
    if (palette.length < MAX_INKS) {
      const add = h(
        'button',
        {
          type: 'button',
          class: 're-ghost size-7 rounded-full',
          'aria-label': 'Add ink',
          'data-tip': 'Add ink',
          'data-add-ink': true,
          onClick: () =>
            editRecipe(store, (d) => {
              const pool = PALETTES.flatMap((p) => p.colors);
              const next = pool.find((c) => !d.ink.palette.some((x) => same(x, c))) ?? '#888888';
              d.ink.palette.push(next);
            }),
        },
        icon('plus', 'size-3.5'),
      );
      inks.appendChild(add);
      if (hadFocusAdd) add.focus();
    }
    renderedLen = palette.length;
  }

  return {
    el,
    update(s: AppState) {
      lock.update(s);
      const { palette, paper } = s.recipe.ink;
      if (palette.length !== renderedLen) buildInks(palette);
      palette.forEach((c, i) => {
        const inp = inputs[i];
        if (inp && !same(inp.value, c)) inp.value = c.toLowerCase();
      });
      let match = '';
      PALETTES.forEach((p, i) => {
        const on = same(p.paper, paper) && p.colors.length === palette.length && p.colors.every((c, k) => same(c, palette[k]));
        chips[i].setAttribute('aria-pressed', String(on));
        if (on) match = p.name;
      });
      current.textContent = match || 'Custom';
    },
  };
}
