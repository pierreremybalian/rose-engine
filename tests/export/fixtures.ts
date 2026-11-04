// Hand-built Toolpath fixtures in the exact contract shape (src/engine/types.ts): work frame, +Y up, mm.
import type { Pass, Toolpath } from '../../src/engine/types';
import { defaultRecipe, type Recipe } from '../../src/state/recipe';

export interface StrokeSpec {
  points: [number, number, number?][];
  closed: boolean;
  division?: number;
  slidePass?: number;
}

/** Pack strokes back to back into a Toolpath (closed strokes must NOT repeat their first point). */
export function makeToolpath(strokes: StrokeSpec[], samplesPerRev = 64): Toolpath {
  const total = strokes.reduce((n, s) => n + s.points.length, 0);
  const x = new Float32Array(total);
  const y = new Float32Array(total);
  const z = new Float32Array(total);
  const theta = new Float32Array(total);
  const passes: Pass[] = [];
  let at = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;
  let totalLength = 0;
  strokes.forEach((s, index) => {
    passes.push({
      index,
      division: s.division ?? 0,
      slidePass: s.slidePass ?? index,
      closed: s.closed,
      start: at,
      count: s.points.length,
    });
    s.points.forEach(([px, py, pz = 0], k) => {
      const i = at + k;
      x[i] = px;
      y[i] = py;
      z[i] = pz;
      theta[i] = i * ((2 * Math.PI) / samplesPerRev);
      minX = Math.min(minX, x[i]);
      maxX = Math.max(maxX, x[i]);
      minY = Math.min(minY, y[i]);
      maxY = Math.max(maxY, y[i]);
      zMin = Math.min(zMin, z[i]);
      zMax = Math.max(zMax, z[i]);
      if (k > 0) totalLength += Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
    });
    if (s.closed && s.points.length > 1) {
      const a = at;
      const b = at + s.points.length - 1;
      totalLength += Math.hypot(x[a] - x[b], y[a] - y[b]);
    }
    at += s.points.length;
  });
  return {
    x,
    y,
    z,
    theta,
    passes,
    samplesPerRev,
    totalSamples: total,
    zMin: total ? zMin : 0,
    zMax: total ? zMax : 0,
    bounds: total ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    totalLength,
  };
}

export interface RingOptions {
  passes: number;
  samples: number;
  r0?: number;
  r1?: number;
  lobes?: number;
  amplitude?: number;
  /** Eccentric divisions; each repeats all passes about a centre `offset` mm from the origin. */
  divisions?: number;
  offset?: number;
  /** Pump amplitude, mm (z = pump · cos(pumpLobes · θ)). */
  pump?: number;
  pumpLobes?: number;
  /** Start angle of every ring, radians (so loops don't all start at +X). */
  startAngle?: number;
}

/** Concentric rosette rings (closed), optionally repeated around an eccentric circle. */
export function ringsToolpath(o: RingOptions): Toolpath {
  const { passes, samples } = o;
  const r0 = o.r0 ?? 8;
  const r1 = o.r1 ?? 40;
  const lobes = o.lobes ?? 12;
  const amp = o.amplitude ?? 1.2;
  const divisions = o.divisions ?? 1;
  const offset = o.offset ?? 0;
  const pump = o.pump ?? 0;
  const pumpLobes = o.pumpLobes ?? 24;
  const a0 = o.startAngle ?? 0;
  const strokes: StrokeSpec[] = [];
  for (let d = 0; d < divisions; d++) {
    const da = (2 * Math.PI * d) / divisions;
    const cx = offset * Math.cos(da);
    const cy = offset * Math.sin(da);
    for (let p = 0; p < passes; p++) {
      const r = passes > 1 ? r0 + ((r1 - r0) * p) / (passes - 1) : r0;
      const phase = p % 2 ? Math.PI / lobes : 0;
      const pts: [number, number, number][] = [];
      for (let k = 0; k < samples; k++) {
        const t = a0 + (2 * Math.PI * k) / samples;
        const rr = r + amp * Math.cos(lobes * t + phase);
        pts.push([cx + rr * Math.cos(t), cy + rr * Math.sin(t), pump * Math.cos(pumpLobes * t)]);
      }
      strokes.push({ points: pts, closed: true, division: d, slidePass: p });
    }
  }
  return makeToolpath(strokes, samples);
}

/** One open Archimedean spiral per division (spiral recipes). */
export function spiralToolpath(turns: number, samplesPerTurn: number, r0 = 5, r1 = 40, divisions = 1): Toolpath {
  const strokes: StrokeSpec[] = [];
  const n = turns * samplesPerTurn;
  for (let d = 0; d < divisions; d++) {
    const pts: [number, number, number][] = [];
    for (let k = 0; k < n; k++) {
      const t = (2 * Math.PI * k) / samplesPerTurn + (2 * Math.PI * d) / divisions;
      const r = r0 + ((r1 - r0) * k) / (n - 1);
      pts.push([r * Math.cos(t), r * Math.sin(t), 0]);
    }
    strokes.push({ points: pts, closed: false, division: d, slidePass: 0 });
  }
  return makeToolpath(strokes, samplesPerTurn);
}

export function recipeWith(patch: (r: Recipe) => void): Recipe {
  const r = defaultRecipe();
  patch(r);
  return r;
}

/**
 * Minimal XML well-formedness check: one root, balanced/nested tags, quoted attributes, no stray '<' or
 * bare '&' in text. Returns the root element name; throws with a reason otherwise.
 */
export function assertWellFormedXml(xml: string): string {
  let s = xml.replace(/^﻿?<\?xml[^?]*\?>\s*/, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const tagRe = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/g;
  const stack: string[] = [];
  let root = '';
  let last = 0;
  let m: RegExpExecArray | null;
  const checkText = (t: string) => {
    if (t.includes('<') || t.includes('>')) throw new Error(`stray markup in text: ${t.slice(0, 80)}`);
    if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(t)) throw new Error(`bare & in text: ${t.slice(0, 80)}`);
    if (stack.length === 0 && t.trim()) throw new Error(`text outside root: ${t.slice(0, 80)}`);
  };
  while ((m = tagRe.exec(s))) {
    checkText(s.slice(last, m.index));
    last = tagRe.lastIndex;
    const [, close, name, attrs, selfClose] = m;
    if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(attrs)) throw new Error(`bare & in attributes of <${name}>`);
    const attrNames = [...attrs.matchAll(/([A-Za-z_][\w:.-]*)\s*=/g)].map((a) => a[1]);
    if (new Set(attrNames).size !== attrNames.length) throw new Error(`duplicate attribute on <${name}>`);
    if (close) {
      const open = stack.pop();
      if (open !== name) throw new Error(`</${name}> closes <${open}>`);
    } else {
      if (stack.length === 0) {
        if (root) throw new Error('more than one root element');
        root = name;
      }
      if (!selfClose) stack.push(name);
    }
  }
  checkText(s.slice(last));
  if (stack.length) throw new Error(`unclosed: ${stack.join(' > ')}`);
  if (!root) throw new Error('no root element');
  return root;
}
