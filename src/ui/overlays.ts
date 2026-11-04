// Toasts and the single floating tooltip.
import { h } from './dom';

export type ToastKind = 'info' | 'success' | 'error';
export interface Toaster {
  el: HTMLElement;
  show(message: string, kind?: ToastKind): void;
  dispose(): void;
}

export function createToaster(): Toaster {
  const el = h('div', {
    class: 'pointer-events-none fixed inset-x-0 bottom-28 z-[90] flex flex-col items-center gap-2 px-4 desk:bottom-24',
    role: 'status',
    'aria-live': 'polite',
  });
  const timers = new Set<number>();

  function show(message: string, kind: ToastKind = 'info'): void {
    const t = h(
      'div',
      { class: 're-toast pointer-events-auto flex max-w-md items-center gap-3 px-4 py-2.5 text-[13px] text-vellum', 'data-kind': kind },
      h('span', { class: 're-toast-pip size-1.5 flex-none rounded-full' }),
      h('span', { class: 'leading-snug' }, message),
    );
    el.appendChild(t);
    while (el.children.length > 3) el.firstElementChild!.remove();
    const life = kind === 'error' ? 6000 : 2600;
    const id = window.setTimeout(() => {
      t.dataset.leaving = 'true';
      const id2 = window.setTimeout(() => {
        t.remove();
        timers.delete(id2);
      }, 240);
      timers.add(id2);
      timers.delete(id);
    }, life);
    timers.add(id);
  }

  return {
    el,
    show,
    dispose() {
      for (const id of timers) clearTimeout(id);
      el.remove();
    },
  };
}

/** Run a deps callback; surface thrown errors / rejections as an error toast. */
export async function attempt(toaster: Toaster, fn: () => unknown, ok?: string): Promise<boolean> {
  try {
    await fn();
    if (ok) toaster.show(ok, 'success');
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toaster.show(msg || 'Something went wrong', 'error');
    console.warn(err);
    return false;
  }
}

/**
 * One tooltip for the whole app, driven by `data-tip` (text) and optional `data-kbd` (shortcut) attributes.
 * Shows on hover (after a short delay) and on keyboard focus. Positioned fixed, so scroll containers never clip it.
 */
export function createTooltip(root: HTMLElement): { el: HTMLElement; dispose(): void } {
  const text = h('span');
  const kbd = h('kbd');
  const el = h('div', { class: 're-tooltip', role: 'tooltip', 'aria-hidden': 'true' }, text, kbd);
  let current: HTMLElement | null = null;
  let timer = 0;

  function place(target: HTMLElement) {
    const r = target.getBoundingClientRect();
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    let top = r.top - th - 8;
    if (top < 6) top = r.bottom + 8;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(6, Math.min(window.innerWidth - tw - 6, left));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function open(target: HTMLElement) {
    const tip = target.dataset.tip;
    if (!tip) return;
    current = target;
    text.textContent = tip;
    const k = target.dataset.kbd;
    kbd.textContent = k ?? '';
    kbd.hidden = !k;
    el.dataset.show = 'true';
    place(target);
  }
  function close() {
    clearTimeout(timer);
    current = null;
    el.dataset.show = 'false';
  }

  const tipTarget = (t: EventTarget | null) => (t instanceof Element ? (t.closest('[data-tip]') as HTMLElement | null) : null);

  const onOver = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    const t = tipTarget(e.target);
    if (t === current) return;
    clearTimeout(timer);
    if (!t) return close();
    timer = window.setTimeout(() => open(t), current ? 60 : 420);
  };
  const onOut = (e: PointerEvent) => {
    const to = tipTarget(e.relatedTarget);
    if (to !== current) close();
  };
  // Only keyboard navigation opens tips on focus; a click into a text box shouldn't cover the row above.
  let keyboardNav = false;
  const onFocus = (e: FocusEvent) => {
    const t = e.target as HTMLElement;
    if (!keyboardNav) return;
    if (t.dataset.tip) return open(t);
    // Controls inside a param row borrow the row label's help text.
    const lab = t.closest('.re-field')?.querySelector<HTMLElement>('.re-label[data-tip]');
    if (lab) open(lab);
  };
  const onBlur = () => close();
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Tab') keyboardNav = true;
    if (e.key === 'Escape' && current) close();
  };
  const onDown = () => {
    keyboardNav = false;
    close();
  };

  root.addEventListener('pointerover', onOver);
  root.addEventListener('pointerout', onOut);
  root.addEventListener('focusin', onFocus);
  root.addEventListener('focusout', onBlur);
  root.addEventListener('pointerdown', onDown);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', close, true);

  return {
    el,
    dispose() {
      close();
      root.removeEventListener('pointerover', onOver);
      root.removeEventListener('pointerout', onOut);
      root.removeEventListener('focusin', onFocus);
      root.removeEventListener('focusout', onBlur);
      root.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', close, true);
      el.remove();
    },
  };
}
