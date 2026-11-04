// A small engraved rosette (barleycorn rings) drawn as SVG paths: the wordmark emblem and dialog seal.
import { profileValue } from '../engine/rosette';

const NS = 'http://www.w3.org/2000/svg';

function ringPath(cx: number, cy: number, r: number, amp: number, lobes: number, phase: number, steps: number): string {
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const rr = r + amp * profileValue('sine', (lobes * t) / (Math.PI * 2) + phase);
    const x = cx + rr * Math.cos(t);
    const y = cy + rr * Math.sin(t);
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return d + 'Z';
}

/** Emblem SVG, `size` px square. `cls` must be a complete static class string. */
export function emblem(size: number, cls: string, rings = 7): SVGSVGElement {
  const el = document.createElementNS(NS, 'svg');
  el.setAttribute('viewBox', '0 0 100 100');
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('class', cls);

  const g = document.createElementNS(NS, 'g');
  g.setAttribute('fill', 'none');
  g.setAttribute('stroke', 'currentColor');
  g.setAttribute('stroke-width', size < 40 ? '2.2' : '1.1');
  for (let i = 0; i < rings; i++) {
    const r = 12 + (i * 34) / Math.max(1, rings - 1);
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', ringPath(50, 50, r, 2.6, 12, i % 2 === 0 ? 0 : 0.5, 180));
    p.setAttribute('opacity', String(0.55 + (0.45 * i) / rings));
    g.appendChild(p);
  }
  const rim = document.createElementNS(NS, 'circle');
  rim.setAttribute('cx', '50');
  rim.setAttribute('cy', '50');
  rim.setAttribute('r', '49');
  rim.setAttribute('stroke-width', size < 40 ? '2' : '0.8');
  g.appendChild(rim);
  el.appendChild(g);
  return el;
}
