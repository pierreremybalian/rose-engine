// The one-time analytics question, same wording as balian.dev. Bottom-left of the viewport on desktop, top-left on
// narrow screens (where the work view and its tilt pad fill the bottom half). Goes away for good once answered.
import { answerConsent } from '../analytics';
import { h } from './dom';

export function createConsent(): HTMLElement {
  const answer = (yes: boolean) => {
    answerConsent(yes);
    el.remove();
  };
  const el = h(
    'div',
    {
      class:
        're-consent absolute left-5 top-5 z-30 flex w-[min(21rem,calc(100%-2.5rem))] desk:bottom-5 desk:top-auto flex-col gap-3 px-4 pb-3.5 pt-3 text-[13px] leading-snug text-vellum-dim',
      role: 'region',
      'aria-label': 'Analytics',
    },
    h('p', {}, 'I count visits with Google Analytics. It sets a cookie so the same browser is not counted twice. Allow that?'),
    h(
      'div',
      { class: 'flex gap-2' },
      h('button', { type: 'button', class: 're-brass h-8 px-3.5 text-[12.5px]', onClick: () => answer(true) }, 'Allow'),
      h('button', { type: 'button', class: 're-ghost h-8 px-3.5 text-[12.5px]', onClick: () => answer(false) }, 'No thanks'),
    ),
  );
  return el;
}
