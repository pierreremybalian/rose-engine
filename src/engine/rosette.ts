// Rosette profile functions. The engine agent extends this file (rubber follower tables etc.)
// but must keep `profileValue` and `rosetteRadiusAt` signatures stable: the 3D model uses them.
import type { ProfileKind, Rosette } from '../state/recipe';

const TAU = Math.PI * 2;

/** Profile of one lobe. u in [0,1) is position within a lobe; returns a value in [-1, 1]. Peak at u = 0. */
export function profileValue(kind: ProfileKind, u: number): number {
  u = u - Math.floor(u);
  switch (kind) {
    case 'sine':
      return Math.cos(TAU * u);
    case 'convex': {
      // Round bumps meeting in sharp valleys: semicircle-like arches.
      const t = 2 * Math.abs(u - Math.round(u)); // 0 at peak, 1 at valley
      return 2 * Math.sqrt(Math.max(0, 1 - t * t)) - 1;
    }
    case 'concave': {
      // Sharp points with scooped flanks (cusps at peaks).
      const t = 2 * Math.abs(u - Math.round(u));
      return 1 - 2 * Math.sqrt(Math.max(0, t * (2 - t)));
    }
    case 'flame': {
      // Asymmetric lobe: slow fall from the peak, fast rise back — gives a flame / swirl look.
      const s = u < 0.75 ? u / 0.75 : 1 - (u - 0.75) / 0.25;
      return Math.cos(Math.PI * s);
    }
    case 'square': {
      // Smoothed square wave (tanh) so the rubber can still follow it.
      return Math.tanh(4 * Math.cos(TAU * u)) / Math.tanh(4);
    }
    case 'saw':
      // Linear ramp down from peak, instant return.
      return 1 - 2 * u;
    case 'triangle':
      // Symmetric zigzag: straight flanks from the peak (u = 0) to the valley (u = 0.5). Straight-sided
      // lobes cut barleycorn diamonds into crisp four-facet pyramids.
      return 1 - 4 * Math.abs(u - Math.round(u));
  }
}

/** Physical radius of a rocking rosette at angle phi (radians, rosette frame), mm. Used by the 3D model. */
export function rosetteRadiusAt(rosette: Rosette, baseRadius: number, phi: number): number {
  const u = (rosette.lobes * phi) / TAU + rosette.phase / 360 * rosette.lobes;
  return baseRadius + rosette.amplitude * profileValue(rosette.profile, u);
}

// ---------------------------------------------------------------------------------------------
// Rubber (roller follower) tables
// ---------------------------------------------------------------------------------------------

/** Default number of entries in a rubber follower table (one lobe). */
export const RUBBER_TABLE_SIZE = 4096;

/**
 * Periodic displacement table of a roller follower of radius `rubberRadius` riding a cam
 * rho(phi) = baseRadius + amplitude * profile(lobes * phi / 2pi), over ONE lobe (phase 0).
 *
 * Entry j is the follower displacement along the ray at angle j/size of a lobe, measured as
 * s(theta) - (baseRadius + rubberRadius), where s is the distance of the roller centre from the cam
 * centre: s(theta) = max_phi [rho cos(phi - theta) + sqrt(r^2 - rho^2 sin^2(phi - theta))].
 * With rubberRadius -> 0 this tends to amplitude * profile.
 *
 * Computed as the outer polar envelope of the cam's offset curve (segment offsets + round joins),
 * which is the same maximum evaluated exactly at each table angle, in O(samples).
 */
