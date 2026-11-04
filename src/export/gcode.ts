// G-code export: pen plotter or CNC engraving. Strokes keep toolpath order; each closed loop starts at the
// sample nearest the previous end and closes back to its own start. Numbers are fixed 3 decimals.
import type { Recipe } from '../state/recipe';
import type { Pass, Toolpath } from '../engine/types';
import type { GcodeOptions, GcodeResult } from './types';
import { keptIndices, sampleBounds } from './svg';

/** Rapid travel speed used for the time estimate, mm/min. */
export const RAPID_RATE = 3000;
/** Seconds charged per pen up or pen down command. */
export const PEN_MOVE_SECONDS = 0.15;

/** Fixed 3 decimals, never exponent notation, never "-0.000", never NaN. */
export function fmtG(v: number): string {
  if (!Number.isFinite(v)) return '0.000';
  const r = Math.round(v * 1000);
  return r === 0 ? '0.000' : (r / 1000).toFixed(3);
}

/** Like fmtG but trailing zeros trimmed (feed rates: "F1500"). */
function fmtRate(v: number): string {
  return fmtG(v).replace(/\.?0+$/, '') || '0';
}

/** Printable ASCII only: GRBL 1.1 treats bytes >= 0x80 as realtime commands, even inside comments. */
function asciiComment(s: string): string {
  return String(s)
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[()]/g, '')
    .trim();
}

