// Clipping at the plate edge: the cutter (or pen) only works on the plate, so exported paths stop at the rim.
// Pure geometry, no DOM. Work frame, mm.
import type { Pass, Toolpath } from '../engine/types';

/**
 * A run of samples to draw: indices [start, start + count) of the x / y / z arrays. Either a whole pass (the
 * toolpath's own arrays, no copy) or a clipped piece (fresh arrays, start 0).
 */
export interface ClipStroke {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  /** Pump displacement per sample (mm), or null when there is none. */
  z: ArrayLike<number> | null;
  start: number;
  count: number;
  /** Last sample joins back to the first. Only a polyline that is entirely inside keeps this. */
  closed: boolean;
}

/** Pieces shorter than this (mm) are dropped: a tangent touch of the rim, not a stroke. */
const MIN_PIECE = 1e-9;

/**
 * Keep the parts of a polyline inside the circle |p − c| ≤ radius, splitting it where it crosses the rim.
 * Crossing points are interpolated exactly on each segment (z linearly with them).
 * - Entirely inside: returned unchanged (same arrays and range, closed kept).
 * - Entirely outside (and never crossing): [].
 * - Otherwise: open pieces in path order. A closed polyline is walked from a point outside, so no piece
 *   wraps around its start.
 * Non-finite samples are treated as outside.
 */
export function clipPolylineToCircle(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  z: ArrayLike<number> | null,
  start: number,
  count: number,
  closed: boolean,
  radius: number,
  cx = 0,
  cy = 0,
): ClipStroke[] {
  if (count <= 0) return [];
  const R2 = radius * radius;
  const inside = (i: number): boolean => {
    const dx = x[i] - cx;
    const dy = y[i] - cy;
    const d = dx * dx + dy * dy;
    return d <= R2; // NaN compares false: outside
  };
  let firstOut = -1;
  for (let k = 0; k < count; k++) {
    if (!inside(start + k)) {
      firstOut = k;
      break;
    }
  }
  // The disc is convex: every segment between inside points stays inside.
  if (firstOut < 0) return [{ x, y, z, start, count, closed }];
  if (!(radius > 0)) return [];

  const loop = closed && count > 2;
  // visiting order: open → 0..count-1; closed → from the first outside sample, round and back to it
  const steps = loop ? count : count - 1;
  const at = (k: number): number => start + (loop ? (firstOut + k) % count : k);

  const pieces: ClipStroke[] = [];
  let px: number[] | null = null;
  let py: number[] | null = null;
  let pz: number[] | null = null;
  const begin = () => {
    px = [];
    py = [];
    pz = z ? [] : null;
  };
  const push = (xv: number, yv: number, zv: number) => {
    const n = px!.length;
    if (n > 0 && px![n - 1] === xv && py![n - 1] === yv) return; // e.g. a sample exactly on the rim
    px!.push(xv);
    py!.push(yv);
    if (pz) pz.push(zv);
  };
  const end = () => {
    if (px && px.length >= 2) {
      let len = 0;
      for (let k = 1; k < px.length && len <= MIN_PIECE; k++) len += Math.hypot(px[k] - px[k - 1], py![k] - py![k - 1]);
      if (len > MIN_PIECE) {
        pieces.push({ x: Float64Array.from(px), y: Float64Array.from(py!), z: pz ? Float64Array.from(pz) : null, start: 0, count: px.length, closed: false });
      }
    }
    px = py = pz = null;
  };
  const zOf = (i: number): number => (z ? z[i] : 0);

  // an open polyline that starts inside starts a piece at its first sample
  if (!loop && inside(start)) {
    begin();
    push(x[start], y[start], zOf(start));
  }
  for (let k = 0; k < steps; k++) {
    const i = at(k);
    const j = at(k + 1);
    const ax = x[i], ay = y[i], bx = x[j], by = y[j];
    const aIn = inside(i);
    const bIn = inside(j);
    if (aIn && bIn) {
      if (!px) {
        // after a gap of non-finite samples
        begin();
        push(ax, ay, zOf(i));
      }
      push(bx, by, zOf(j));
      continue;
    }
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) {
      end();
      continue;
    }
    // |a + t(b − a) − c|² = R²  →  dd·t² + 2·b0·t + c0 = 0
    const dx = bx - ax;
    const dy = by - ay;
    const ox = ax - cx;
    const oy = ay - cy;
    const dd = dx * dx + dy * dy;
    const b0 = dx * ox + dy * oy;
    const c0 = ox * ox + oy * oy - R2;
    const disc = b0 * b0 - dd * c0;
    if (!(dd > 0) || disc < 0) {
      // a zero-length step, or a segment that misses the disc
      if (!bIn) end();
      continue;
    }
    const sq = Math.sqrt(disc);
    const t0 = Math.max(0, Math.min(1, (-b0 - sq) / dd));
    const t1 = Math.max(0, Math.min(1, (-b0 + sq) / dd));
    const lerp = (t: number) => {
      const zi = zOf(i);
      push(ax + dx * t, ay + dy * t, zi + (zOf(j) - zi) * t);
    };
    if (aIn) {
      // leaving: the piece ends on the rim
      lerp(t1);
      end();
    } else if (bIn) {
      // entering: a new piece starts on the rim
      begin();
      lerp(t0);
      push(bx, by, zOf(j));
    } else if (t1 > t0) {
      // a chord through the disc between two outside samples
      begin();
      lerp(t0);
      lerp(t1);
      end();
    }
  }
  end();
  return pieces;
}

/** One pass of a toolpath clipped to a circle (the plate: radius plateRadius(recipe), centred on the work origin). */
export function clipPass(tp: Toolpath, pass: Pass, radius: number, cx = 0, cy = 0): ClipStroke[] {
  return clipPolylineToCircle(tp.x, tp.y, tp.z ?? null, pass.start, pass.count, pass.closed, radius, cx, cy);
}
