// Elliptical and eccentric chuck transforms (pure maths, no allocation in the hot path).
//
// Frames (see types.ts):
//   machine frame: spindle axis at origin, tool fixed on +X.
//   spindle frame: turns with the spindle; machine = rot(+spindleAngle) * spindle.
//   work frame:    centre of the workpiece, +Y up.
//
// Tool point, spindle frame:     P_s = rot(-theta) * (rho, 0),  rho = slideRadius + rock
// Elliptical chuck (e, angle a): P_e = P_s + e * (cos(theta + 2a), sin(theta + 2a))
//   i.e. polar (rho, psi = -theta) maps to rot(a) * ((rho + e) cos(psi - a), (rho - e) sin(psi - a)).
// Eccentric chuck (offset, angle b, division angle delta):
//   P_w = rot(-delta) * (P_e - C),  C = offset * (cos b, sin b)
//   The work centre sits at C in the spindle frame, and the work is turned by delta about its own centre.
import type { Recipe } from '../state/recipe';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

export interface ChuckXform {
  /** Elliptical e (mm); 0 when the chuck is disabled. */
  ellE: number;
  /** cos / sin of twice the major-axis angle. */
  ellC2: number;
  ellS2: number;
  /** Work centre in the spindle frame (mm); 0 when the eccentric chuck is disabled. */
  eccX: number;
  eccY: number;
  /** Number of eccentric divisions (1 when disabled). */
  divisions: number;
  /** Rotation per division, radians. */
  divStep: number;
}

export function makeChuckXform(recipe: Recipe): ChuckXform {
  const el = recipe.elliptical;
  const ec = recipe.eccentric;
  const ellOn = !!el && el.enabled && Number.isFinite(el.e) && el.e !== 0;
  const a2 = ellOn ? 2 * (el.angle || 0) * DEG : 0;
  const eccOn = !!ec && ec.enabled;
  const divisions = eccOn ? Math.max(1, Math.round(ec.divisions || 1)) : 1;
  const stepDeg = eccOn ? (ec.divisionStep ? ec.divisionStep : 360 / divisions) : 0;
  const off = eccOn ? ec.offset || 0 : 0;
  const b = eccOn ? (ec.angle || 0) * DEG : 0;
  return {
    ellE: ellOn ? el.e : 0,
    ellC2: Math.cos(a2),
    ellS2: Math.sin(a2),
    eccX: off * Math.cos(b),
    eccY: off * Math.sin(b),
    divisions,
    divStep: stepDeg * DEG,
  };
}

/** Dividing-wheel rotation (radians) of eccentric division d. */
export function divisionAngle(xf: ChuckXform, d: number): number {
  return d * xf.divStep;
}

/**
 * Map the tool point to the work frame. rho = slideRadius + rock; c/s = cos/sin(spindleAngle);
 * cd/sd = cos/sin(divisionAngle). Writes x, y into out[0], out[1].
 */
export function toolToWork(
  xf: ChuckXform,
  rho: number,
  c: number,
  s: number,
  cd: number,
  sd: number,
  out: { [i: number]: number },
): void {
  let px = rho * c;
  let py = -rho * s;
  const e = xf.ellE;
  if (e !== 0) {
    px += e * (c * xf.ellC2 - s * xf.ellS2);
    py += e * (s * xf.ellC2 + c * xf.ellS2);
  }
  px -= xf.eccX;
  py -= xf.eccY;
  out[0] = cd * px + sd * py;
  out[1] = -sd * px + cd * py;
}

/**
 * Rigid placement of the work in the machine frame (spindle axis at origin, before the headstock's
 * rock shift): machine = rot(rotation) * work + (x, y). The tool point of the same pose maps to
 * (slideRadius + rock, 0). Use it to draw the work turning ("machine frame" view, 3D disc).
 */
export function workPlacementXf(
  xf: ChuckXform,
  spindleAngle: number,
  divAngle: number,
): { rotation: number; x: number; y: number } {
  const c = Math.cos(spindleAngle);
  const s = Math.sin(spindleAngle);
  // Work centre in the spindle frame: C - E(theta).
  let wx = xf.eccX;
  let wy = xf.eccY;
  if (xf.ellE !== 0) {
    wx -= xf.ellE * (c * xf.ellC2 - s * xf.ellS2);
    wy -= xf.ellE * (s * xf.ellC2 + c * xf.ellS2);
  }
  let rotation = (spindleAngle + divAngle) % TAU;
  if (rotation < 0) rotation += TAU;
  return { rotation, x: c * wx - s * wy, y: s * wx + c * wy };
}
