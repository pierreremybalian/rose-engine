// Google Analytics (GA4) behind a yes, the same way balian.dev does it: nothing from Google loads until the visitor
// clicks Allow, and the answer is kept in localStorage ("ga-consent": yes | no) so the prompt shows once per browser.
// Only the production build on the live host ever asks or loads anything; dev, preview and the QA scripts stay silent.
const GA_ID = 'G-MXMS8L0Z1H';
const KEY = 'ga-consent';
const LIVE_HOSTS = ['rose-engine.balian.dev'];

type Gtag = (...args: unknown[]) => void;
type Params = Record<string, string | number | boolean>;

let gtag: Gtag | null = null;

const available = import.meta.env.PROD && LIVE_HOSTS.includes(location.hostname);

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function write(v: 'yes' | 'no'): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // private window: ask again next time
  }
}

function load(): void {
  if (gtag) return;
  const w = window as unknown as { dataLayer: unknown[]; gtag: Gtag };
  w.dataLayer = w.dataLayer || [];
  // gtag.js reads the Arguments object itself, so this must be a plain function pushing `arguments`.
  w.gtag = function () {
    // eslint-disable-next-line prefer-rest-params
    w.dataLayer.push(arguments);
  };
  gtag = w.gtag;
  gtag('js', new Date());
  // Share links carry the whole recipe in the hash: keep it out of every hit's page URL.
  gtag('config', GA_ID, { page_location: location.origin + location.pathname });
  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.append(s);
}

/** Starts GA when the visitor already said yes. Returns true when the consent prompt should be shown. */
export function initAnalytics(): boolean {
  if (!available) return false;
  const answer = read();
  if (answer === 'yes') load();
  return answer !== 'yes' && answer !== 'no';
}

export function answerConsent(yes: boolean): void {
  write(yes ? 'yes' : 'no');
  if (yes) load();
}

/** Sends a GA4 event; a no-op until (and unless) the visitor allowed analytics. */
export function track(event: string, params: Params = {}): void {
  gtag?.('event', event, params);
}
