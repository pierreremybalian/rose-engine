// mountUI: builds the workshop shell (top bar, panel / drawer, viewport, transport) and wires it to the store.
import '../styles/main.css';
import '../styles/app.scss';
import { initAnalytics } from '../analytics';
import type { AppState, Store } from '../state/store';
import { createConsent } from './consent';
import { h } from './dom';
import { createExportDialog } from './exportDialog';
import { bindKeyboard } from './keyboard';
import { createToaster, createTooltip } from './overlays';
import { createPanel } from './panel';
import { createDrawerHeader, createTopbar } from './topbar';
import { createTiltPad } from './tiltPad';
import { createTransport } from './transport';
import type { MountedUI, UIDeps } from './types';

const NARROW = '(max-width: 56.24rem)';

export function mountUI(root: HTMLElement, store: Store, deps: UIDeps): MountedUI {
  const toaster = createToaster();
  const mq = window.matchMedia(NARROW);
  let drawerOpen = false;

  const app = h('div', {
    class:
      're-app group/app relative grid h-dvh w-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden text-vellum desk:grid-cols-[22.5rem_minmax(0,1fr)]',
    'data-drawer': 'closed',
  });

  const dialog = createExportDialog(store, deps, toaster);
  const hooks = {
    openExport: () => {
      toggleDrawer(false);
      dialog.open();
    },
    toggleDrawer: (open?: boolean) => toggleDrawer(open),
    toaster,
  };

  const topbar = createTopbar(store, deps, hooks);
  const drawerHeader = createDrawerHeader(store, deps, hooks);
  const panel = createPanel(store, drawerHeader.el);
  const transport = createTransport(store, deps);
  const tiltPad = createTiltPad(store);

  const aside = h(
    'aside',
    {
      id: 're-panel',
      'aria-label': 'Machine controls',
      class:
        're-panel re-scroll re-rise z-40 overflow-y-auto overscroll-contain [animation-delay:60ms] desk:col-start-1 desk:row-span-2 desk:row-start-2 max-desk:fixed max-desk:inset-y-0 max-desk:left-0 max-desk:w-[min(23rem,calc(100vw-2.75rem))] max-desk:-translate-x-full max-desk:shadow-[24px_0_60px_-20px_rgb(0_0_0/0.9)] max-desk:transition-transform max-desk:duration-300 max-desk:ease-[cubic-bezier(0.2,0.8,0.2,1)] max-desk:group-data-[drawer=open]/app:translate-x-0',
    },
    panel.el,
  );

  const scrim = h('div', { class: 're-scrim fixed inset-0 z-[35] desk:hidden', hidden: true, 'aria-hidden': 'true' });
  scrim.addEventListener('click', () => toggleDrawer(false));

  const workViewport = h('div', { class: 'absolute inset-0', 'data-viewport': 'work' });
  const main = h(
    'main',
    { class: 're-rise relative min-h-0 min-w-0 overflow-hidden bg-ink-950 [animation-delay:120ms] desk:col-start-2 desk:row-start-2', 'aria-label': 'Machine and work view' },
    workViewport,
    h('div', { class: 're-frame absolute inset-0', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i')),
  );
  if (initAnalytics()) main.append(createConsent());
  topbar.el.classList.add('col-span-full', 're-rise');
  transport.el.classList.add('re-rise', '[animation-delay:180ms]', 'desk:col-start-2', 'desk:row-start-3');

  const tooltip = createTooltip(app);
  app.append(topbar.el, aside, main, transport.el, scrim, toaster.el, tooltip.el, dialog.el);
  root.appendChild(app);

  function toggleDrawer(open?: boolean) {
    const next = open ?? !drawerOpen;
    if (next === drawerOpen) return;
    drawerOpen = next && mq.matches;
    app.dataset.drawer = drawerOpen ? 'open' : 'closed';
    scrim.hidden = !drawerOpen;
    aside.inert = mq.matches && !drawerOpen;
    // The open drawer is modal: everything behind it leaves the tab order.
    for (const el of [topbar.el, main, transport.el]) el.inert = drawerOpen;
    topbar.setDrawerOpen(drawerOpen);
    if (drawerOpen) {
      aside.scrollTop = 0;
      aside.querySelector<HTMLElement>('[data-action="close-drawer"]')?.focus({ preventScroll: true });
    } else if (mq.matches && aside.contains(document.activeElement)) {
      topbar.el.querySelector<HTMLElement>('[data-action="drawer"]')?.focus();
    }
  }
  const onMq = () => {
    if (!mq.matches) {
      drawerOpen = false;
      app.dataset.drawer = 'closed';
      scrim.hidden = true;
      for (const el of [topbar.el, main, transport.el]) el.inert = false;
      topbar.setDrawerOpen(false);
    }
    aside.inert = mq.matches && !drawerOpen;
  };
  mq.addEventListener('change', onMq);
  onMq();

  const update = (s: AppState, prev?: AppState) => {
    if (!prev || s.recipe !== prev.recipe || s.layout !== prev.layout || s.uiMode !== prev.uiMode) {
      topbar.update(s);
      drawerHeader.update(s);
    }
    panel.update(s, prev);
    transport.update(s, prev);
    if (!prev || s.tilt !== prev.tilt || s.shimmer !== prev.shimmer) tiltPad.update(s, prev);
  };
  update(store.get());
  const unsubscribe = store.subscribe(update);

  const unbindKeys = bindKeyboard(store, deps, {
    openExport: hooks.openExport,
    dialogOpen: dialog.isOpen,
    escape: () => {
      if (topbar.closeMenus()) return true;
      if (drawerOpen) {
        toggleDrawer(false);
        return true;
      }
      return false;
    },
    toaster,
  });

  return {
    workViewport,
    workControls: tiltPad.el,
    showTilt: (t) => tiltPad.show(t),
    dispose() {
      unsubscribe();
      unbindKeys();
      mq.removeEventListener('change', onMq);
      transport.dispose();
      tooltip.dispose();
      toaster.dispose();
      dialog.close();
      tiltPad.el.remove();
      app.remove();
    },
  };
}
