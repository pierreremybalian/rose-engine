import { describe, expect, it } from 'vitest';
import { buildStrokeMesh, indexRange, MITER_MAX, passAt, pointAtSample } from '../../src/render/strokeMesh';
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

describe('buildStrokeMesh', () => {
  it('has two vertices per sample plus a closing pair per closed pass, and no joins between strokes', () => {
    const tp = toolpath([{ n: 16, closed: true, r: 5 }, { n: 10, closed: false, r: 8 }]);
    const m = buildStrokeMesh(tp);
    const pos = m.geometry.getAttribute('position');
    expect(pos.count).toBe(2 * 16 + 2 + 2 * 10);
    // closed: 16 segments, open: 9 segments
    expect(m.segments[0]).toBe(16);
    expect(m.segments[1]).toBe(9);
    expect(m.totalIndices).toBe(6 * (16 + 9));
    // no triangle mixes vertices of the two strokes
    const idx = m.geometry.getIndex()!.array;
    const firstOfSecond = 2 * 16 + 2;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] >= firstOfSecond, b = idx[t + 1] >= firstOfSecond, c = idx[t + 2] >= firstOfSecond;
      expect(a === b && b === c).toBe(true);
    }
  });

  it('closes loops with a duplicate of the first sample whose sample index is start + count', () => {
    const tp = toolpath([{ n: 8, closed: true, r: 3 }]);
    const m = buildStrokeMesh(tp);
    const sample = m.geometry.getAttribute('aSample');
    const side = m.geometry.getAttribute('aSide');
    const pos = m.geometry.getAttribute('position');
    expect(sample.getX(16)).toBe(8);
    expect(sample.getX(17)).toBe(8);
    expect(pos.getX(16)).toBeCloseTo(pos.getX(0));
    expect(pos.getY(16)).toBeCloseTo(pos.getY(0));
    expect(side.getX(0)).toBe(-1);
    expect(side.getX(1)).toBe(1);
  });

  it('stores unit-ish tangents along the curve', () => {
    const tp = toolpath([{ n: 64, closed: true, r: 10 }]);
    const m = buildStrokeMesh(tp);
    const t = m.geometry.getAttribute('aTangent');
    for (let v = 0; v < 128; v += 2) {
      const tx = t.getX(v) * MITER_MAX, ty = t.getY(v) * MITER_MAX;
      const len = Math.hypot(tx, ty);
      expect(len).toBeGreaterThan(0.99);
      expect(len).toBeLessThan(1.01);
      // tangent ⟂ radius for a circle
      const px = tp.x[v / 2], py = tp.y[v / 2];
      expect(Math.abs(tx * px + ty * py) / 10).toBeLessThan(0.06);
    }
  });
});

describe('indexRange / passAt / pointAtSample', () => {
  const tp = toolpath([{ n: 10, closed: true, r: 2 }, { n: 10, closed: true, r: 4 }, { n: 10, closed: false, r: 6 }]);
  const m = buildStrokeMesh(tp);

  it('finds the pass of a sample', () => {
    expect(passAt(m.passStart, 0)).toBe(0);
    expect(passAt(m.passStart, 9.5)).toBe(0);
    expect(passAt(m.passStart, 10)).toBe(1);
    expect(passAt(m.passStart, 29)).toBe(2);
  });

  it('covers everything for the full range and nothing for an empty one', () => {
    expect(indexRange(m, -1, tp.totalSamples + 1)).toEqual({ start: 0, count: m.totalIndices });
    expect(indexRange(m, 5, 4).count).toBe(0);
  });

  it('grows monotonically with progress and includes the partial segment', () => {
    let prev = -1;
    for (let s = 0; s <= tp.totalSamples; s += 0.5) {
      const r = indexRange(m, -1, s);
      expect(r.count).toBeGreaterThanOrEqual(prev);
      prev = r.count;
    }
    // progress 3.5 inside pass 0 → segments 0..3 (4 quads)
    expect(indexRange(m, -1, 3.5).count).toBe(24);
    // the closing segment of pass 0 reveals between 9 and 10
    expect(indexRange(m, -1, 9.5).count).toBe(60);
  });

  it('incremental ranges stay within the full range', () => {
    const a = indexRange(m, 12.3, 17.8);
    expect(a.start).toBeGreaterThanOrEqual(indexRange(m, -1, 10).count - 6);
    expect(a.start + a.count).toBeLessThanOrEqual(indexRange(m, -1, 17.8).count);
  });

  it('interpolates the tool point, following the closing segment', () => {
    const p = { x: 0, y: 0 };
    pointAtSample(tp, m.passStart, 0, p);
    expect(p.x).toBeCloseTo(2);
    pointAtSample(tp, m.passStart, 9.5, p);
    // halfway between sample 9 and sample 0 of pass 0
    expect(p.x).toBeCloseTo((tp.x[9] + tp.x[0]) / 2, 4);
    pointAtSample(tp, m.passStart, tp.totalSamples, p);
    expect(p.x).toBeCloseTo(tp.x[29], 4);
  });
});
