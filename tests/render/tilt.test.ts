import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { clampTilt, EYE_HEIGHT, isTilted, MAX_TILT, TiltProjection, type PlateRegion } from '../../src/render/tilt';

const VIEW = { cx: 3, cy: -2, mmPerPx: 0.12, width: 1080, height: 777 };

function proj(tilt = { x: 0, y: 0 }, view = VIEW, wx = 0, wy = 0, d = 100) {
  return new TiltProjection().set(view, tilt, wx, wy, d);
}

const region = (): PlateRegion => ({ x0: 0, y0: 0, x1: 0, y1: 0, density: 0 });

describe('clampTilt / isTilted', () => {
  it('clamps radially to MAX_TILT and zeroes non-finite input', () => {
    expect(clampTilt({ x: 10, y: -20 })).toEqual({ x: 10, y: -20 });
    const c = clampTilt({ x: 60, y: 80 });
    expect(Math.hypot(c.x, c.y)).toBeCloseTo(MAX_TILT);
    expect(c.x / c.y).toBeCloseTo(60 / 80);
    expect(clampTilt({ x: NaN, y: Infinity })).toEqual({ x: 0, y: 0 });
  });
  it('treats only a real tilt as tilted', () => {
    expect(isTilted({ x: 0, y: 0 })).toBe(false);
    expect(isTilted({ x: 0, y: 0.01 })).toBe(true);
  });
});

describe('TiltProjection at tilt 0', () => {
  it('is the orthographic flat view', () => {
    const p = proj();
    const q = { x: 0, y: 0 };
    for (const [sx, sy] of [[0, 0], [540, 388.5], [1080, 777], [123.4, 600.2]]) {
      expect(p.screenToPlate(sx, sy, q)).toBe(true);
      expect(q.x).toBeCloseTo(VIEW.cx + (sx - VIEW.width / 2) * VIEW.mmPerPx, 9);
      expect(q.y).toBeCloseTo(VIEW.cy - (sy - VIEW.height / 2) * VIEW.mmPerPx, 9);
    }
  });
  it('needs exactly device-pixel density over the visible part of the disc', () => {
    const r = region();
    expect(proj().needRegion(r)).toBe(true);
    expect(r.density).toBeCloseTo(1 / VIEW.mmPerPx, 6);
    // visible window (±64.8 × ±46.6 mm around (3, −2)) clipped to the disc box (±51 mm)
    expect(r.x0).toBeCloseTo(-51 - 2 * VIEW.mmPerPx, 6);
    expect(r.y1).toBeCloseTo(-2 + (VIEW.height / 2) * VIEW.mmPerPx + 2 * VIEW.mmPerPx, 6);
  });
  it('maps the shadow homography to the identity', () => {
    const m = proj().windowToPlateMatrix(new THREE.Matrix3());
    const v = new THREE.Vector3(12.5, -7, 1).applyMatrix3(m);
    expect(v.x / v.z).toBeCloseTo(12.5, 9);
    expect(v.y / v.z).toBeCloseTo(-7, 9);
  });
});

describe('TiltProjection tilted', () => {
  const T = { x: 25, y: -15 };

  it('round-trips screen → plate → screen', () => {
    const p = proj(T);
    const q = { x: 0, y: 0 };
    const s = { x: 0, y: 0 };
    for (const [sx, sy] of [[0, 0], [540, 388.5], [1080, 777], [200, 650]]) {
      expect(p.screenToPlate(sx, sy, q)).toBe(true);
      expect(p.plateToScreen(q.x, q.y, s)).toBe(true);
      expect(s.x).toBeCloseTo(sx, 6);
      expect(s.y).toBeCloseTo(sy, 6);
    }
  });

  it('keeps the plate point under the view centre in place', () => {
    const q = { x: 0, y: 0 };
    proj(T).screenToPlate(VIEW.width / 2, VIEW.height / 2, q);
    expect(q.x).toBeCloseTo(VIEW.cx, 9);
    expect(q.y).toBeCloseTo(VIEW.cy, 9);
  });

  it('clamps the pivot onto the disc when the view centre is off it', () => {
    const p = proj(T, { ...VIEW, cx: 300, cy: 0 });
    expect(p.px).toBeCloseTo(50, 9);
    expect(p.py).toBeCloseTo(0, 9);
  });

  it('turns the normal the documented way (y faces right, x faces down)', () => {
    const n = proj({ x: 0, y: 20 }).normal(new THREE.Vector3());
    expect(n.x).toBeGreaterThan(0.3);
    const m = proj({ x: 20, y: 0 }).normal(new THREE.Vector3());
    expect(m.y).toBeLessThan(-0.3);
  });

  it('agrees with three.js: plate matrix + camera project where plateToScreen says', () => {
    const p = proj(T, VIEW, 4, -3);
    const cam = new THREE.PerspectiveCamera();
    p.applyCamera(cam);
    expect(cam.position.z).toBeCloseTo(EYE_HEIGHT * 100);
    const M = p.plateMatrix(new THREE.Matrix4());
    const s = { x: 0, y: 0 };
    for (const [x, y] of [[0, 0], [30, -20], [-45, 10]]) {
      const v = new THREE.Vector3(x, y, 0).applyMatrix4(M).project(cam);
      p.plateToScreen(x, y, s);
      expect((v.x * 0.5 + 0.5) * VIEW.width).toBeCloseTo(s.x, 5);
      expect((0.5 - v.y * 0.5) * VIEW.height).toBeCloseTo(s.y, 5);
    }
  });

  it('has a shadow homography consistent with windowToPlate', () => {
    const p = proj(T);
    const m = p.windowToPlateMatrix(new THREE.Matrix3());
    const q = { x: 0, y: 0 };
    for (const [x, y] of [[0, 0], [40, 25], [-60, -30]]) {
      expect(p.windowToPlate(x, y, q)).toBe(true);
      const v = new THREE.Vector3(x, y, 1).applyMatrix3(m);
      expect(v.z).toBeGreaterThan(0);
      expect(v.x / v.z).toBeCloseTo(q.x, 6);
      expect(v.y / v.z).toBeCloseTo(q.y, 6);
    }
  });

  it('asks for more density than flat (the near side is magnified) and covers the visible plate', () => {
    const p = proj({ x: 35, y: 0 }, { ...VIEW, cx: 0, cy: 0 });
    const r = region();
    expect(p.needRegion(r)).toBe(true);
    expect(r.density).toBeGreaterThan(1.05 / VIEW.mmPerPx);
    const q = { x: 0, y: 0 };
    for (const [sx, sy] of [[300, 200], [700, 600], [540, 700]]) {
      p.screenToPlate(sx, sy, q);
      if (Math.hypot(q.x, q.y) > 50) continue;
      expect(q.x).toBeGreaterThanOrEqual(r.x0);
      expect(q.x).toBeLessThanOrEqual(r.x1);
      expect(q.y).toBeGreaterThanOrEqual(r.y0);
      expect(q.y).toBeLessThanOrEqual(r.y1);
    }
  });

  it('reports nothing to render when the disc is out of view', () => {
    expect(proj(T, { ...VIEW, cx: 600, cy: 600 }).needRegion(region())).toBe(false);
  });
});
