// Tilted-plate camera model for the flat work view.
//
// The flat view is an orthographic window onto the display plane (z = 0, mm). Tilting keeps that window and
// adds a perspective eye where the flat metal shader already puts its virtual eye: above the work centre,
// EYE_HEIGHT × diameter up. A plane parallel to the window projects through that eye exactly like the
// orthographic camera, so tilt 0 lines up pixel for pixel with the flat view, and the shading view vectors
// are the ones the flat view fakes. The plate turns rigidly about its pivot, the plate point under the view
// centre (clamped onto the disc), so whatever is centred stays centred while the plate tilts.
//
// Frames: "plate" = display-frame mm before tilting (x right, y up, the plate at z = 0); "world" = the same
// axes after tilting, +z toward the viewer; "window" = the z = 0 plane the orthographic view looks at;
// "screen" = device pixels in the work viewport, origin top-left, y down.
import * as THREE from 'three';
import type { Tilt } from '../state/store';

/** Largest tilt in any direction, degrees. */
export const MAX_TILT = 40;
/** Eye height over the plate, × work diameter: the flat metal view's virtual eye. */
export const EYE_HEIGHT = 2.4;
const DEG = Math.PI / 180;

/** Clamp a tilt to the MAX_TILT disc (non-finite components become 0). */
export function clampTilt(t: Tilt): Tilt {
  const x = Number.isFinite(t.x) ? t.x : 0;
  const y = Number.isFinite(t.y) ? t.y : 0;
  const m = Math.hypot(x, y);
  if (m <= MAX_TILT) return { x, y };
  const k = MAX_TILT / m;
  return { x: x * k, y: y * k };
}

export function isTilted(t: Tilt): boolean {
  return Math.abs(t.x) > 1e-4 || Math.abs(t.y) > 1e-4;
}

export interface ViewWindow {
  cx: number;
  cy: number;
  mmPerPx: number;
  width: number;
  height: number;
}

/** Plate-frame rectangle (mm) and the density (device px per mm) a plate-space render needs to stay sharp. */
export interface PlateRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  density: number;
}

export interface Pt {
  x: number;
  y: number;
}

const RIM_SAMPLES = 24;
const GRID = 8;

export class TiltProjection {
  // view window
  cx = 0;
  cy = 0;
  mm = 0.1;
  width = 1;
  height = 1;
  /** Work centre (display frame) and disc radius, mm. */
  wx = 0;
  wy = 0;
  radius = 50;
  /** Eye position, mm. */
  ex = 0;
  ey = 0;
  ez = 240;
  /** Pivot (plate frame): the plate point that stays put while tilting. */
  px = 0;
  py = 0;
  tiltX = 0;
  tiltY = 0;
  /** Plate → world rotation, row-major: R = Ry(tilt.y) · Rx(tilt.x). */
  readonly r = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  private readonly a: Pt = { x: 0, y: 0 };
  private readonly b: Pt = { x: 0, y: 0 };
  private readonly c: Pt = { x: 0, y: 0 };

  set(view: ViewWindow, tilt: Tilt, wx: number, wy: number, diameter: number): this {
    this.cx = view.cx;
    this.cy = view.cy;
    this.mm = view.mmPerPx;
    this.width = view.width;
    this.height = view.height;
    this.wx = wx;
    this.wy = wy;
    this.radius = Math.max(1e-6, diameter / 2);
    this.ex = wx;
    this.ey = wy;
    this.ez = EYE_HEIGHT * Math.max(1e-6, diameter);
    const dx = this.cx - wx;
    const dy = this.cy - wy;
    const d = Math.hypot(dx, dy);
    const k = d > this.radius ? this.radius / d : 1;
    this.px = wx + dx * k;
    this.py = wy + dy * k;
    return this.setTilt(tilt.x, tilt.y);
  }

  setTilt(xDeg: number, yDeg: number): this {
    this.tiltX = xDeg;
    this.tiltY = yDeg;
    const a = xDeg * DEG;
    const b = yDeg * DEG;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const cb = Math.cos(b);
    const sb = Math.sin(b);
    const r = this.r;
    r[0] = cb;
    r[1] = sb * sa;
    r[2] = sb * ca;
    r[3] = 0;
    r[4] = ca;
    r[5] = -sa;
    r[6] = -sb;
    r[7] = cb * sa;
    r[8] = cb * ca;
    return this;
  }

  copy(o: TiltProjection): this {
    this.cx = o.cx;
    this.cy = o.cy;
    this.mm = o.mm;
    this.width = o.width;
    this.height = o.height;
    this.wx = o.wx;
    this.wy = o.wy;
    this.radius = o.radius;
    this.ex = o.ex;
    this.ey = o.ey;
    this.ez = o.ez;
    this.px = o.px;
    this.py = o.py;
    return this.setTilt(o.tiltX, o.tiltY);
  }

