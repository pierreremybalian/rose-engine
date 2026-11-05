// Tilt pad: a small dial in the corner of the work view, like a spirit level. The brass dot shows where the
// plate faces; drag it (mouse, pen or touch) to tilt, tap or double-click the pad to level the plate. The
// button beside it rocks the plate in the light (shimmer, also on T). Keyboard: arrows tilt (Shift = coarse),
// Enter/Space toggle the shimmer, Home levels.
import type { AppState, Store, Tilt } from '../state/store';
import { h, uid } from './dom';
import { icon } from './icons';

const MAX = 40;
const STEP = 2;
const STEP_COARSE = 8;
/** A press shorter than this that doesn't move is a tap. */
const TAP_MS = 350;
const TAP_SLOP = 4;

function clamp(t: Tilt): Tilt {
  const m = Math.hypot(t.x, t.y);
  return m > MAX ? { x: (t.x * MAX) / m, y: (t.y * MAX) / m } : t;
}

/** Spoken tilt: which way the plate faces. */
function describe(t: Tilt): string {
  const part = (v: number, pos: string, neg: string) => (Math.abs(v) < 0.5 ? '' : `${Math.round(Math.abs(v))}° ${v > 0 ? pos : neg}`);
  // tilt.y turns the face right, tilt.x turns it down
  const s = [part(t.y, 'right', 'left'), part(t.x, 'down', 'up')].filter(Boolean).join(', ');
  return s ? `Facing ${s}` : 'Level';
}

export interface TiltPad {
  el: HTMLElement;
  /** Tilt shown right now (every frame while shimmering). */
  show(t: Tilt): void;
  update(s: AppState, prev?: AppState): void;
}

export function createTiltPad(store: Store): TiltPad {
  const live: Tilt = { x: 0, y: 0 };
  const helpId = uid('re-tilt-help');

  const dot = h('span', { class: 're-tilt-dot', 'aria-hidden': 'true' });
  const pad = h(
    'div',
    {
      class: 're-tilt-pad size-16 flex-none',
      role: 'slider',
      tabindex: 0,
      'aria-label': 'Plate tilt',
      'aria-roledescription': 'tilt pad',
      'aria-describedby': helpId,
      'aria-valuemin': 0,
      'aria-valuemax': MAX,
      'aria-valuenow': 0,
      'aria-valuetext': 'Level',
      'data-tip': 'Tilt the plate to catch the light. Drag the dot, or Shift-drag the view. Double-click levels it.',
      'data-action': 'tilt',
    },
    h('span', { class: 're-tilt-face', 'aria-hidden': 'true' }),
    dot,
    h('span', { id: helpId, class: 'sr-only' }, 'Arrow keys tilt, Shift for bigger steps. Enter toggles the shimmer. Home levels the plate.'),
  );
  const shimmer = h(
    'button',
    {
      type: 'button',
      class: 're-tilt-shimmer size-9',
      'aria-pressed': 'false',
      'aria-label': 'Shimmer',
      'data-tip': 'Shimmer: rock the plate slowly in the light',
      'data-kbd': 'T',
      'data-action': 'shimmer',
      onClick: () => toggleShimmer(),
    },
    icon('shimmer', 'size-[18px]'),
  );
  const el = h('div', { class: 're-tilt absolute bottom-6 right-6 z-10 flex items-end gap-2', 'data-tilt': '' }, shimmer, pad);

  const set = (t: Tilt) => store.set({ tilt: clamp(t), shimmer: false });
  const toggleShimmer = () => store.set({ shimmer: !store.get().shimmer });

  // Relative drag: the dot follows the pointer 1:1, so the rim of its travel is the 40° limit.
  let drag: { id: number; x: number; y: number; t: Tilt; at: number; moved: boolean; touch: boolean } | null = null;
  const travel = () => {
    const r = pad.clientWidth / 2;
    return Math.max(8, r - dot.offsetWidth / 2 - 3);
  };
  pad.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); // the work view underneath must not pan
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    pad.focus({ preventScroll: true });
    pad.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: { ...live }, at: performance.now(), moved: false, touch: e.pointerType !== 'mouse' };
    pad.dataset.dragging = 'true';
    set(drag.t); // grabbing stops the shimmer where the plate is
  });
  pad.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    e.stopPropagation();
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
    drag.moved = true;
    const k = MAX / travel();
    // dot right = the plate faces right (tilt.y); dot up = it faces up (−tilt.x)
    set({ x: drag.t.x + dy * k, y: drag.t.y + dx * k });
  });
  const end = (e: PointerEvent) => {
    if (!drag || drag.id !== e.pointerId) return;
    e.stopPropagation();
    const tap = !drag.moved && drag.touch && performance.now() - drag.at < TAP_MS;
    drag = null;
    delete pad.dataset.dragging;
    if (pad.hasPointerCapture(e.pointerId)) pad.releasePointerCapture(e.pointerId);
    if (tap && e.type === 'pointerup') set({ x: 0, y: 0 });
  };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);
  pad.addEventListener('dblclick', (e) => {
    e.stopPropagation(); // levels the plate only; the view's double-click also resets zoom
    e.preventDefault();
    set({ x: 0, y: 0 });
  });
  pad.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? STEP_COARSE : STEP;
    const t = { ...live };
    switch (e.key) {
      case 'ArrowLeft':
        t.y -= step;
        break;
      case 'ArrowRight':
        t.y += step;
        break;
      case 'ArrowUp':
        t.x -= step;
        break;
      case 'ArrowDown':
        t.x += step;
        break;
      case 'Home':
      case '0':
        t.x = 0;
        t.y = 0;
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (!e.repeat) toggleShimmer();
        return;
      default:
        return;
    }
    e.preventDefault();
    set(t);
  });
  for (const ev of ['pointerdown', 'dblclick'] as const) shimmer.addEventListener(ev, (e) => e.stopPropagation());
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  let shownShimmer: boolean | null = null;
  let spoken = '';
  return {
    el,
    show(t) {
      live.x = t.x;
      live.y = t.y;
      const r = travel();
      dot.style.setProperty('--tilt-dx', `${((t.y / MAX) * r).toFixed(2)}px`);
      dot.style.setProperty('--tilt-dy', `${((t.x / MAX) * r).toFixed(2)}px`);
      pad.toggleAttribute('data-tilted', Math.hypot(t.x, t.y) > 0.5);
    },
    update(s) {
      if (s.shimmer !== shownShimmer) {
        shownShimmer = s.shimmer;
        shimmer.setAttribute('aria-pressed', String(s.shimmer));
        el.toggleAttribute('data-shimmer', s.shimmer);
      }
      // Announce the base tilt only (the shimmer would chatter).
      const text = describe(s.tilt);
      if (text !== spoken) {
        spoken = text;
        pad.setAttribute('aria-valuetext', text);
        pad.setAttribute('aria-valuenow', String(Math.round(Math.hypot(s.tilt.x, s.tilt.y))));
      }
    },
  };
}
