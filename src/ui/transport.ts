// Bottom transport: play/pause, restart, speed, scrub over samples, pass counter, camera presets, work frame.
import type { AppState, CameraPreset, Store, WorkFrame } from '../state/store';
import { h } from './dom';
import { icon } from './icons';
import { segmented } from './controls';
import type { ToolpathInfo, UIDeps } from './types';

const SPEEDS: { value: number; label: string }[] = [
  { value: 0.25, label: '0.25×' },
  { value: 1, label: '1×' },
  { value: 4, label: '4×' },
  { value: 16, label: '16×' },
  { value: 64, label: '64×' },
  { value: 200, label: '200×' },
  { value: 0, label: 'Instant' },
];

/** Play/pause; pressing play at the end starts over. */
export function togglePlay(store: Store, deps: UIDeps): void {
  const p = store.get().playback;
  if (p.playing) {
    store.set({ playback: { ...p, playing: false } });
    return;
  }
  const total = deps.getToolpathInfo()?.totalSamples ?? 0;
  const atEnd = total > 0 && p.progress >= total - 0.5;
  store.set({ playback: { ...p, playing: true, progress: atEnd ? 0 : p.progress } });
}

/** Index of the pass containing `sample` (largest i with passStarts[i] <= sample). */
function passAt(starts: ArrayLike<number>, sample: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= sample) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function createTransport(store: Store, deps: UIDeps) {
  const play = h(
    'button',
    {
      type: 'button',
      class: 're-crown size-11',
      'aria-pressed': 'false',
      'aria-label': 'Play',
      'data-action': 'play',
      'data-kbd': 'Space',
      onClick: () => togglePlay(store, deps),
    },
    icon('play', 'size-[18px] translate-x-px'),
  );
  const restart = h(
    'button',
    {
      type: 'button',
      class: 're-quiet size-9',
      'aria-label': 'Restart',
      'data-tip': 'Start the cut again',
      'data-action': 'restart',
      onClick: () => {
        const p = store.get().playback;
        store.set({ playback: { ...p, progress: 0, playing: true } });
      },
    },
    icon('restart', 'size-[18px]'),
  );
  const speed = h(
    'select',
    { class: 're-select re-figures h-8 w-[5.9rem] pl-2.5 font-mono text-[12px]', 'aria-label': 'Playback speed', 'data-tip': 'Spindle speed', 'data-action': 'speed' },
    SPEEDS.map((s) => h('option', { value: String(s.value) }, s.label)),
  );
  speed.addEventListener('change', () => {
    const p = store.get().playback;
    store.set({ playback: { ...p, speed: Number(speed.value) } });
  });

  const scrub = h('input', {
    type: 'range',
    class: 're-range re-range--scrub relative',
    min: 0,
    max: 1,
    step: 'any',
    value: 0,
    'aria-label': 'Scrub through the cut',
    'data-action': 'scrub',
  });
  const ticks = h('canvas', { class: 're-scrub-ticks absolute inset-x-0 top-0 h-8 w-full', 'aria-hidden': 'true' });
  let scrubbing = false;
  scrub.addEventListener('input', () => {
    scrubbing = true;
    const p = store.get().playback;
    store.set({ playback: { ...p, playing: false, progress: Number(scrub.value) } });
  });
  const endScrub = () => (scrubbing = false);
  scrub.addEventListener('change', endScrub);
  scrub.addEventListener('pointerup', endScrub);

  const passNow = h('span', { class: 're-figures min-w-[2.2ch] text-right font-mono text-[14px] text-vellum' }, '0');
  const passTotal = h('span', { class: 're-figures font-mono text-[12px] text-smoke' }, '/ 0');
  const readout = h(
    'div',
    { class: 're-readout order-1 ml-auto flex h-9 flex-none items-center gap-2 px-3 @xl:order-4 @xl:ml-0 @min-[65rem]:order-none', 'data-readout': 'pass' },
    h('span', { class: 're-caps text-[9.5px] text-brass-500' }, 'Pass'),
    passNow,
    passTotal,
  );

  const camera = segmented<CameraPreset>({
    label: 'Camera',
    options: [
      { value: 'overview', label: 'Overview', tip: 'Whole machine' },
      { value: 'rosette', label: 'Rosette', tip: 'Close on the rosette stack and rubber' },
      { value: 'tool', label: 'Tool', tip: 'Close on the cutter and work' },
    ],
    // Pressing the selected preset again brings an orbited camera back to it.
    onChange: (v) => (store.get().camera === v ? deps.resetCamera?.(v) : store.set({ camera: v })),
    btnClass: 'h-8 px-2.5 text-[12px]',
  });
  const frame = segmented<WorkFrame>({
    label: 'Work frame',
    options: [
      { value: 'work', label: 'Still', tip: 'Pattern still: the tool travels over the work' },
      { value: 'machine', label: 'Turning', tip: 'Work turns under a fixed tool, as on the machine' },
    ],
    onChange: (v) => store.set({ frame: v }),
    btnClass: 'h-8 px-2.5 text-[12px]',
  });
  const cameraWrap = h('div', { class: 'flex items-center' }, camera.el);
  const views = h(
    'div',
    { class: 'order-3 flex flex-none items-center gap-2 @xl:order-1 @xl:ml-auto @min-[65rem]:order-none @min-[65rem]:ml-0' },
    cameraWrap,
    h('span', { class: 'mx-0.5 h-5 w-px bg-rule', 'aria-hidden': 'true' }),
    frame.el,
  );

  // Container-query layout (the bar's width, not the window's):
  // narrow: [controls · readout] / [scrub] / [views];  mid: [controls · views] / [scrub · readout];  wide: one row.
  const el = h(
    'footer',
    { class: 're-transport @container', 'aria-label': 'Playback' },
    h(
      'div',
      { class: 'flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 pb-2.5 pt-3 @xl:gap-x-4 @xl:px-5 @min-[65rem]:flex-nowrap' },
      h('div', { class: 'flex flex-none items-center gap-2' }, play, restart, speed),
      h('div', { class: 'relative order-2 min-w-0 basis-full @xl:order-3 @xl:min-w-64 @xl:flex-1 @xl:basis-0 @min-[65rem]:order-none' }, ticks, scrub),
      readout,
      views,
    ),
  );

  let info: ToolpathInfo | null = null;
  let infoKey = '';

  function drawTicks() {
    const w = ticks.clientWidth;
    const hgt = ticks.clientHeight;
    if (!w || !hgt) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ticks.width = Math.round(w * dpr);
    ticks.height = Math.round(hgt * dpr);
    const ctx = ticks.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    if (!info || info.totalSamples <= 0) return;
    const n = info.passes;
    const inset = 3.5;
    const span = w - inset * 2;
    const cs = getComputedStyle(document.documentElement);
    const step = n > 160 ? Math.ceil(n / 160) : 1;
    ctx.fillStyle = cs.getPropertyValue('--color-rule-strong').trim() || 'rgba(211,172,98,.32)';
    for (let i = 0; i < n; i += step) {
      const x = inset + (info.passStarts[i] / info.totalSamples) * span;
      const major = i % (step * 10) === 0;
      ctx.fillRect(Math.round(x), major ? 21 : 22, 1, major ? 5 : 3);
    }
  }
  const ro = new ResizeObserver(() => drawTicks());
  ro.observe(ticks);

  function refreshInfo(): boolean {
    const next = deps.getToolpathInfo();
    const key = next ? `${next.totalSamples}|${next.passes}|${next.passStarts.length}` : '';
    if (next === info && key === infoKey) return false;
    info = next;
    if (key === infoKey) return false;
    infoKey = key;
    scrub.max = String(Math.max(1, info?.totalSamples ?? 1));
    scrub.disabled = !info || info.totalSamples <= 0;
    drawTicks();
    return true;
  }

  let shownPlaying: boolean | null = null;
  function render(s: AppState) {
    const p = s.playback;
    if (shownPlaying !== p.playing) {
      shownPlaying = p.playing;
      play.setAttribute('aria-pressed', String(p.playing));
      play.setAttribute('aria-label', p.playing ? 'Pause' : 'Play');
      play.dataset.tip = p.playing ? 'Pause' : 'Play';
      play.replaceChildren(p.playing ? icon('pause', 'size-[18px]') : icon('play', 'size-[18px] translate-x-px'));
    }
    const sv = String(p.speed);
    if (speed.value !== sv) speed.value = SPEEDS.some((x) => String(x.value) === sv) ? sv : '1';
    const total = info?.totalSamples ?? 0;
    if (!scrubbing) scrub.value = String(Math.min(total, p.progress));
    scrub.style.setProperty('--fill', `${total > 0 ? Math.min(100, (p.progress / total) * 100).toFixed(3) : 0}%`);
    const passes = info?.passes ?? 0;
    const idx = info && p.progress > 0 ? Math.min(passes, passAt(info.passStarts, p.progress) + 1) : 0;
    passNow.textContent = String(idx);
    passTotal.textContent = `/ ${passes}`;
    camera.set(s.camera);
    frame.set(s.frame);
    cameraWrap.hidden = s.layout === 'work';
  }

  // Integration may compute the toolpath a frame after a recipe change, so poll its (cached) summary.
  const poll = window.setInterval(() => {
    if (refreshInfo()) render(store.get());
  }, 250);

  return {
    el,
    update(s: AppState, prev?: AppState) {
      if (!prev || s.recipe !== prev.recipe) {
        refreshInfo();
        requestAnimationFrame(() => {
          if (refreshInfo()) render(store.get());
        });
      }
      if (prev && s.playback === prev.playback && s.camera === prev.camera && s.frame === prev.frame && s.layout === prev.layout && s.recipe === prev.recipe) return;
      render(s);
    },
    dispose() {
      clearInterval(poll);
      ro.disconnect();
    },
  };
}
