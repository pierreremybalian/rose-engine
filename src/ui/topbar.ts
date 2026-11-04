// Top bar (wordmark, mode, Random/Mutate, history, presets, layout, detail level, share, export)
// plus the drawer header that carries the view controls on narrow screens.
import type { Mode } from '../state/recipe';
import type { AppState, Layout, Store, UiMode } from '../state/store';
import { h, roman } from './dom';
import { emblem } from './emblem';
import { icon } from './icons';
import { segmented } from './controls';
import { attempt, type Toaster } from './overlays';
import type { UIDeps } from './types';

export interface TopbarHooks {
  openExport(): void;
  toggleDrawer(open?: boolean): void;
  toaster: Toaster;
}

interface ViewControls {
  mode: ReturnType<typeof segmented<Mode>>;
  layout: ReturnType<typeof segmented<Layout>>;
  ui: ReturnType<typeof segmented<UiMode>>;
  update(s: AppState): void;
}

function viewControls(store: Store, size: 'bar' | 'drawer'): ViewControls {
  const bar = size === 'bar';
  const setMode = (m: Mode) => {
    if (store.get().recipe.mode !== m) store.setRecipe((d) => void (d.mode = m));
  };
  const mode = segmented<Mode>({
    label: 'Finish',
    options: [
      { value: 'ink', label: 'Ink', icon: 'ink', tip: 'Coloured pen on paper' },
      { value: 'metal', label: 'Metal', icon: 'metal', tip: 'Engraved guilloché on metal' },
    ],
    onChange: setMode,
    btnClass: bar ? 'h-8 px-3 text-[12.5px]' : 'h-10 flex-1 px-3 text-[13px]',
    groupClass: bar ? '' : 'w-full',
    iconClass: bar ? 'hidden size-3.5 wide:block' : 'size-3.5',
  });
  const layout = segmented<Layout>({
    label: 'Layout',
    options: [
      { value: 'split', label: 'Split: machine and work', icon: 'split' },
      { value: 'machine', label: 'Machine only', icon: 'machine' },
      { value: 'work', label: 'Work only', icon: 'work' },
    ],
    onChange: (v) => store.set({ layout: v }),
    btnClass: bar ? 'size-8' : 'h-10 flex-1',
    groupClass: bar ? '' : 'w-full',
    iconOnly: true,
    iconClass: 'size-4',
  });
  const ui = segmented<UiMode>({
    label: 'Detail',
    options: [
      { value: 'simple', label: 'Simple', tip: 'The essential controls' },
      { value: 'advanced', label: 'Advanced', tip: 'Every control the machine has' },
    ],
    onChange: (v) => store.set({ uiMode: v }),
    btnClass: bar ? 'h-8 px-3 text-[12.5px]' : 'h-10 flex-1 px-3 text-[13px]',
    groupClass: bar ? '' : 'w-full',
  });
  return {
    mode,
    layout,
    ui,
    update(s) {
      mode.set(s.recipe.mode);
      layout.set(s.layout);
      ui.set(s.uiMode);
    },
  };
}

/** Dropdown menu of built-in presets. */
function presetsMenu(deps: UIDeps, toaster: Toaster) {
  const menuId = 're-presets-menu';
  const btn = h(
    'button',
    {
      type: 'button',
      class: 're-ghost h-9 px-3 text-[13px]',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      'aria-controls': menuId,
      'data-action': 'presets',
      disabled: deps.presets.length === 0,
    },
    icon('presets', 'size-4'),
    h('span', { class: 'hidden wide:inline' }, 'Presets'),
    icon('chevron', 'size-3 opacity-60'),
  );
  btn.setAttribute('aria-label', 'Presets');
  const items = deps.presets.map((p, i) =>
    h(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        tabindex: '-1',
        class: 'flex w-full items-baseline gap-3 rounded-[3px] px-3 py-2.5 text-left text-[13.5px] text-vellum-dim',
        'data-preset': p.id,
        onClick: () => {
          close(true);
          void attempt(toaster, () => deps.loadPreset(p.id), `Loaded “${p.name}”`);
        },
      },
      h('span', { class: 'w-6 flex-none font-display text-[12px] italic text-brass-500' }, `${roman(i + 1).toLowerCase()}.`),
      h('span', { class: 'truncate' }, p.name),
    ),
  );
  const menu = h(
    'div',
    { id: menuId, role: 'menu', 'aria-label': 'Presets', class: 're-menu re-scroll absolute left-0 top-full z-50 mt-2 max-h-[65vh] w-64 overflow-y-auto p-1.5', hidden: true },
    h('p', { class: 're-caps px-3 pb-1.5 pt-2 text-[9.5px] text-brass-500' }, 'Pattern book'),
    items,
  );
  const el = h('div', { class: 'relative hidden desk:block' }, btn, menu);

  function open() {
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    items[0]?.focus();
    document.addEventListener('pointerdown', outside, true);
  }
  function close(refocus = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    if (refocus) btn.focus();
  }
  function outside(e: PointerEvent) {
    if (!el.contains(e.target as Node)) close();
  }
  btn.addEventListener('click', () => (menu.hidden ? open() : close()));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && menu.hidden) {
      e.preventDefault();
      open();
    }
  });
  menu.addEventListener('keydown', (e) => {
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    let n = -1;
    if (e.key === 'ArrowDown') n = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') n = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = items.length - 1;
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    } else if (e.key === 'Tab') {
      close();
      return;
    }
    if (n >= 0) {
      e.preventDefault();
      items[n].focus();
    }
  });
  return { el, close, isOpen: () => !menu.hidden };
}

