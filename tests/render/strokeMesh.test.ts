import { describe, expect, it } from 'vitest';
import {
  buildSegmentMesh,
  OPEN_END,
  passAt,
  pointAtSample,
  SEG_TEX_WIDTH,
  SEG_VERTS,
  segmentRange,
} from '../../src/render/strokeMesh';
import type { Pass, Toolpath } from '../../src/engine/types';

function toolpath(strokes: { n: number; closed: boolean; r: number }[]): Toolpath {
  const total = strokes.reduce((a, s) => a + s.n, 0);
  const x = new Float32Array(total);
  const y = new Float32Array(total);
  const z = new Float32Array(total);
  const theta = new Float32Array(total);
  const passes: Pass[] = [];
  let k = 0;
  strokes.forEach((s, i) => {
    passes.push({ index: i, division: 0, slidePass: i, closed: s.closed, start: k, count: s.n });
    for (let j = 0; j < s.n; j++, k++) {
      const a = (2 * Math.PI * j) / s.n;
      x[k] = s.r * Math.cos(-a);
      y[k] = s.r * Math.sin(-a);
      theta[k] = 2 * Math.PI * i + a;
    }
  });
  return {
    x, y, z, theta, passes,
    samplesPerRev: strokes[0]?.n ?? 1,
    totalSamples: total,
    zMin: 0, zMax: 0,
    bounds: { minX: -10, minY: -10, maxX: 10, maxY: 10 },
    totalLength: 0,
  };
}

describe('passAt / pointAtSample', () => {
  const tp = toolpath([{ n: 10, closed: true, r: 2 }, { n: 10, closed: true, r: 4 }, { n: 10, closed: false, r: 6 }]);
  const passStart = Uint32Array.from(tp.passes, (p) => p.start);

  it('finds the pass of a sample', () => {
    expect(passAt(passStart, 0)).toBe(0);
    expect(passAt(passStart, 9.5)).toBe(0);
    expect(passAt(passStart, 10)).toBe(1);
    expect(passAt(passStart, 29)).toBe(2);
  });

  it('interpolates the tool point, following the closing segment', () => {
    const p = { x: 0, y: 0 };
    pointAtSample(tp, passStart, 0, p);
    expect(p.x).toBeCloseTo(2);
    pointAtSample(tp, passStart, 9.5, p);
    // halfway between sample 9 and sample 0 of pass 0
    expect(p.x).toBeCloseTo((tp.x[9] + tp.x[0]) / 2, 4);
    pointAtSample(tp, passStart, tp.totalSamples, p);
    expect(p.x).toBeCloseTo(tp.x[29], 4);
  });
});

