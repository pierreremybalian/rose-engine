// SVG export: mm units, viewBox centred on the work (1 user unit = 1 mm), +Y up flipped to SVG's +Y down,
// one Inkscape/AxiDraw layer per ink colour (ink) or per eccentric division (metal), recipe JSON in <metadata>.
import type { Recipe } from '../state/recipe';
import type { Pass, Toolpath } from '../engine/types';
import type { SvgOptions } from './types';
import { passColor } from '../state/colors';
import { simplifyPolyline } from '../engine/simplify';

const NS_SVG = 'http://www.w3.org/2000/svg';
const NS_INKSCAPE = 'http://www.inkscape.org/namespaces/inkscape';
const NS_SODIPODI = 'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd';
/** Namespace of the <rose:recipe> element inside <metadata>. */
export const NS_RECIPE = 'urn:x-rose-engine:recipe';

/** Stroke colour of metal-mode grooves. */
export const METAL_STROKE = '#3a3a3a';
const OUTLINE_STROKE = '#8a8a8a';
const OUTLINE_WIDTH = 0.2;

/** Round to 3 decimals, shortest form ("12.5", "-0.125", "0"). Never "-0", never NaN. */
export function fmt3(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 || !Number.isFinite(r) ? '0' : String(r);
}

/** XML-escape text or an attribute value, dropping characters XML 1.0 does not allow. */
export function xmlEscape(s: string): string {
  return String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Wrap text in CDATA, splitting any `]]>` so the section cannot be terminated early. */
export function cdata(text: string): string {
  return `<![CDATA[${text.split(']]>').join(']]]]><![CDATA[>')}]]>`;
}

/** Groove width of a V cutter at a depth: 2 · depth · tan(angle / 2). */
export function grooveWidth(depth: number, toolAngleDeg: number): number {
  return 2 * Math.max(0, depth) * Math.tan(((toolAngleDeg * Math.PI) / 180) / 2);
}

/**
 * Sample indices (absolute, ascending) kept for a pass after Ramer–Douglas–Peucker simplification.
 * Closed passes never repeat the first index at the end. tolerance <= 0 keeps every sample.
 */
export function keptIndices(tp: Toolpath, pass: Pass, tolerance: number): number[] {
  const { start, count, closed } = pass;
  if (count <= 0) return [];
  if (!(tolerance > 0) || count <= 2) return rangeIndices(start, count);
  const raw = simplifyPolyline(tp.x, tp.y, start, count, tolerance, closed);
  const end = start + count;
  const out: number[] = [];
  let prev = -1;
  for (let k = 0; k < raw.length; k++) {
    const i = raw[k];
    if (i < start || i >= end || i <= prev) continue; // defensive: in range, strictly ascending
    out.push(i);
    prev = i;
  }
  if (out.length < 2) return rangeIndices(start, count);
  return out;
}

function rangeIndices(start: number, count: number): number[] {
  const out = new Array<number>(count);
  for (let k = 0; k < count; k++) out[k] = start + k;
  return out;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Bounds of every finite sample of every pass (null if there are none). */
export function sampleBounds(tp: Toolpath): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const { x, y } = tp;
  for (const p of tp.passes) {
    const end = p.start + p.count;
    for (let i = p.start; i < end; i++) {
      const xi = x[i];
      const yi = y[i];
      if (!Number.isFinite(xi) || !Number.isFinite(yi)) continue;
      if (xi < minX) minX = xi;
      if (xi > maxX) maxX = xi;
      if (yi < minY) minY = yi;
      if (yi > maxY) maxY = yi;
    }
  }
  return minX <= maxX ? { minX, minY, maxX, maxY } : null;
}

/** SVG path data for one pass: absolute coords, y negated, "M x y L x y x y … [Z]". */
function pathData(tp: Toolpath, idx: number[], closed: boolean): string {
  const { x, y } = tp;
  const parts: string[] = [];
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const xi = x[i];
    const yi = y[i];
    if (!Number.isFinite(xi) || !Number.isFinite(yi)) continue;
    const pt = fmt3(xi) + ' ' + fmt3(-yi);
    if (parts.length === 0) parts.push('M' + pt);
    else if (parts.length === 1) parts.push('L' + pt);
    else parts.push(pt);
  }
  if (closed && parts.length > 2) parts.push('Z');
  return parts.join(' ');
}

interface Layer {
  label: string;
  id: string;
  stroke: string;
  passes: Pass[];
}

