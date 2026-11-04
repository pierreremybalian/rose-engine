// Minimal DOM building helpers (no framework).

export type Child = Node | string | number | null | undefined | false;
type AttrValue = string | number | boolean | null | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (ev: any) => void;
export type Attrs = Record<string, AttrValue | Handler>;

/**
 * h('button', { class: 'x', type: 'button', onClick: fn }, 'Label')
 * `on*` keys become listeners; `true` sets an empty attribute; null/false/undefined are skipped.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'class') {
        el.className = String(v);
      } else {
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: (Child | Child[])[]): void {
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

/** Parse static SVG markup (icons). */
export function svg(markup: string): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild as SVGSVGElement;
}

let uidCounter = 0;
export function uid(prefix = 're'): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter.toString(36)}`;
}

/**
 * Make `parent`'s element children exactly `desired`, in order, moving only nodes that are out of place.
 * Nodes that are already in position are never detached, so a focused control keeps focus.
 */
export function reconcile(parent: Element, desired: Element[]): void {
  for (let i = 0; i < desired.length; i++) {
    const cur = parent.children[i];
    if (cur !== desired[i]) parent.insertBefore(desired[i], cur ?? null);
  }
  while (parent.children.length > desired.length) parent.lastElementChild!.remove();
}

/** Remove/add one token from a string list without mutating it. */
export function toggled(list: string[], key: string): string[] {
  return list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
}

const ROMAN: [number, string][] = [
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];
export function roman(n: number): string {
  let out = '';
  for (const [v, s] of ROMAN) {
    while (n >= v) {
      out += s;
      n -= v;
    }
  }
  return out;
}

/** Decimal places implied by a step (0.005 → 3, 0.1 → 1, 1 → 0). */
export function stepDecimals(step: number | undefined): number {
  if (!step || step >= 1) return 0;
  return Math.min(4, Math.ceil(-Math.log10(step) - 1e-9));
}

export function formatNumber(v: number, decimals: number): string {
  if (!Number.isFinite(v)) return '';
  return v.toFixed(decimals);
}

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'color', 'file', 'range'].includes(t.type);
  }
  return false;
}