function templateLines(text: string): string[] {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h ${m}m ${sec}s` : `${m}m ${sec}s`;
}

/**
 * CNC only: XY simplification ignores depth, so re-insert samples where the linear Z between two kept
 * samples misses the real Z by more than `tol` (1-D Douglas–Peucker over the sample index).
 */
function refineZ(
  kept: number[],
  zAt: (i: number) => number,
  start: number,
  count: number,
  closed: boolean,
  tol: number,
): number[] {
  if (kept.length === 0 || kept.length >= count) return kept;
  const virt = closed ? [...kept, kept[0] + count] : kept;
  const real = (v: number) => start + ((v - start) % count);
  const extra: number[] = [];
  const stack: number[] = [];
  for (let k = 0; k < virt.length - 1; k++) {
    if (virt[k + 1] - virt[k] > 1) stack.push(virt[k], virt[k + 1]);
  }
  while (stack.length) {
    const b = stack.pop()!;
    const a = stack.pop()!;
    const za = zAt(real(a));
    const zb = zAt(real(b));
    let worst = -1;
    let worstD = tol;
    const span = b - a;
    for (let v = a + 1; v < b; v++) {
      const d = Math.abs(zAt(real(v)) - (za + ((zb - za) * (v - a)) / span));
      if (d > worstD) {
        worstD = d;
        worst = v;
      }
    }
    if (worst >= 0) {
      extra.push(real(worst));
      if (worst - a > 1) stack.push(a, worst);
      if (b - worst > 1) stack.push(worst, b);
    }
  }
  if (extra.length === 0) return kept;
  const merged = kept.concat(extra).sort((p, q) => p - q);
  const out: number[] = [];
  for (const i of merged) if (out.length === 0 || out[out.length - 1] !== i) out.push(i);
  return out;
}

/** Visiting order of sample indices for one stroke (closed loops rotated and closed back to their start). */
function strokeOrder(tp: Toolpath, pass: Pass, kept: number[], px: number, py: number): number[] {
  const { x, y } = tp;
  const finite = kept.filter((i) => Number.isFinite(x[i]) && Number.isFinite(y[i]));
  if (!pass.closed || finite.length < 2) return finite;

  // Nearest sample of the whole loop (not just the kept ones) to the previous end.
  let best = -1;
  let bestD = Infinity;
  const end = pass.start + pass.count;
  for (let i = pass.start; i < end; i++) {
    const dx = x[i] - px;
    const dy = y[i] - py;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best < 0) return finite;
  let pos = finite.findIndex((i) => i >= best);
  if (pos < 0) {
    finite.push(best);
    pos = finite.length - 1;
  } else if (finite[pos] !== best) {
    finite.splice(pos, 0, best);
  }
  const order = finite.slice(pos).concat(finite.slice(0, pos));
  order.push(order[0]);
  return order;
}

export function buildGcode(recipe: Recipe, toolpath: Toolpath, opts: GcodeOptions): GcodeResult {
  const cnc = opts.profile === 'cnc';
  const tp = toolpath;
  const tol = opts.tolerance;

  // Output frame: 'center' keeps work coordinates, 'corner' puts the min corner of the samples at X0 Y0.
  const sb = sampleBounds(tp);
  const shiftX = opts.origin === 'corner' && sb ? sb.minX : 0;
  const shiftY = opts.origin === 'corner' && sb ? sb.minY : 0;

  const baseDepth = recipe.metal.baseDepth;
  const depthScale = opts.depthScale;
  const zs = tp.z;
  const zAt = (i: number): number => {
    const zi = zs ? zs[i] : 0;
    return -depthScale * Math.max(0, baseDepth + (Number.isFinite(zi) ? zi : 0));
  };

  // A depth error dz moves each groove edge by dz·tan(angle/2): keep that within the XY tolerance.
  const zTol = tol / Math.max(1, Math.tan(((recipe.metal.toolAngle * Math.PI) / 180) / 2));

  const feed = `F${fmtRate(opts.feedRate)}`;
  const plunge = `F${fmtRate(opts.plungeRate)}`;
  const safeZ = fmtG(opts.safeZ);
  const penUp = templateLines(opts.penUp);
  const penDown = templateLines(opts.penDown);

  const body: string[] = [];
  let drawLength = 0;
  let travelLength = 0;
  let plungeLength = 0;
  let retractLength = 0;
  let penMoves = 0;
  let strokes = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  // Pen/cutter starts up/safe at the output origin.
  if (cnc) body.push(`G0 Z${safeZ}`);
  else {
    body.push(...penUp);
    penMoves += 1;
  }
  let px = shiftX; // previous position, work coordinates
  let py = shiftY;

  for (const pass of tp.passes) {
    let kept = keptIndices(tp, pass, tol);
    if (cnc && tol > 0) kept = refineZ(kept, zAt, pass.start, pass.count, pass.closed, zTol);
    const order = strokeOrder(tp, pass, kept, px, py);
    if (order.length === 0) continue;
    strokes += 1;

    const i0 = order[0];
    const x0 = tp.x[i0];
    const y0 = tp.y[i0];
    travelLength += Math.hypot(x0 - px, y0 - py);
    let lx = fmtG(x0 - shiftX);
    let ly = fmtG(y0 - shiftY);
    body.push(`G0 X${lx} Y${ly}`);
    if (x0 - shiftX < minX) minX = x0 - shiftX;
    if (x0 - shiftX > maxX) maxX = x0 - shiftX;
    if (y0 - shiftY < minY) minY = y0 - shiftY;
    if (y0 - shiftY > maxY) maxY = y0 - shiftY;

    let lz = '';
    let zPrev = 0;
    if (cnc) {
      zPrev = zAt(i0);
      lz = fmtG(zPrev);
      plungeLength += Math.max(0, opts.safeZ - zPrev);
      body.push(`G1 Z${lz} ${plunge}`);
    } else {
      body.push(...penDown);
      penMoves += 1;
    }

    let first = true;
    let qx = x0;
    let qy = y0;
    for (let k = 1; k < order.length; k++) {
      const i = order[k];
      const ox = tp.x[i] - shiftX;
      const oy = tp.y[i] - shiftY;
      const sx = fmtG(ox);
      const sy = fmtG(oy);
      let line: string;
      if (cnc) {
        const z = zAt(i);
        const sz = fmtG(z);
        if (sx === lx && sy === ly && sz === lz) continue;
        line = `G1 X${sx} Y${sy} Z${sz}`;
        lz = sz;
        zPrev = z;
      } else {
        if (sx === lx && sy === ly) continue;
        line = `G1 X${sx} Y${sy}`;
      }
      if (first) {
        line += ` ${feed}`;
        first = false;
      }
      body.push(line);
      lx = sx;
      ly = sy;
      drawLength += Math.hypot(tp.x[i] - qx, tp.y[i] - qy);
      qx = tp.x[i];
      qy = tp.y[i];
      if (ox < minX) minX = ox;
      if (ox > maxX) maxX = ox;
      if (oy < minY) minY = oy;
      if (oy > maxY) maxY = oy;
    }

    if (cnc) {
      body.push(`G0 Z${safeZ}`);
      retractLength += Math.max(0, opts.safeZ - zPrev);
    } else {
      body.push(...penUp);
      penMoves += 1;
    }
    px = qx;
    py = qy;
  }

  const rate = (v: number) => (v > 0 ? v : 1);
  const estimatedSeconds =
    (drawLength / rate(opts.feedRate)) * 60 +
    ((travelLength + retractLength) / RAPID_RATE) * 60 +
    (cnc ? (plungeLength / rate(opts.plungeRate)) * 60 : penMoves * PEN_MOVE_SECONDS);
  const bounds =
    minX <= maxX ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  // Assemble: header, missing modal codes, comment block, body, footer.
  const header = templateLines(opts.header);
  const headerText = header.join('\n');
  const modal: string[] = [];
  if (!/\bG21\b/i.test(headerText)) modal.push('G21 ; mm');
  if (!/\bG90\b/i.test(headerText)) modal.push('G90 ; absolute');
  const footer = templateLines(opts.footer);

  const comments = (lines: number): string[] => {
    const c = [
      '; Rose engine G-code',
      `; name: ${asciiComment(recipe.name) || 'untitled'}`,
      `; seed: ${recipe.seed}`,
      `; mode: ${recipe.mode}, profile: ${opts.profile}, origin: ${opts.origin}`,
      `; strokes: ${strokes}, tolerance: ${fmtG(tol)} mm, feed: ${fmtRate(opts.feedRate)} mm/min`,
    ];
    if (cnc) {
      c.push(
        `; depth: -${fmtG(depthScale)} x (${fmtG(baseDepth)} + pump) mm, safe Z: ${safeZ} mm, plunge: ${fmtRate(opts.plungeRate)} mm/min`,
      );
    }
    c.push(
      `; draw length: ${fmtG(drawLength)} mm, travel: ${fmtG(travelLength)} mm`,
      `; estimated time: ${formatDuration(estimatedSeconds)}`,
      `; bounds: X ${fmtG(bounds.minX)} .. ${fmtG(bounds.maxX)}, Y ${fmtG(bounds.minY)} .. ${fmtG(bounds.maxY)} mm`,
      `; lines: ${lines}`,
    );
    return c;
  };
  const lineCount = header.length + modal.length + comments(0).length + body.length + footer.length;
  const all = header.concat(modal, comments(lineCount), body, footer);
  const text = all.join('\n') + '\n';

  return {
    text,
    stats: {
      lines: all.length,
      drawLength,
      travelLength,
      estimatedSeconds,
      bounds,
    },
  };
}