describe('buildSegmentMesh', () => {
  const tp = toolpath([{ n: 16, closed: true, r: 5 }, { n: 10, closed: false, r: 8 }, { n: 12, closed: true, r: 9 }]);
  const m = buildSegmentMesh(tp);
  const pts = m.points.image.data as Float32Array;
  const turns = m.turns.image.data as Float32Array;
  const turn = (e: number) => turns[e * 4];

  it('has one entry per sample plus a closing copy per closed pass, in rows of SEG_TEX_WIDTH', () => {
    expect(m.entries).toBe(16 + 1 + 10 + 12 + 1);
    expect(m.points.image.width).toBe(SEG_TEX_WIDTH);
    expect(m.points.image.height).toBe(1);
    expect(Array.from(m.entryStart)).toEqual([0, 17, 27]);
    expect(Array.from(m.segments)).toEqual([16, 9, 12]);
    expect(m.geometry.drawRange.count).toBe(m.entries * SEG_VERTS);
    expect(m.geometry.getAttribute('position')).toBeUndefined();
  });

  it('wraps entries onto further rows', () => {
    const big = toolpath([{ n: 3000, closed: true, r: 20 }]);
    const b = buildSegmentMesh(big);
    expect(b.entries).toBe(3001);
    expect(b.points.image.height).toBe(2);
    expect(b.turns.image.height).toBe(2);
  });

  it('stores positions, pump and sample index; the last entry of each pass starts no segment', () => {
    // closing copy of pass 0: the first sample again, sample index start + count, flagged
    expect(pts[16 * 4]).toBeCloseTo(tp.x[0]);
    expect(pts[16 * 4 + 1]).toBeCloseTo(tp.y[0]);
    expect(pts[16 * 4 + 3]).toBe(-1 - 16);
    for (let e = 0; e < 16; e++) expect(pts[e * 4 + 3]).toBe(e);
    // open pass: entries 17..26 are samples 16..25, the last one flagged
    expect(pts[17 * 4 + 3]).toBe(16);
    expect(pts[25 * 4 + 3]).toBe(24);
    expect(pts[26 * 4 + 3]).toBe(-1 - 25);
    expect(pts[39 * 4 + 3]).toBe(-1 - 38);
  });

  it('stores the signed turn at every entry, wrapping round closed loops; open ends are marked', () => {
    // a regular 16-gon traversed clockwise (the fixture walks −a) turns −2π/16 at every vertex, seam included
    for (let e = 0; e <= 16; e++) expect(turn(e)).toBeCloseTo((-2 * Math.PI) / 16, 5);
    expect(turn(17)).toBe(OPEN_END);
    expect(turn(26)).toBe(OPEN_END);
    for (let e = 18; e < 26; e++) expect(turn(e)).toBeCloseTo((-2 * Math.PI) / 10, 5);
  });

  it('stores the global pass index of every entry (ink colour)', () => {
    for (let e = 0; e < m.entries; e++) {
      const pass = e < 17 ? 0 : e < 27 ? 1 : 2;
      expect(turns[e * 4 + 1]).toBe(pass);
    }
  });

  it('stores the neighbouring entries along the path, round closed loops', () => {
    const prev = (e: number) => turns[e * 4 + 2];
    const next = (e: number) => turns[e * 4 + 3];
    // closed pass 0: entries 0..16 (16 = closing copy of sample 0)
    expect(prev(0)).toBe(15);
    expect(next(0)).toBe(1);
    expect(prev(5)).toBe(4);
    expect(next(15)).toBe(16);
    expect(prev(16)).toBe(15);
    expect(next(16)).toBe(1);
    // open pass 1: entries 17..26
    expect(prev(17)).toBe(-1);
    expect(next(17)).toBe(18);
    expect(next(26)).toBe(-1);
    expect(prev(26)).toBe(25);
  });

  it('turns skip zero-length segments (repeated samples)', () => {
    const sq = toolpath([{ n: 4, closed: false, r: 1 }]);
    // an L: (0,0) (1,0) (1,0) (1,1) — the repeated corner sample turns +90° on both of its entries
    sq.x.set([0, 1, 1, 1]);
    sq.y.set([0, 0, 0, 1]);
    const t = buildSegmentMesh(sq).turns.image.data as Float32Array;
    expect(t[0]).toBe(OPEN_END);
    expect(t[4]).toBeCloseTo(Math.PI / 2, 6);
    expect(t[8]).toBeCloseTo(Math.PI / 2, 6);
    expect(t[12]).toBe(OPEN_END);
  });

  it('draw ranges count vertices: whole passes, partial segments, and incremental ranges', () => {
    const segs = (r: { start: number; count: number }) => r.count / SEG_VERTS;
    expect(segmentRange(m, -1, tp.totalSamples + 1)).toEqual({ start: 0, count: m.entries * SEG_VERTS });
    expect(segmentRange(m, 5, 4).count).toBe(0);
    expect(segmentRange(m, -1, 0).count).toBe(0);
    // progress 3.5 inside pass 0 → segments 0..3
    expect(segs(segmentRange(m, -1, 3.5))).toBe(4);
    // the closing segment of pass 0 (entry 15 → 16) reveals between 15 and 16
    expect(segs(segmentRange(m, -1, 15.5))).toBe(16);
    // into pass 1 (sample 16 is its first): pass 0's 17 entries, then pass 1's segments 0..1
    expect(segs(segmentRange(m, -1, 17.5))).toBe(17 + 2);
    // incremental: starts at most one segment before the first one needed, ends where the full range does
    for (const [a, b] of [[12.3, 17.8], [20, 30.2], [27, 38.9]]) {
      const r = segmentRange(m, a, b);
      const full = segmentRange(m, -1, b);
      expect(r.start % SEG_VERTS).toBe(0);
      expect(r.start + r.count).toBe(full.count);
      const p = passAt(m.passStart, a);
      const firstNeeded = m.entryStart[p] + Math.floor(a - m.passStart[p]);
      expect(r.start / SEG_VERTS).toBeLessThanOrEqual(firstNeeded);
      expect(r.start / SEG_VERTS).toBeGreaterThanOrEqual(firstNeeded - 1);
    }
    let prev = -1;
    for (let s = 0; s <= tp.totalSamples; s += 0.25) {
      const r = segmentRange(m, -1, s);
      expect(r.count).toBeGreaterThanOrEqual(prev);
      prev = r.count;
    }
  });
});