export function buildSVG(recipe: Recipe, toolpath: Toolpath, opts: SvgOptions): string {
  const metal = recipe.mode === 'metal';
  const total = toolpath.passes.length;
  const strokeWidth = metal
    ? grooveWidth(recipe.metal.baseDepth, recipe.metal.toolAngle)
    : recipe.ink.lineWidth;

  // Canvas: D = work diameter, grown if the toolpath (plus half a stroke) reaches outside it.
  let half = Math.max(0, recipe.machine.workDiameter / 2);
  const b = sampleBounds(toolpath);
  if (b) {
    const reach = Math.max(Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minY), Math.abs(b.maxY)) + strokeWidth / 2;
    if (reach > half) half = reach;
  }
  if (!(half > 0)) half = 1;
  half = Math.ceil(half * 1000) / 1000;
  const D = fmt3(2 * half);
  const negH = fmt3(-half);

  // Layers, in order of first appearance.
  const layers: Layer[] = [];
  const byKey = new Map<string, Layer>();
  for (const p of toolpath.passes) {
    let key: string;
    let stroke: string;
    if (metal) {
      key = String(p.division);
      stroke = METAL_STROKE;
    } else {
      stroke = passColor(recipe.ink, p.index, total);
      key = stroke.toLowerCase();
    }
    let layer = byKey.get(key);
    if (!layer) {
      const n = layers.length + 1;
      layer = metal
        ? { label: `${n} division ${p.division + 1}`, id: `layer-division-${n}`, stroke, passes: [] }
        : { label: `${n} ${stroke}`, id: `layer-ink-${n}`, stroke, passes: [] };
      byKey.set(key, layer);
      layers.push(layer);
    }
    layer.passes.push(p);
  }
  // A single-division metal recipe reads better as one "engraving" layer.
  if (metal && layers.length === 1) layers[0].label = '1 engraving';

  const name = recipe.name || 'Rose engine';
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  out.push(
    `<svg xmlns="${NS_SVG}" xmlns:inkscape="${NS_INKSCAPE}" xmlns:sodipodi="${NS_SODIPODI}" ` +
      `version="1.1" width="${D}mm" height="${D}mm" viewBox="${negH} ${negH} ${D} ${D}">`,
  );
  out.push(`<title>${xmlEscape(name)}</title>`);
  out.push(
    `<desc>${xmlEscape(
      `Rose engine pattern "${name}", seed ${recipe.seed}, ${recipe.mode} mode, ${total} passes. Units: mm, origin at the work centre.`,
    )}</desc>`,
  );
  out.push(
    `<metadata id="rose-engine-metadata"><rose:recipe xmlns:rose="${NS_RECIPE}" version="${recipe.version}">` +
      cdata(JSON.stringify(recipe)) +
      '</rose:recipe></metadata>',
  );
  out.push(`<sodipodi:namedview id="namedview" inkscape:document-units="mm" pagecolor="#ffffff"/>`);

  if (opts.background && !metal) {
    // '%' prefix: AxiDraw treats it as a documentation layer and never plots it.
    out.push(
      `<g inkscape:groupmode="layer" inkscape:label="% background" id="layer-background" sodipodi:insensitive="true">` +
        `<rect x="${negH}" y="${negH}" width="${D}" height="${D}" fill="${xmlEscape(recipe.ink.paper)}" stroke="none"/></g>`,
    );
  }

  if (opts.outline) {
    out.push(
      `<g inkscape:groupmode="layer" inkscape:label="outline" id="layer-outline" fill="none" stroke="${OUTLINE_STROKE}" stroke-width="${fmt3(OUTLINE_WIDTH)}">` +
        `<circle cx="0" cy="0" r="${fmt3(recipe.machine.workDiameter / 2)}"/></g>`,
    );
  }

  const sw = fmt3(strokeWidth);
  const opacity = metal ? 1 : Math.min(1, Math.max(0, recipe.ink.opacity));
  const opacityAttr = opacity < 1 ? ` stroke-opacity="${fmt3(opacity)}"` : '';
  for (const layer of layers) {
    out.push(
      `<g inkscape:groupmode="layer" inkscape:label="${xmlEscape(layer.label)}" id="${layer.id}" fill="none" ` +
        `stroke="${xmlEscape(layer.stroke)}" stroke-width="${sw}"${opacityAttr} stroke-linecap="round" stroke-linejoin="round">`,
    );
    for (const p of layer.passes) {
      const d = pathData(toolpath, keptIndices(toolpath, p, opts.tolerance), p.closed);
      out.push(`<path d="${d}"/>`);
    }
    out.push('</g>');
  }
  out.push('</svg>');
  out.push('');
  return out.join('\n');
}

/** Pull the recipe JSON back out of an SVG produced by buildSVG (null if absent or unparsable). */
export function extractRecipeJSON(svg: string): unknown | null {
  const m = /<rose:recipe\b[^>]*>([\s\S]*?)<\/rose:recipe>/.exec(svg);
  if (!m) return null;
  const text = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
