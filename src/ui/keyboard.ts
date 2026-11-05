// Global shortcuts. Ignored while typing in text fields; Space is left to focused buttons.
import type { Store } from '../state/store';
import { isTypingTarget } from './dom';
import { attempt, type Toaster } from './overlays';
import { togglePlay } from './transport';
import type { UIDeps } from './types';

export interface KeyHooks {
  openExport(): void;
  /** Close the topmost transient UI (menu, drawer). Returns true if something closed. */
  escape(): boolean;
  dialogOpen(): boolean;
  toaster: Toaster;
}

export function bindKeyboard(store: Store, deps: UIDeps, hooks: KeyHooks): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return;
    if (e.key === 'Escape') {
      if (!hooks.dialogOpen() && hooks.escape()) e.preventDefault();
      return;
    }
    if (hooks.dialogOpen()) return; // the modal owns the keyboard
    const t = e.target;
    if (isTypingTarget(t)) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    if (mod && !e.altKey) {
      if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
      } else if (key === 'y' && e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        store.redo();
      }
      return;
    }
    if (e.altKey || e.metaKey || e.ctrlKey) return;

    if (key === ' ') {
      // Let focused buttons, switches and tabs handle their own Space.
      if (t instanceof HTMLElement && t.closest('button, [role="button"], [role="switch"], [role="radio"], [role="tab"], [role="menuitem"], a, summary, select')) return;
      e.preventDefault();
      togglePlay(store, deps);
      return;
    }
    if (e.repeat) return;
    if (key === 'r') {
      e.preventDefault();
      void attempt(hooks.toaster, () => deps.random());
    } else if (key === 'm') {
      e.preventDefault();
      void attempt(hooks.toaster, () => deps.mutate());
    } else if (key === 'e') {
      e.preventDefault();
      hooks.openExport();
    } else if (key === 't') {
      e.preventDefault();
      store.set({ shimmer: !store.get().shimmer });
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