export function buildRubberTable(
  kind: ProfileKind,
  lobes: number,
  amplitude: number,
  baseRadius: number,
  rubberRadius: number,
  size: number = RUBBER_TABLE_SIZE,
): Float64Array {
  const n = Math.max(1, Math.round(lobes));
  const r = Math.max(0, rubberRadius);
  const table = new Float64Array(size);
  if (r <= 0 || amplitude === 0) {
    for (let j = 0; j < size; j++) table[j] = amplitude * profileValue(kind, j / size);
    return table;
  }

  const lobeAngle = TAU / n;
  const binStep = lobeAngle / size;
  const env = new Float64Array(size).fill(-Infinity);

  // Cam samples over one lobe plus one neighbour each side (for the joins at the seam).
  const m = Math.max(2048, size * 2);
  const qx = new Float64Array(m + 3);
  const qy = new Float64Array(m + 3);
  for (let k = -1; k <= m + 1; k++) {
    const phi = (k / m) * lobeAngle;
    const rho = baseRadius + amplitude * profileValue(kind, k / m);
    qx[k + 1] = rho * Math.cos(phi);
    qy[k + 1] = rho * Math.sin(phi);
  }

  // Rasterise segment P->Q into the polar bins it spans: radius where the bin ray crosses the segment.
  const raster = (px: number, py: number, ex: number, ey: number) => {
    const a0 = Math.atan2(py, px);
    let da = Math.atan2(ey, ex) - a0;
    if (da > Math.PI) da -= TAU;
    else if (da < -Math.PI) da += TAU;
    const lo = da >= 0 ? a0 : a0 + da;
    const hi = da >= 0 ? a0 + da : a0;
    const j0 = Math.ceil(lo / binStep - 1e-9);
    const j1 = Math.floor(hi / binStep + 1e-9);
    if (j1 < j0) return;
    const dx = ex - px;
    const dy = ey - py;
    for (let j = j0; j <= j1; j++) {
      const b = j * binStep;
      const ux = Math.cos(b);
      const uy = Math.sin(b);
      const den = ux * dy - uy * dx; // cross(u, D)
      let rad: number;
      if (Math.abs(den) < 1e-12) {
        rad = Math.max(ux * px + uy * py, ux * ex + uy * ey);
      } else {
        const t = Math.min(1, Math.max(0, -(ux * py - uy * px) / den));
        rad = ux * (px + t * dx) + uy * (py + t * dy);
      }
      const idx = ((j % size) + size) % size;
      if (rad > env[idx]) env[idx] = rad;
    }
  };

  const maxArcStep = Math.PI / 180; // 1 degree chords on the round joins
  let pnx = 0;
  let pny = 0;
  for (let k = 0; k <= m; k++) {
    // Segment k: q[k] -> q[k+1] (array index shifted by 1).
    const ax = qx[k + 1];
    const ay = qy[k + 1];
    const bx = qx[k + 2];
    const by = qy[k + 2];
    let dx = bx - ax;
    let dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-12;
    dx /= len;
    dy /= len;
    const nx = dy;
    const ny = -dx; // outward normal of a CCW curve
    if (k === 0) {
      // Normal of segment -1 for the first join.
      const sx = ax - qx[0];
      const sy = ay - qy[0];
      const sl = Math.hypot(sx, sy) || 1e-12;
      pnx = sy / sl;
      pny = -sx / sl;
    }
    // Round join at vertex q[k] from the previous normal to this one.
    const g = Math.atan2(pnx * ny - pny * nx, pnx * nx + pny * ny);
    const steps = Math.max(1, Math.ceil(Math.abs(g) / maxArcStep));
    const g0 = Math.atan2(pny, pnx);
    let cx = ax + r * pnx;
    let cy = ay + r * pny;
    for (let i = 1; i <= steps; i++) {
      const gg = g0 + (g * i) / steps;
      const ex = ax + r * Math.cos(gg);
      const ey = ay + r * Math.sin(gg);
      raster(cx, cy, ex, ey);
      cx = ex;
      cy = ey;
    }
    if (k < m) raster(ax + r * nx, ay + r * ny, bx + r * nx, by + r * ny);
    pnx = nx;
    pny = ny;
  }

  const rest = baseRadius + r;
  for (let j = 0; j < size; j++) {
    table[j] = Number.isFinite(env[j]) ? env[j] - rest : amplitude * profileValue(kind, j / size);
  }
  return table;
}

/** Periodic linear lookup in a one-lobe table; u is position in lobes (any real). */
export function sampleTable(table: Float64Array, u: number): number {
  const n = table.length;
  let f = (u - Math.floor(u)) * n;
  if (f >= n) f -= n;
  const i = f | 0;
  const t = f - i;
  const a = table[i];
  const b = table[i + 1 === n ? 0 : i + 1];
  return a + (b - a) * t;
}