export function createTopbar(store: Store, deps: UIDeps, hooks: TopbarHooks) {
  const { toaster } = hooks;
  const vc = viewControls(store, 'bar');

  const burger = h(
    'button',
    {
      type: 'button',
      class: 're-quiet size-9 flex-none desk:hidden',
      'aria-label': 'Open controls',
      'aria-controls': 're-panel',
      'aria-expanded': 'false',
      'data-action': 'drawer',
      onClick: () => hooks.toggleDrawer(),
    },
    icon('menu', 'size-5'),
  );

  const wordmark = h(
    'div',
    { class: 'flex flex-none items-center gap-2.5 pr-1' },
    emblem(30, 'flex-none text-brass-400'),
    h(
      'div',
      { class: 'hidden flex-col leading-none sm:flex desk:hidden xl:flex' },
      h('span', { class: 'font-display text-[21px] font-medium italic tracking-[0.01em] text-vellum' }, 'Rose Engine'),
      h('span', { class: 're-caps mt-1 hidden text-[8px] tracking-[0.17em] text-brass-500 xl:block' }, 'Guilloché workshop'),
    ),
  );

  const random = h(
    'button',
    {
      type: 'button',
      class: 're-brass h-9 rounded-r-[3px] px-3 text-[13px] sm:rounded-r-none desk:rounded-r-[3px] roomy:rounded-r-none',
      'data-action': 'random',
      'data-tip': 'New pattern from a random family',
      'data-kbd': 'R',
      'aria-label': 'Random pattern',
      onClick: () => void attempt(toaster, () => deps.random()),
    },
    icon('random', 'size-4'),
    h('span', { class: 'hidden sm:inline desk:hidden roomy:inline' }, 'Random'),
  );
  const seedText = h('span', { class: 're-figures font-mono text-[11.5px] leading-none text-vellum-dim' });
  const seed = h(
    'button',
    {
      type: 'button',
      class: 're-ghost hidden h-9 min-w-[4.5rem] flex-col items-start gap-1 rounded-l-none border-l-0 px-2.5 sm:inline-flex desk:hidden roomy:inline-flex',
      'data-action': 'copy-seed',
    },
    h('span', { class: 're-caps text-[7.5px] leading-none text-brass-500' }, 'Seed'),
    seedText,
  );
  seed.addEventListener('click', () => {
    const s = store.get().recipe.seed;
    if (!s) return;
    void attempt(
      toaster,
      async () => {
        if (!navigator.clipboard) throw new Error('Clipboard is not available here');
        await navigator.clipboard.writeText(String(s));
      },
      `Seed ${s} copied`,
    );
  });

  const mutate = h(
    'button',
    {
      type: 'button',
      class: 're-ghost h-9 px-2.5 text-[13px] wide:px-3',
      'data-action': 'mutate',
      'data-tip': 'Nudge the unlocked settings',
      'data-kbd': 'M',
      'aria-label': 'Mutate',
      onClick: () => void attempt(toaster, () => deps.mutate()),
    },
    icon('mutate', 'size-4'),
    h('span', { class: 'hidden wide:inline' }, 'Mutate'),
  );

  const undo = h(
    'button',
    { type: 'button', class: 're-ghost size-9', 'aria-label': 'Undo', 'data-tip': 'Undo', 'data-kbd': '⌘Z', 'data-action': 'undo', onClick: () => store.undo() },
    icon('undo', 'size-4'),
  );
  const redo = h(
    'button',
    { type: 'button', class: 're-ghost size-9', 'aria-label': 'Redo', 'data-tip': 'Redo', 'data-kbd': '⇧⌘Z', 'data-action': 'redo', onClick: () => store.redo() },
    icon('redo', 'size-4'),
  );
  const history = h('div', { class: 'flex items-center gap-1' }, undo, redo);

  const presets = presetsMenu(deps, toaster);

  const share = h(
    'button',
    {
      type: 'button',
      class: 're-ghost hidden h-9 px-2.5 text-[13px] desk:inline-flex wide:px-3',
      'data-action': 'share',
      'data-tip': 'Copy a link to this pattern',
      'aria-label': 'Share link',
      onClick: () => void attempt(toaster, () => deps.share(), 'Link copied'),
    },
    icon('share', 'size-4'),
    h('span', { class: 'hidden wide:inline' }, 'Share'),
  );
  const exportBtn = h(
    'button',
    {
      type: 'button',
      class: 're-brass h-9 px-2.5 text-[13px] sm:px-3.5 desk:px-2.5 roomy:px-3.5',
      'data-action': 'export',
      'data-tip': 'SVG, PNG, G-code or preset',
      'data-kbd': 'E',
      'aria-label': 'Export',
      onClick: () => hooks.openExport(),
    },
    icon('export', 'size-4'),
    h('span', { class: 'hidden sm:inline desk:hidden roomy:inline' }, 'Export'),
  );

  const sep = () => h('span', { class: 'mx-1 hidden h-6 w-px flex-none bg-rule desk:block wide:mx-0.5', 'aria-hidden': 'true' });

  const el = h(
    'header',
    { class: 're-topbar relative z-30 flex h-14 items-center gap-1.5 px-2.5 sm:gap-2 desk:gap-2.5 desk:px-4 wide:gap-2' },
    burger,
    wordmark,
    sep(),
    h('div', { class: 'hidden desk:block' }, vc.mode.el),
    h('div', { class: 'min-w-2 flex-1' }),
    h('div', { class: 'flex items-stretch' }, random, seed),
    mutate,
    sep(),
    history,
    presets.el,
    h('div', { class: 'hidden min-w-2 flex-1 desk:block' }),
    h('div', { class: 'hidden desk:block' }, vc.layout.el),
    h('div', { class: 'hidden desk:block' }, vc.ui.el),
    sep(),
    share,
    exportBtn,
  );

  return {
    el,
    closeMenus: () => {
      if (!presets.isOpen()) return false;
      presets.close(true);
      return true;
    },
    setDrawerOpen(open: boolean) {
      burger.setAttribute('aria-expanded', String(open));
    },
    update(s: AppState) {
      vc.update(s);
      undo.disabled = !store.canUndo();
      redo.disabled = !store.canRedo();
      const sd = s.recipe.seed;
      seedText.textContent = sd ? String(sd) : '—';
      seed.setAttribute('aria-disabled', String(!sd));
      seed.dataset.tip = sd ? 'Copy seed' : 'Hand-set recipe: press Random for a seed';
      seed.setAttribute('aria-label', sd ? `Seed ${sd}, copy` : 'No seed yet');
    },
  };
}

