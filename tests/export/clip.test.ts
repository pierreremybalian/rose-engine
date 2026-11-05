import { describe, expect, it } from 'vitest';
import { clipPass, clipPolylineToCircle, type ClipStroke } from '../../src/export/clip';
import { buildGcode } from '../../src/export/gcode';
import { DEFAULT_GCODE_OPTIONS, type GcodeOptions } from '../../src/export/types';
import { makeToolpath, recipeWith, ringsToolpath } from './fixtures';

const EPS = 1e-9;

function points(s: ClipStroke): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = s.start; i < s.start + s.count; i++) out.push([s.x[i], s.y[i], s.z ? s.z[i] : 0]);
  return out;
}

function arrays(pts: [number, number][]): { x: Float64Array; y: Float64Array } {
  return { x: Float64Array.from(pts, (p) => p[0]), y: Float64Array.from(pts, (p) => p[1]) };
}

/** Deterministic pseudo-random numbers. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('clipPolylineToCircle', () => {
  it('returns a polyline that is entirely inside unchanged (same arrays, range and closed flag)', () => {
    const { x, y } = arrays([[0, 0], [3, 1], [-2, 4], [1, -4]]);
    const z = new Float64Array([0.1, 0.2, 0.3, 0.4]);
    for (const closed of [false, true]) {
      const out = clipPolylineToCircle(x, y, z, 0, 4, closed, 5);
      expect(out.length).toBe(1);
      expect(out[0].x).toBe(x);
      expect(out[0].y).toBe(y);
      expect(out[0].z).toBe(z);
      expect(out[0].start).toBe(0);
      expect(out[0].count).toBe(4);
      expect(out[0].closed).toBe(closed);
    }
    // a sub-range of a bigger array keeps its range
    const big = arrays([[100, 0], [1, 1], [2, 2], [100, 100]]);
    const sub = clipPolylineToCircle(big.x, big.y, null, 1, 2, false, 5);
    expect(sub).toEqual([{ x: big.x, y: big.y, z: null, start: 1, count: 2, closed: false }]);
  });

  it('drops a polyline that never touches the disc', () => {
    const { x, y } = arrays([[10, 10], [20, 10], [20, 20]]);
    expect(clipPolylineToCircle(x, y, null, 0, 3, false, 5)).toEqual([]);
    expect(clipPolylineToCircle(x, y, null, 0, 3, true, 5)).toEqual([]);
  });

  it('splits at the rim with the crossing points on the circle', () => {
    // a horizontal line through the disc of radius 5 centred at (1, 2)
    const { x, y } = arrays([[-10, 2], [-3, 2], [0, 2], [3, 2], [10, 2]]);
    const z = new Float64Array([0, 0.7, 1, 0.3, 0]);
    const out = clipPolylineToCircle(x, y, z, 0, 5, false, 5, 1, 2);
    expect(out.length).toBe(1);
    const p = points(out[0]);
    expect(p.length).toBe(5);
    expect(p[0][0]).toBeCloseTo(-4, 12);
    expect(p[4][0]).toBeCloseTo(6, 12);
    for (const q of [p[0], p[4]]) expect(Math.hypot(q[0] - 1, q[1] - 2)).toBeCloseTo(5, 12);
    // z is interpolated with the crossing: x = −4 is 6/7 of the way from −10 to −3
    expect(p[0][2]).toBeCloseTo(0.7 * (6 / 7), 12);
    expect(out[0].closed).toBe(false);
  });

  it('keeps a chord between two outside samples', () => {
    const { x, y } = arrays([[-10, 3], [10, 3]]);
    const out = clipPolylineToCircle(x, y, null, 0, 2, false, 5);
    expect(out.length).toBe(1);
    const p = points(out[0]);
    expect(p.map((q) => q[0])).toEqual([expect.closeTo(-4, 12), expect.closeTo(4, 12)]);
    for (const q of p) expect(Math.hypot(q[0], q[1])).toBeCloseTo(5, 12);
    // a tangent touch is not a stroke
    const t = arrays([[-10, 5], [10, 5]]);
    expect(clipPolylineToCircle(t.x, t.y, null, 0, 2, false, 5)).toEqual([]);
  });

  it('opens a closed loop that crosses the rim into pieces that never wrap around its start', () => {
    // circle of radius 10 centred at (8, 0), sampled from its rightmost point (outside a radius-10 disc at 0)
    const n = 720;
    const pts: [number, number][] = [];
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n;
      pts.push([8 + 10 * Math.cos(a), 10 * Math.sin(a)]);
    }
    // start the loop inside the disc so the wrap point is inside
    const rot = pts.slice(n / 2).concat(pts.slice(0, n / 2));
    const { x, y } = arrays(rot);
    const out = clipPolylineToCircle(x, y, null, 0, n, true, 10);
    expect(out.length).toBe(1);
    expect(out[0].closed).toBe(false);
    const p = points(out[0]);
    expect(Math.hypot(p[0][0], p[0][1])).toBeCloseTo(10, 9);
    expect(Math.hypot(p[p.length - 1][0], p[p.length - 1][1])).toBeCloseTo(10, 9);
    // the arc inside: the circles cross at x = 4, i.e. ±(π − acos(0.4)) around (8, 0) → arc 2·acos(-0.4)·10... check by length
    let len = 0;
    for (let k = 1; k < p.length; k++) len += Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]);
    const half = Math.acos(-0.4); // angle from +x at which (8 + 10cos, 10 sin) has |p| = 10
    const exact = 10 * 2 * (Math.PI - half);
    expect(len).toBeCloseTo(exact, 2);
  });

  it('never leaves the disc and keeps every inside sample (random polylines)', () => {
    const rand = rng(7);
    for (let trial = 0; trial < 200; trial++) {
      const n = 2 + Math.floor(rand() * 60);
      const pts: [number, number][] = [];
      for (let k = 0; k < n; k++) pts.push([(rand() - 0.5) * 30, (rand() - 0.5) * 30]);
      const { x, y } = arrays(pts);
      const R = 3 + rand() * 9;
      const cx = (rand() - 0.5) * 4;
      const cy = (rand() - 0.5) * 4;
      const closed = rand() < 0.5;
      const out = clipPolylineToCircle(x, y, null, 0, n, closed, R, cx, cy);
      let insideSamples = 0;
      for (const [px, py] of pts) if (Math.hypot(px - cx, py - cy) <= R) insideSamples++;
      let kept = 0;
      for (const s of out) {
        const p = points(s);
        expect(p.length).toBeGreaterThanOrEqual(2);
        for (const [px, py] of p) {
          expect(Math.hypot(px - cx, py - cy)).toBeLessThanOrEqual(R + EPS * R);
          if (pts.some((q) => q[0] === px && q[1] === py)) kept++;
        }
        // segment midpoints too (the disc is convex, but check the pieces really are inside runs)
        for (let k = 1; k < p.length; k++) {
          const mx = (p[k][0] + p[k - 1][0]) / 2 - cx;
          const my = (p[k][1] + p[k - 1][1]) / 2 - cy;
          expect(Math.hypot(mx, my)).toBeLessThanOrEqual(R + EPS * R);
        }
        if (s.x !== x) {
          // a clipped piece: ends that are not original samples lie on the rim
          for (const q of [p[0], p[p.length - 1]]) {
            if (!pts.some((o) => o[0] === q[0] && o[1] === q[1])) expect(Math.hypot(q[0] - cx, q[1] - cy)).toBeCloseTo(R, 9);
          }
        }
      }
      // every inside sample shows up (a closed loop's wrap sample may show up twice)
      expect(kept).toBeGreaterThanOrEqual(insideSamples);
    }
  });

  it('treats non-finite samples as gaps', () => {
    const { x, y } = arrays([[0, 0], [1, 0], [NaN, 0], [2, 0], [3, 0]]);
    const out = clipPolylineToCircle(x, y, null, 0, 5, false, 10);
    expect(out.map((s) => points(s).map((p) => p[0]))).toEqual([[0, 1], [2, 3]]);
  });

  it('clipPass reads one pass of a toolpath', () => {
    const tp = ringsToolpath({ passes: 2, samples: 64, r0: 10, r1: 60, amplitude: 0 });
    expect(clipPass(tp, tp.passes[0], 50)[0].x).toBe(tp.x); // inside: no copy
    expect(clipPass(tp, tp.passes[1], 50)).toEqual([]); // a ring at r = 60 is off a 50 mm plate
  });
});

describe('exports clip at the plate edge', () => {
  const pen: GcodeOptions = { ...DEFAULT_GCODE_OPTIONS, tolerance: 0 };
  const recipe = recipeWith((r) => {
    r.machine.workDiameter = 100;
  });
  // rings whose centres sit 25 mm off the work centre: the outer ones cross the 50 mm rim
  const wide = ringsToolpath({ passes: 3, samples: 256, r0: 20, r1: 30, divisions: 4, offset: 25, amplitude: 0 });
  // 12-lobed rings around the rim: each one leaves and re-enters the plate 12 times
  const wavy = ringsToolpath({ passes: 2, samples: 720, r0: 49.2, r1: 49.6, lobes: 12, amplitude: 1.2 });

  it('G-code: every move stays on the plate and the pen lifts where a pass leaves it', () => {
    const { text, stats } = buildGcode(recipe, wavy, pen);
    const lines = text.split('\n');
    let down = false;
    let pos: [number, number] = [0, 0];
    let downs = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (line === pen.penDown) {
        down = true;
        downs++;
        // the pen goes down on the plate
        expect(Math.hypot(pos[0], pos[1])).toBeLessThanOrEqual(50 + 1e-3);
        continue;
      }
      if (line === pen.penUp) {
        down = false;
        continue;
      }
      const m = /^G([01]) X(\S+) Y(\S+)/.exec(line);
      if (!m) continue;
      pos = [Number(m[2]), Number(m[3])];
      if (m[1] === '1') {
        expect(down).toBe(true);
        expect(Math.hypot(pos[0], pos[1])).toBeLessThanOrEqual(50 + 1e-3);
      }
    }
    // one pen-down per piece: each ring is split into 12 lobe tips' worth of pieces
    expect(downs).toBe(2 * 12);
    expect(stats.bounds.maxX).toBeLessThanOrEqual(50 + 1e-3);
    expect(stats.bounds.minY).toBeGreaterThanOrEqual(-50 - 1e-3);
  });

  it('G-code stats: draw length and time are those of the clipped paths', () => {
    const big = recipeWith((r) => {
      r.machine.workDiameter = 400;
    });
    const unclipped = buildGcode(big, wide, pen).stats;
    const clipped = buildGcode(recipe, wide, pen).stats;
    expect(unclipped.drawLength).toBeCloseTo(4 * 2 * Math.PI * (20 + 25 + 30), -1);
    expect(clipped.drawLength).toBeLessThan(unclipped.drawLength * 0.95);
    expect(clipped.estimatedSeconds).toBeLessThan(unclipped.estimatedSeconds);
    // a single ring crossing the rim: the clipped length is the arc inside
    const one = makeToolpath([
      {
        points: Array.from({ length: 4096 }, (_, k) => {
          const a = (2 * Math.PI * k) / 4096;
          return [40 + 20 * Math.cos(a), 20 * Math.sin(a)] as [number, number];
        }),
        closed: true,
      },
    ]);
    const s = buildGcode(recipe, one, pen).stats;
    // circles |p| = 50 and |p − (40, 0)| = 20 meet where cos a = (50² − 40² − 20²)/(2·40·20) = 0.3125
    const a = Math.acos((50 * 50 - 40 * 40 - 20 * 20) / (2 * 40 * 20));
    expect(s.drawLength).toBeCloseTo(20 * 2 * (Math.PI - a), 1);
  });

  it('CNC: retracts to safe Z at the rim and plunges again where the pass comes back', () => {
    const cnc: GcodeOptions = { ...DEFAULT_GCODE_OPTIONS, profile: 'cnc', tolerance: 0 };
    const { text } = buildGcode(recipe, wavy, cnc);
    const retracts = (text.match(/^G0 Z/gm) ?? []).length;
    const plunges = (text.match(/^G1 Z\S+ F/gm) ?? []).length;
    expect(plunges).toBe(2 * 12);
    expect(retracts).toBe(plunges + 1); // + the initial safe Z
    for (const m of text.matchAll(/^G1 X(\S+) Y(\S+)/gm)) expect(Math.hypot(Number(m[1]), Number(m[2]))).toBeLessThanOrEqual(50 + 1e-3);
  });
});
