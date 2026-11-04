import { describe, expect, it } from 'vitest';
import { simplifyPolyline } from '../../src/engine';

describe('simplifyPolyline', () => {
  it('keeps endpoints and removes collinear points (open)', () => {
    const xs: number[] = [];
    const ys: number[] = [];
    // 5 junk points before the slice, then an L shape: 0..10 along x, then up 10 in y.
    for (let i = 0; i < 5; i++) {
      xs.push(99);
      ys.push(99);
    }
    for (let i = 0; i <= 10; i++) {
      xs.push(i);
      ys.push(0);
    }
    for (let i = 1; i <= 10; i++) {
      xs.push(10);
      ys.push(i);
    }
    const kept = simplifyPolyline(xs, ys, 5, 21, 0.01, false);
    expect(kept).toEqual([5, 15, 25]);
  });

  it('keeps points that deviate more than the tolerance', () => {
    const xs = [0, 1, 2, 3, 4];
    const ys = [0, 0.02, 0.3, 0.15, 0]; // point 3 is collinear with 2 and 4
    expect(simplifyPolyline(xs, ys, 0, 5, 0.15, false)).toEqual([0, 2, 4]);
    expect(simplifyPolyline(xs, ys, 0, 5, 0.01, false)).toEqual([0, 1, 2, 4]);
  });

  it('closed loops: a densely sampled square reduces to its corners', () => {
    const xs: number[] = [];
    const ys: number[] = [];
    const side = (x0: number, y0: number, x1: number, y1: number) => {
      for (let i = 0; i < 25; i++) {
        xs.push(x0 + ((x1 - x0) * i) / 25);
        ys.push(y0 + ((y1 - y0) * i) / 25);
      }
    };
    side(-1, -1, 1, -1);
    side(1, -1, 1, 1);
    side(1, 1, -1, 1);
    side(-1, 1, -1, -1);
    const kept = simplifyPolyline(xs, ys, 0, 100, 1e-6, true);
    expect(kept).toEqual([0, 25, 50, 75]);
  });

  it('closed loops: a circle keeps enough points and starts at the first sample', () => {
    const n = 2000;
    const xs = new Float32Array(n);
    const ys = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = 20 * Math.cos((i / n) * Math.PI * 2);
      ys[i] = 20 * Math.sin((i / n) * Math.PI * 2);
    }
    const kept = simplifyPolyline(xs, ys, 0, n, 0.01, true);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBeLessThan(n);
    // Chord sagitta 0.01 on r=20 needs a step of ~2*sqrt(2*20*0.01) mm => ~100 points.
    expect(kept.length).toBeGreaterThan(60);
    expect(kept.length).toBeLessThan(300);
    for (let i = 1; i < kept.length; i++) expect(kept[i]).toBeGreaterThan(kept[i - 1]);
  });

  it('tiny inputs', () => {
    expect(simplifyPolyline([0], [0], 0, 1, 0.1, false)).toEqual([0]);
    expect(simplifyPolyline([0, 1], [0, 1], 0, 2, 0.1, true)).toEqual([0, 1]);
    expect(simplifyPolyline([], [], 0, 0, 0.1, false)).toEqual([]);
  });
});