/** Drawer header for narrow screens: view controls, presets and share that the top bar hides. */
export function createDrawerHeader(store: Store, deps: UIDeps, hooks: TopbarHooks) {
  const vc = viewControls(store, 'drawer');
  const row = (label: string, control: HTMLElement) =>
    h('div', { class: 'flex flex-col gap-1.5' }, h('span', { class: 're-caps text-[9.5px] text-smoke' }, label), control);

  const presetSel = h(
    'select',
    { class: 're-select h-10 min-w-0 flex-1 pl-3 text-[13px]', 'aria-label': 'Load a preset' },
    h('option', { value: '' }, 'Load preset…'),
    deps.presets.map((p) => h('option', { value: p.id }, p.name)),
  );
  presetSel.addEventListener('change', () => {
    const id = presetSel.value;
    presetSel.value = '';
    if (!id) return;
    const name = deps.presets.find((p) => p.id === id)?.name ?? id;
    void attempt(hooks.toaster, () => deps.loadPreset(id), `Loaded “${name}”`);
  });
  const share = h(
    'button',
    {
      type: 'button',
      class: 're-ghost h-10 px-3.5 text-[13px]',
      onClick: () => void attempt(hooks.toaster, () => deps.share(), 'Link copied'),
    },
    icon('share', 'size-4'),
    'Share',
  );

  const el = h(
    'div',
    { class: 're-rule flex flex-col gap-4 px-5 pb-5 pt-3 desk:hidden' },
    h(
      'div',
      { class: 'flex items-center gap-3' },
      emblem(26, 'flex-none text-brass-400'),
      h('span', { class: 'flex-1 font-display text-[19px] italic text-vellum' }, 'Workshop'),
      h(
        'button',
        { type: 'button', class: 're-quiet size-10', 'aria-label': 'Close controls', 'data-action': 'close-drawer', onClick: () => hooks.toggleDrawer(false) },
        icon('close', 'size-5'),
      ),
    ),
    row('Finish', vc.mode.el),
    row('Detail', vc.ui.el),
    row('View', vc.layout.el),
    h('div', { class: 'flex items-center gap-2' }, presetSel, share),
  );

  return { el, update: (s: AppState) => vc.update(s) };
}
