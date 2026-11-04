// Export dialog: SVG / PNG / G-code / Preset tabs. Each tab's download calls a deps callback.
import { DEFAULT_GCODE_OPTIONS, DEFAULT_SVG_OPTIONS, type GcodeOptions, type GcodeResult, type SvgOptions } from '../export/types';
import type { PngOptions } from '../render/types';
import type { Store } from '../state/store';
import { h, stepDecimals, uid } from './dom';
import { emblem } from './emblem';
import { icon } from './icons';
import { segmented, switchButton } from './controls';
import { attempt, type Toaster } from './overlays';
import type { UIDeps } from './types';

type Tab = 'svg' | 'png' | 'gcode' | 'preset';
const TABS: { id: Tab; label: string; action: string }[] = [
  { id: 'svg', label: 'SVG', action: 'Download SVG' },
  { id: 'png', label: 'PNG', action: 'Download PNG' },
  { id: 'gcode', label: 'G-code', action: 'Download G-code' },
  { id: 'preset', label: 'Preset', action: 'Download JSON' },
];

// ---------- small dialog field builders ----------

function fieldLabel(text: string, forId?: string, note?: string) {
  return h(
    'label',
    { class: 'flex items-baseline justify-between gap-3 text-[12.5px] text-vellum-dim', for: forId },
    h('span', null, text),
    note ? h('span', { class: 'text-[11px] text-smoke' }, note) : null,
  );
}

function numField(label: string, value: number, o: { min?: number; max?: number; step: number; unit?: string; note?: string }, onChange: (v: number) => void) {
  const id = uid('dn');
  const dec = stepDecimals(o.step);
  const input = h('input', {
    id,
    type: 'number',
    min: o.min,
    max: o.max,
    step: o.step,
    value: value.toFixed(dec),
    inputmode: 'decimal',
    class: 're-figures w-full min-w-0 bg-transparent py-1.5 pl-3 pr-1 font-mono text-[13px] text-vellum',
  });
  input.addEventListener('change', () => {
    let v = parseFloat(input.value);
    if (!Number.isFinite(v)) v = value;
    if (o.min !== undefined) v = Math.max(o.min, v);
    if (o.max !== undefined) v = Math.min(o.max, v);
    value = v;
    input.value = v.toFixed(dec);
    onChange(v);
  });
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) onChange(v);
  });
  const el = h(
    'div',
    { class: 'flex flex-col gap-1.5' },
    fieldLabel(label, id, o.note),
    h('div', { class: 're-numbox flex h-10 items-center pr-3' }, input, o.unit ? h('span', { class: 'font-mono text-[11.5px] text-smoke' }, o.unit) : null),
  );
  return {
    el,
    set(v: number) {
      value = v;
      if (document.activeElement !== input) input.value = v.toFixed(dec);
    },
  };
}

function textField(label: string, value: string, onChange: (v: string) => void, multiline = false) {
  const id = uid('dt');
  const input = multiline
    ? h('textarea', { id, rows: 3, spellcheck: 'false', class: 're-input w-full px-3 py-2 font-mono text-[12.5px]' }, value)
    : h('input', { id, type: 'text', value, spellcheck: 'false', autocomplete: 'off', class: 're-input h-10 w-full px-3 font-mono text-[13px]' });
  input.addEventListener('input', () => onChange(input.value));
  return h('div', { class: 'flex flex-col gap-1.5' }, fieldLabel(label, id), input);
}

function switchField(label: string, desc: string, value: boolean, onChange: (v: boolean) => void) {
  const id = uid('ds');
  const sw = switchButton(label, (next) => {
    sw.set(next);
    onChange(next);
  }, id);
  sw.set(value);
  sw.el.removeAttribute('aria-label');
  const descId = uid('dd');
  sw.el.setAttribute('aria-describedby', descId);
  const el = h(
    'div',
    { class: 'flex items-center gap-4 py-1' },
    h('div', { class: 'min-w-0 flex-1' }, h('label', { for: id, class: 'block text-[13.5px] text-vellum' }, label), h('p', { id: descId, class: 'mt-0.5 text-[12px] leading-snug text-smoke' }, desc)),
    sw.el,
  );
  return { el, set: sw.set };
}

