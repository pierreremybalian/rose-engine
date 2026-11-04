// Inline line icons (24px grid, 1.5 stroke, currentColor). Static markup only.
import { svg } from './dom';

const S = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

const PATHS = {
  random:
    '<rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="8.6" cy="8.6" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.4" cy="15.4" r="1.15" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.4" cy="8.6" r="1.15" fill="currentColor" stroke="none"/><circle cx="8.6" cy="15.4" r="1.15" fill="currentColor" stroke="none"/>',
  mutate: '<path d="M3 15c1.8-3.6 3.6-3.6 5.4 0s3.6 3.6 5.4 0 3.6-3.6 5.4 0"/><path d="M17.5 3.5v4M15.5 5.5h4"/><path d="M6.5 5.2v2.2M5.4 6.3h2.2"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  presets: '<path d="M6 4.5h12a1 1 0 0 1 1 1v14l-7-3.6-7 3.6v-14a1 1 0 0 1 1-1Z"/><path d="M9 9h6"/>',
  share: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  export: '<path d="M12 3.5v11"/><path d="m7.5 10 4.5 4.5 4.5-4.5"/><path d="M4.5 16.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2"/>',
  play: '<path d="M8 5.2v13.6a.6.6 0 0 0 .92.5l10.5-6.8a.6.6 0 0 0 0-1L8.92 4.7A.6.6 0 0 0 8 5.2Z" fill="currentColor"/>',
  pause: '<rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor"/>',
  restart: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4.2h4.2"/>',
  lockOpen: '<rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8.5 11V7.5a3.5 3.5 0 0 1 6.8-1.2"/>',
  lockShut: '<rect x="5" y="11" width="14" height="9.5" rx="2" fill="currentColor" fill-opacity=".18"/><path d="M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11"/><path d="M12 14.5v2.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  split: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M12 5v14"/>',
  machine: '<path d="M12 3.2 19.8 7.6v8.8L12 20.8l-7.8-4.4V7.6z"/><path d="m4.2 7.6 7.8 4.4 7.8-4.4M12 12v8.8"/>',
  work: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  upload: '<path d="M12 15.5v-11"/><path d="m7.5 9 4.5-4.5L16.5 9"/><path d="M4.5 16.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2"/>',
  trash: '<path d="M5 7h14"/><path d="M10 11v6M14 11v6"/><path d="M6.5 7l.8 11.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8L17.5 7"/><path d="M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2"/>',
  camera: '<circle cx="12" cy="12" r="3"/><path d="M3 12s3.5-6.5 9-6.5S21 12 21 12s-3.5 6.5-9 6.5S3 12 3 12Z"/>',
  ink: '<path d="M12 3.5c3 4 5.5 7 5.5 10a5.5 5.5 0 0 1-11 0c0-3 2.5-6 5.5-10Z"/>',
  metal: '<path d="M12 3 20 8v8l-8 5-8-5V8z"/><path d="m12 3v18M4 8l16 8M20 8 4 16" stroke-opacity=".45"/>',
} as const;

export type IconName = keyof typeof PATHS;

/** `cls` must be a complete static class string (Tailwind scans for it). */
export function icon(name: IconName, cls = 'size-4'): SVGSVGElement {
  const el = svg(`<svg ${S}>${PATHS[name]}</svg>`);
  el.setAttribute('class', cls);
  return el;
}