  /** Plate normal in world space (x, y, z). */
  normal(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.r[2], this.r[5], this.r[8]);
  }

  /** Screen pixel → point on the window plane (z = 0). */
  screenToWindow(sx: number, sy: number, out: Pt): Pt {
    out.x = this.cx + (sx - this.width / 2) * this.mm;
    out.y = this.cy - (sy - this.height / 2) * this.mm;
    return out;
  }

  windowToScreen(qx: number, qy: number, out: Pt): Pt {
    out.x = this.width / 2 + (qx - this.cx) / this.mm;
    out.y = this.height / 2 - (qy - this.cy) / this.mm;
    return out;
  }

  /** Plate point → where it shows on the window plane (seen from the eye). False if at or behind the eye. */
  plateToWindow(x: number, y: number, out: Pt): boolean {
    const r = this.r;
    const u = x - this.px;
    const v = y - this.py;
    const wx = this.px + r[0] * u + r[1] * v;
    const wy = this.py + r[3] * u + r[4] * v;
    const wz = r[6] * u + r[7] * v;
    const depth = this.ez - wz;
    if (!(depth > 1e-9)) return false;
    const f = this.ez / depth;
    out.x = this.ex + (wx - this.ex) * f;
    out.y = this.ey + (wy - this.ey) * f;
    return true;
  }

  plateToScreen(x: number, y: number, out: Pt): boolean {
    if (!this.plateToWindow(x, y, out)) return false;
    this.windowToScreen(out.x, out.y, out);
    return true;
  }

  /** Window point → the plate point seen through it. False when the eye ray misses the plate plane. */
  windowToPlate(qx: number, qy: number, out: Pt): boolean {
    const r = this.r;
    const nx = r[2];
    const ny = r[5];
    const nz = r[8];
    const dx = qx - this.ex;
    const dy = qy - this.ey;
    const dz = -this.ez;
    const denom = nx * dx + ny * dy + nz * dz;
    const k = nx * (this.px - this.ex) + ny * (this.py - this.ey) - nz * this.ez;
    const s = k / denom;
    if (!(s > 0) || !Number.isFinite(s)) return false;
    // world hit relative to the pivot, then back through Rᵀ
    const rx = this.ex + s * dx - this.px;
    const ry = this.ey + s * dy - this.py;
    const rz = this.ez + s * dz;
    out.x = this.px + r[0] * rx + r[3] * ry + r[6] * rz;
    out.y = this.py + r[1] * rx + r[4] * ry + r[7] * rz;
    return true;
  }

  screenToPlate(sx: number, sy: number, out: Pt): boolean {
    this.screenToWindow(sx, sy, out);
    return this.windowToPlate(out.x, out.y, out);
  }

  /** Largest on-screen magnification (device px per plate mm, any direction) at a plate point. */
  magnification(x: number, y: number): number {
    const h = this.mm;
    const { a, b, c } = this;
    if (!this.plateToScreen(x, y, a) || !this.plateToScreen(x + h, y, b) || !this.plateToScreen(x, y + h, c)) return 0;
    const j11 = (b.x - a.x) / h;
    const j21 = (b.y - a.y) / h;
    const j12 = (c.x - a.x) / h;
    const j22 = (c.y - a.y) / h;
    const p = j11 * j11 + j21 * j21;
    const q = j12 * j12 + j22 * j22;
    const s = j11 * j12 + j21 * j22;
    return Math.sqrt((p + q) / 2 + Math.sqrt(((p - q) / 2) ** 2 + s * s));
  }

  /**
   * The plate region a plate-space render must cover for this view (the visible part of the disc, plus a
   * couple of texels), and the density that keeps it at least device-pixel sharp everywhere on screen.
   * False when no part of the disc is in view.
   */
  needRegion(out: PlateRegion): boolean {
    const R = this.radius;
    const pad = 2 * this.mm;
    const m = R * 1.02 + pad;
    let x0 = this.wx - m;
    let x1 = this.wx + m;
    let y0 = this.wy - m;
    let y1 = this.wy + m;
    const p = this.a;
    let qx0 = Infinity;
    let qx1 = -Infinity;
    let qy0 = Infinity;
    let qy1 = -Infinity;
    let bounded = true;
    for (let i = 0; i < 4 && bounded; i++) {
      if (!this.screenToPlate(i & 1 ? this.width : 0, i & 2 ? this.height : 0, p)) bounded = false;
      else {
        qx0 = Math.min(qx0, p.x);
        qx1 = Math.max(qx1, p.x);
        qy0 = Math.min(qy0, p.y);
        qy1 = Math.max(qy1, p.y);
      }
    }
    // The visible part of a plane through a frustum is the quad of the corner rays (when they all reach it).
    if (bounded) {
      x0 = Math.max(x0, qx0 - pad);
      x1 = Math.min(x1, qx1 + pad);
      y0 = Math.max(y0, qy0 - pad);
      y1 = Math.min(y1, qy1 + pad);
    }
    if (!(x1 > x0 && y1 > y0)) return false;

    let best = 0;
    const R2 = (R * 1.02) ** 2;
    const s = this.b;
    const probe = (x: number, y: number) => {
      if (x < x0 || x > x1 || y < y0 || y > y1) return;
      if ((x - this.wx) ** 2 + (y - this.wy) ** 2 > R2) return;
      if (!this.plateToScreen(x, y, s)) return;
      if (s.x < -2 || s.x > this.width + 2 || s.y < -2 || s.y > this.height + 2) return;
      best = Math.max(best, this.magnification(x, y));
    };
    for (let j = 0; j <= GRID; j++) {
      for (let i = 0; i <= GRID; i++) probe(x0 + ((x1 - x0) * i) / GRID, y0 + ((y1 - y0) * j) / GRID);
    }
    // magnification peaks at the near rim of the disc, so sample the rim too
    for (let i = 0; i < RIM_SAMPLES; i++) {
      const t = (i / RIM_SAMPLES) * Math.PI * 2;
      probe(this.wx + Math.cos(t) * R, this.wy + Math.sin(t) * R);
    }
    out.x0 = x0;
    out.y0 = y0;
    out.x1 = x1;
    out.y1 = y1;
    out.density = best > 0 ? best : 1 / this.mm;
    return true;
  }

  /**
   * Window point → plate point as a homography (row-major into a Matrix3), normalized so that rays that
   * reach the plate plane in front of the eye have w > 0. Used to cast the tilted plate's shadow.
   */
  windowToPlateMatrix(out: THREE.Matrix3): THREE.Matrix3 {
    const r = this.r;
    const { ex, ey, ez, px, py } = this;
    const nx = r[2];
    const ny = r[5];
    const nz = r[8];
    // d = A·(x, y, 1) with A = [[1,0,-ex],[0,1,-ey],[0,0,-ez]]; w = n·d
    const w0 = nx;
    const w1 = ny;
    const w2 = -(nx * ex + ny * ey + nz * ez);
    const k = nx * (px - ex) + ny * (py - ey) - nz * ez;
    // a = pivot + (Rᵀ(E − pivot)).xy
    const vx = ex - px;
    const vy = ey - py;
    const vz = ez;
    const ax = px + r[0] * vx + r[3] * vy + r[6] * vz;
    const ay = py + r[1] * vx + r[4] * vy + r[7] * vz;
    // (Rᵀ A) rows 0 and 1
    const m00 = r[0];
    const m01 = r[3];
    const m02 = -(r[0] * ex + r[3] * ey + r[6] * ez);
    const m10 = r[1];
    const m11 = r[4];
    const m12 = -(r[1] * ex + r[4] * ey + r[7] * ez);
    const sg = k < 0 ? -1 : 1;
    return out.set(
      sg * (ax * w0 + k * m00), sg * (ax * w1 + k * m01), sg * (ax * w2 + k * m02),
      sg * (ay * w0 + k * m10), sg * (ay * w1 + k * m11), sg * (ay * w2 + k * m12),
      sg * w0, sg * w1, sg * w2,
    );
  }

  /** Plate frame → world (the tilt about the pivot), as a Matrix4. */
  plateMatrix(out: THREE.Matrix4): THREE.Matrix4 {
    const r = this.r;
    const { px, py } = this;
    return out.set(
      r[0], r[1], r[2], px - (r[0] * px + r[1] * py),
      r[3], r[4], r[5], py - (r[3] * px + r[4] * py),
      r[6], r[7], r[8], -(r[6] * px + r[7] * py),
      0, 0, 0, 1,
    );
  }

  /** Perspective camera at the eye whose frustum cuts the window plane exactly at the orthographic view. */
  applyCamera(cam: THREE.PerspectiveCamera): void {
    const near = this.ez * 0.05;
    const far = this.ez * 4;
    const k = near / this.ez;
    const hw = (this.width / 2) * this.mm;
    const hh = (this.height / 2) * this.mm;
    cam.position.set(this.ex, this.ey, this.ez);
    cam.quaternion.identity();
    cam.near = near;
    cam.far = far;
    cam.updateMatrixWorld();
    cam.projectionMatrix.makePerspective(
      (this.cx - hw - this.ex) * k,
      (this.cx + hw - this.ex) * k,
      (this.cy + hh - this.ey) * k,
      (this.cy - hh - this.ey) * k,
      near,
      far,
    );
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  }
}