function group(title: string, ...children: (HTMLElement | null)[]) {
  return h(
    'fieldset',
    { class: 'flex flex-col gap-4' },
    h('legend', { class: 're-caps mb-3 flex w-full items-center gap-3 text-[10px] text-brass-500' }, title, h('span', { class: 're-hairline-r flex-1' })),
    ...children,
  );
}

function intro(text: string) {
  return h('p', { class: 'mb-5 max-w-[34rem] text-[13.5px] leading-relaxed text-vellum-dim' }, text);
}

// ---------- formatting ----------

const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');
function fmtLen(mm: number): string {
  if (!Number.isFinite(mm)) return '—';
  return mm >= 1000 ? `${(mm / 1000).toFixed(mm >= 100000 ? 0 : 1)} m` : `${mm.toFixed(0)} mm`;
}
function fmtTime(sec: number): string {
  if (!Number.isFinite(sec)) return '—';
  const s = Math.round(sec);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (hh) return `${hh} h ${String(mm).padStart(2, '0')} min`;
  if (mm) return `${mm} min ${String(ss).padStart(2, '0')} s`;
  return `${ss} s`;
}

export function createExportDialog(store: Store, deps: UIDeps, toaster: Toaster) {
  const svgOpts: SvgOptions = { ...DEFAULT_SVG_OPTIONS };
  const gOpts: GcodeOptions = { ...DEFAULT_GCODE_OPTIONS };
  const png = { sizeMode: 'px' as 'px' | 'print', px: 4096, mm: 100, mmTouched: false, dpi: 300, transparent: false };
  let tab: Tab = 'svg';

  // ---------- SVG ----------
  const svgBg = switchField('Paper background', 'Fill behind the lines with the paper colour.', svgOpts.background, (v) => (svgOpts.background = v));
  const svgPanel = h(
    'div',
    null,
    intro('Vector paths in millimetres, centred on the work. One Inkscape layer per ink (or per pass group in metal), ready for a pen plotter. The recipe rides along in the file’s metadata.'),
    group(
      'Paths',
      numField('Simplify tolerance', svgOpts.tolerance, { min: 0, max: 0.5, step: 0.005, unit: 'mm', note: '0 keeps every sample' }, (v) => (svgOpts.tolerance = v)).el,
    ),
    h('div', { class: 'h-6' }),
    group('Sheet', svgBg.el, switchField('Disc outline', 'Draw the edge of the work disc.', svgOpts.outline, (v) => (svgOpts.outline = v)).el),
  );

  // ---------- PNG ----------
  const pxNote = h('p', { class: 're-figures font-mono text-[12px] text-brass-300' });
  const pxSeg = segmented<string>({
    label: 'Image size',
    options: [
      { value: '2048', label: '2048' },
      { value: '4096', label: '4096' },
      { value: '8192', label: '8192' },
    ],
    onChange: (v) => {
      png.px = Number(v);
      pxSeg.set(v);
      updatePng();
    },
    btnClass: 're-figures h-10 flex-1 font-mono text-[13px]',
    groupClass: 'w-full',
  });
  const mmField = numField('Print size', png.mm, { min: 10, max: 2000, step: 1, unit: 'mm' }, (v) => {
    png.mm = v;
    png.mmTouched = true;
    updatePng();
  });
  const dpiField = numField('Resolution', png.dpi, { min: 72, max: 2400, step: 1, unit: 'dpi' }, (v) => {
    png.dpi = v;
    updatePng();
  });
  const pxBlock = h('div', { class: 'flex flex-col gap-1.5' }, h('span', { class: 'text-[12.5px] text-vellum-dim' }, 'Square, in pixels'), pxSeg.el);
  const printBlock = h('div', { class: 'grid grid-cols-2 gap-3' }, mmField.el, dpiField.el);
  const sizeMode = segmented<'px' | 'print'>({
    label: 'Size by',
    options: [
      { value: 'px', label: 'Pixels' },
      { value: 'print', label: 'Print size' },
    ],
    onChange: (v) => {
      png.sizeMode = v;
      updatePng();
    },
    btnClass: 'h-9 px-4 text-[13px]',
  });
  const transparent = switchField('Transparent paper', 'Leave the paper out so the ink sits on alpha.', png.transparent, (v) => (png.transparent = v));
  const metalNote = h('p', { class: 'text-[12.5px] leading-snug text-smoke' }, 'Metal renders keep their lit plate background.');
  const pngPanel = h(
    'div',
    null,
    intro('A raster proof of the surface exactly as rendered: ink on paper, or the lit engraved plate. Very large sizes are capped at what your GPU can draw.'),
    group('Size', h('div', null, sizeMode.el), pxBlock, printBlock, pxNote),
    h('div', { class: 'h-6' }),
    group('Background', transparent.el, metalNote),
  );

  function pngSize(): number {
    return png.sizeMode === 'px' ? png.px : Math.max(16, Math.round((png.mm / 25.4) * png.dpi));
  }
  function updatePng() {
    sizeMode.set(png.sizeMode);
    pxSeg.set(String(png.px));
    pxBlock.hidden = png.sizeMode !== 'px';
    printBlock.hidden = png.sizeMode !== 'print';
    const n = pngSize();
    const mp = (n * n) / 1e6;
    pxNote.textContent = `${fmtInt(n)} × ${fmtInt(n)} px · ${mp.toFixed(1)} MP${png.sizeMode === 'px' ? ` · ${((n / 300) * 25.4).toFixed(0)} mm at 300 dpi` : ''}`;
    const ink = store.get().recipe.mode === 'ink';
    transparent.el.hidden = !ink;
    metalNote.hidden = ink;
  }

  // ---------- G-code ----------
  const stat = (label: string) => {
    const v = h('span', { class: 're-figures block font-mono text-[17px] leading-none text-vellum' }, '—');
    const el = h('div', { class: 're-stat flex flex-col gap-2 px-3 py-3' }, h('span', { class: 're-caps text-[9px] text-brass-500' }, label), v);
    return { el, v };
  };
  const sLines = stat('Lines');
  const sDraw = stat('Drawing');
  const sTravel = stat('Travel');
  const sTime = stat('Est. time');
  const statsState = h('p', { class: 're-figures mt-2.5 font-mono text-[11.5px] text-smoke', 'aria-live': 'polite' });
  const statsBlock = h(
    'div',
    { 'data-gcode-stats': true },
    h('div', { class: 'grid grid-cols-2 gap-2 sm:grid-cols-4' }, sLines.el, sDraw.el, sTravel.el, sTime.el),
    statsState,
  );

  const changed = () => schedulePreview();
  const profile = segmented<GcodeOptions['profile']>({
    label: 'Machine',
    options: [
      { value: 'pen', label: 'Pen plotter' },
      { value: 'cnc', label: 'CNC engrave' },
    ],
    onChange: (v) => {
      gOpts.profile = v;
      updateGcode();
      changed();
    },
    btnClass: 'h-9 flex-1 px-4 text-[13px]',
    groupClass: 'w-full',
  });
  const origin = segmented<GcodeOptions['origin']>({
    label: 'Origin',
    options: [
      { value: 'center', label: 'Centre' },
      { value: 'corner', label: 'Bottom-left' },
    ],
    onChange: (v) => {
      gOpts.origin = v;
      origin.set(v);
      changed();
    },
    btnClass: 'h-9 flex-1 px-4 text-[13px]',
    groupClass: 'w-full',
  });
  const set = <K extends keyof GcodeOptions>(k: K) => (v: GcodeOptions[K]) => {
    gOpts[k] = v;
    changed();
  };
  const penBlock = h(
    'div',
    { class: 'grid grid-cols-2 gap-3' },
    textField('Pen up', gOpts.penUp, set('penUp')),
    textField('Pen down', gOpts.penDown, set('penDown')),
  );
  const cncBlock = h(
    'div',
    { class: 'grid grid-cols-3 gap-3' },
    numField('Plunge', gOpts.plungeRate, { min: 1, max: 5000, step: 1, unit: 'mm/min' }, set('plungeRate')).el,
    numField('Safe Z', gOpts.safeZ, { min: 0, max: 50, step: 0.1, unit: 'mm' }, set('safeZ')).el,
    numField('Depth scale', gOpts.depthScale, { min: 0, max: 10, step: 0.05, unit: '×' }, set('depthScale')).el,
  );
  const templates = h(
    'details',
    { class: 'group/tpl rounded-[3px] border border-rule' },
    h(
      'summary',
      { class: 'flex list-none items-center gap-2 px-3 py-2.5 text-[12.5px] text-vellum-dim hover:text-vellum [&::-webkit-details-marker]:hidden' },
      icon('chevron', 'size-3.5 -rotate-90 text-smoke transition-transform group-open/tpl:rotate-0'),
      'Header and footer templates',
    ),
    h('div', { class: 'grid gap-3 px-3 pb-3 sm:grid-cols-2' }, textField('Header', gOpts.header, set('header'), true), textField('Footer', gOpts.footer, set('footer'), true)),
  );
  const gcodePanel = h(
    'div',
    null,
    intro('G21 / G90 toolpaths in millimetres. Each closed ring starts at the point nearest the last one, to keep travel short.'),
    group('Estimate', statsBlock),
    h('div', { class: 'h-6' }),
    group('Machine', profile.el, h('div', { class: 'flex flex-col gap-1.5' }, h('span', { class: 'text-[12.5px] text-vellum-dim' }, 'Work origin'), origin.el)),
    h('div', { class: 'h-6' }),
    group(
      'Motion',
      h(
        'div',
        { class: 'grid grid-cols-2 gap-3' },
        numField('Tolerance', gOpts.tolerance, { min: 0, max: 0.5, step: 0.005, unit: 'mm' }, set('tolerance')).el,
        numField('Feed rate', gOpts.feedRate, { min: 1, max: 20000, step: 10, unit: 'mm/min' }, set('feedRate')).el,
      ),
      penBlock,
      cncBlock,
      templates,
    ),
  );
  function updateGcode() {
    profile.set(gOpts.profile);
    origin.set(gOpts.origin);
    penBlock.hidden = gOpts.profile !== 'pen';
    cncBlock.hidden = gOpts.profile !== 'cnc';
  }

  let previewTimer = 0;
  let previewSeq = 0;
  function schedulePreview() {
    clearTimeout(previewTimer);
    if (!dialog.open || tab !== 'gcode') return;
    statsState.textContent = 'Calculating…';
    statsBlock.dataset.busy = 'true';
    previewTimer = window.setTimeout(runPreview, 180);
  }
  async function runPreview() {
    const seq = ++previewSeq;
    let stats: GcodeResult['stats'] | null = null;
    try {
      stats = await deps.previewGcode({ ...gOpts });
    } catch (err) {
      if (seq !== previewSeq) return;
      statsState.textContent = err instanceof Error ? err.message : String(err);
      return;
    }
    if (seq !== previewSeq) return;
    statsBlock.dataset.busy = 'false';
    if (!stats) {
      for (const s of [sLines, sDraw, sTravel, sTime]) s.v.textContent = '—';
      statsState.textContent = 'No toolpath yet.';
      return;
    }
    sLines.v.textContent = fmtInt(stats.lines);
    sDraw.v.textContent = fmtLen(stats.drawLength);
    sTravel.v.textContent = fmtLen(stats.travelLength);
    sTime.v.textContent = fmtTime(stats.estimatedSeconds);
    const b = stats.bounds;
    statsState.textContent = `Bounds ${(b.maxX - b.minX).toFixed(1)} × ${(b.maxY - b.minY).toFixed(1)} mm · X ${b.minX.toFixed(1)}…${b.maxX.toFixed(1)} · Y ${b.minY.toFixed(1)}…${b.maxY.toFixed(1)}`;
  }

  // ---------- Preset ----------
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', class: 'sr-only', 'data-action': 'load-preset-file' });
  const fileName = h('span', { class: 'text-[12px] text-smoke' }, 'or drop a .json file here');
  const drop = h(
    'label',
    { class: 're-dropzone flex cursor-pointer flex-col items-center gap-2 px-4 py-7 text-center' },
    fileInput,
    icon('upload', 'size-6 text-brass-400'),
    h('span', { class: 'text-[13.5px] text-vellum' }, 'Choose a preset file'),
    fileName,
  );
  async function loadFile(file: File) {
    fileName.textContent = file.name;
    const text = await file.text();
    const ok = await attempt(toaster, () => deps.loadPresetText(text), `Loaded ${file.name}`);
    if (ok) close();
  }
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (f) void loadFile(f);
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.dataset.over = 'true';
  });
  drop.addEventListener('dragleave', () => (drop.dataset.over = 'false'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.dataset.over = 'false';
    const f = e.dataTransfer?.files?.[0];
    if (f) void loadFile(f);
  });
  const presetPanel = h(
    'div',
    null,
    intro('Download every setting of this pattern as a versioned JSON preset, or load one back into the machine.'),
    group(
      'Save',
      h(
        'div',
        { class: 'flex flex-wrap items-center gap-x-4 gap-y-2' },
        h(
          'button',
          { type: 'button', class: 're-ghost h-10 px-4 text-[13px]', 'data-action': 'share-link', onClick: () => void attempt(toaster, () => deps.share(), 'Link copied') },
          icon('share', 'size-4'),
          'Copy share link',
        ),
        h('p', { class: 'min-w-0 flex-1 basis-56 text-[12px] leading-snug text-smoke' }, 'The link carries the whole recipe in its hash. Nothing is uploaded.'),
      ),
    ),
    h('div', { class: 'h-6' }),
    group('Load', drop),
  );

  // ---------- shell ----------
  const panels: Record<Tab, HTMLElement> = { svg: svgPanel, png: pngPanel, gcode: gcodePanel, preset: presetPanel };
  const titleId = uid('dlg');
  const tabButtons = TABS.map((t) =>
    h(
      'button',
      {
        type: 'button',
        role: 'tab',
        id: `${titleId}-tab-${t.id}`,
        'aria-controls': `${titleId}-panel-${t.id}`,
        'aria-selected': 'false',
        tabindex: '-1',
        class: 're-tab re-caps h-11 whitespace-nowrap px-3 text-[11px] sm:px-4',
        'data-tab': t.id,
        onClick: () => selectTab(t.id),
      },
      t.label,
    ),
  );
  const tablist = h('div', { role: 'tablist', 'aria-label': 'Export format', class: 'flex gap-1' }, tabButtons);
  tablist.addEventListener('keydown', (e) => {
    const i = TABS.findIndex((t) => t.id === tab);
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = TABS.length - 1;
    if (n < 0) return;
    e.preventDefault();
    selectTab(TABS[n].id);
    tabButtons[n].focus();
  });
  for (const t of TABS) {
    const p = panels[t.id];
    p.id = `${titleId}-panel-${t.id}`;
    p.setAttribute('role', 'tabpanel');
    p.setAttribute('aria-labelledby', `${titleId}-tab-${t.id}`);
    p.dataset.panel = t.id;
  }

  const primary = h('button', { type: 'button', class: 're-brass h-10 px-5 text-[13.5px]', 'data-action': 'download' }, icon('export', 'size-4'), h('span'));
  const primaryLabel = primary.lastElementChild as HTMLElement;
  primary.addEventListener('click', () => void download());
  const footNote = h('p', { class: 'min-w-0 flex-1 truncate text-[12px] text-smoke' });

  const dialog = h(
    'dialog',
    { class: 're-dialog w-[min(44rem,calc(100vw-1.5rem))] max-h-[min(46rem,calc(100dvh-1.5rem))]', 'aria-labelledby': titleId, 'data-dialog': 'export' },
    h(
      'div',
      { class: 'flex max-h-[min(46rem,calc(100dvh-1.5rem))] flex-col' },
      h(
        'header',
        { class: 're-dialog-head px-6 pt-5' },
        h(
          'div',
          { class: 'flex items-center gap-4' },
          emblem(44, 'flex-none text-brass-400'),
          h(
            'div',
            { class: 'min-w-0 flex-1' },
            h('p', { class: 're-caps text-[9.5px] text-brass-500' }, 'Take a proof'),
            h('h2', { id: titleId, class: 'mt-1 font-display text-[26px] italic leading-none text-vellum' }, 'Export'),
          ),
          h('button', { type: 'button', class: 're-quiet size-10', 'aria-label': 'Close', 'data-action': 'close-dialog', onClick: () => close() }, icon('close', 'size-5')),
        ),
        h('div', { class: 'mt-4' }, tablist),
      ),
      h('div', { class: 're-scroll min-h-0 flex-1 overflow-y-auto px-6 py-6' }, ...Object.values(panels)),
      h('footer', { class: 're-rule-top flex items-center gap-3 px-6 py-4' }, footNote, h('button', { type: 'button', class: 're-ghost h-10 px-4 text-[13px]', onClick: () => close() }, 'Close'), primary),
    ),
  );
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close();
  });
  dialog.addEventListener('close', () => clearTimeout(previewTimer));

  function selectTab(t: Tab) {
    tab = t;
    TABS.forEach((x, i) => {
      const on = x.id === t;
      tabButtons[i].setAttribute('aria-selected', String(on));
      tabButtons[i].tabIndex = on ? 0 : -1;
      panels[x.id].hidden = !on;
    });
    primaryLabel.textContent = TABS.find((x) => x.id === t)!.action;
    refreshFoot();
    if (t === 'gcode') schedulePreview();
  }

  function refreshFoot() {
    const r = store.get().recipe;
    const base = (r.name || 'pattern').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pattern';
    const ext = { svg: 'svg', png: 'png', gcode: 'gcode', preset: 'json' }[tab];
    footNote.textContent = `${base}.${ext}`;
  }

  async function download() {
    primary.disabled = true;
    try {
      switch (tab) {
        case 'svg':
          await attempt(toaster, () => deps.exportSVG({ ...svgOpts }), 'SVG saved');
          break;
        case 'png': {
          const n = pngSize();
          const opts: PngOptions = { width: n, height: n, transparent: store.get().recipe.mode === 'ink' && png.transparent };
          await attempt(toaster, () => deps.exportPNG(opts), 'PNG saved');
          break;
        }
        case 'gcode':
          await attempt(toaster, () => deps.exportGcode({ ...gOpts }), 'G-code saved');
          break;
        case 'preset':
          await attempt(toaster, () => deps.savePreset(), 'Preset saved');
          break;
      }
    } finally {
      primary.disabled = false;
    }
  }

  function open(t?: Tab) {
    const r = store.get().recipe;
    if (!png.mmTouched) {
      png.mm = r.machine.workDiameter;
      mmField.set(png.mm);
    }
    svgBg.el.hidden = r.mode !== 'ink';
    updatePng();
    updateGcode();
    if (!dialog.open) dialog.showModal();
    selectTab(t ?? tab);
    tabButtons[TABS.findIndex((x) => x.id === tab)].focus();
  }
  function close() {
    if (dialog.open) dialog.close();
  }

  selectTab(tab);
  updatePng();
  updateGcode();

  return {
    el: dialog,
    open,
    close,
    isOpen: () => dialog.open,
  };
}
