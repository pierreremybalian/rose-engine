// Rosette (cam) geometry built from the real profile functions, plus rubber contact helpers.
import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Rosette } from '../../state/recipe';
import { rosetteRadiusAt } from '../../engine/rosette';
import { TAU } from './geom';

/** Axial thickness of a rocking rosette, mm. */
export const ROCK_THICK = 9;
/** Axial thickness of a face-cam body (without its track), mm. */
export const PUMP_BODY = 7;
/** Spindle bore of every rosette. */
export const ROSETTE_BORE = 11.2;

export function profileSamples(lobes: number): number {
  return Math.min(6144, Math.max(1024, Math.ceil(Math.max(1, lobes) * 64)));
}

/** Cache key of a rosette's physical shape (built at phase 0; phase is applied as a rotation). */
export function rosetteShapeKey(r: Rosette, baseRadius: number): string {
  return `${r.axis}|${r.lobes}|${r.amplitude}|${r.profile}|${baseRadius}`;
}

/** Face-cam track height range: base height so the lowest point stays 2 mm proud of the body. */
export function pumpTrackBase(r: Rosette): number {
  return Math.abs(r.amplitude) + 2;
}

/** Track height of a face cam at rosette-frame angle phi (mm, measured from the body's back face). */
export function pumpTrackHeight(r: Rosette, phi: number): number {
  // rosetteRadiusAt with base 0 is exactly amplitude * profile(u) with the same phase convention.
  return pumpTrackBase(r) + rosetteRadiusAt(r, 0, phi);
}

/** Radial extent of a face cam's track. */
export function pumpTrackRadii(baseRadius: number): { rIn: number; rOut: number; rMid: number } {
  const rOut = baseRadius * 0.92;
  const rIn = Math.max(ROSETTE_BORE + 10, baseRadius * 0.62);
  return { rIn, rOut, rMid: (rIn + rOut) / 2 };
}

/**
 * Rocking rosette: the profile r(phi) = rosetteRadiusAt(rosette, baseRadius, phi) extruded along Z,
 * centred on z = 0 (thickness ROCK_THICK). Rosette frame = local XY, phi measured CCW from +X.
 */
export function buildRockRosette(r: Rosette, baseRadius: number): THREE.BufferGeometry {
  const n = profileSamples(r.lobes);
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const phi = (i / n) * TAU;
    const rad = Math.max(ROSETTE_BORE + 4, rosetteRadiusAt(r, baseRadius, phi));
    pts.push(new THREE.Vector2(rad * Math.cos(phi), rad * Math.sin(phi)));
  }
  const shape = new THREE.Shape(pts);
  const hole = new THREE.Path();
  hole.absarc(0, 0, ROSETTE_BORE, 0, TAU, true);
  shape.holes.push(hole);
  const bevel = 0.45;
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: ROCK_THICK - 2 * bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelSegments: 2,
    curveSegments: 64,
    steps: 1,
  });
  g.translate(0, 0, -ROCK_THICK / 2 + bevel);
  g.deleteAttribute('uv');
  // Flat caps, smooth (creased) walls + bevels: never average normals across the cap edge.
  const pos = g.getAttribute('position').array as Float32Array;
  const nor = g.getAttribute('normal').array as Float32Array;
  const pick = (start: number, count: number) => {
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos.slice(start * 3, (start + count) * 3), 3));
    sg.setAttribute('normal', new THREE.BufferAttribute(nor.slice(start * 3, (start + count) * 3), 3));
    return sg;
  };
  const [capsG, sidesG] = g.groups;
  const caps = pick(capsG.start, capsG.count);
  const sidesRaw = pick(sidesG.start, sidesG.count);
  const sides = toCreasedNormals(sidesRaw, Math.PI / 3);
  const out = mergeGeometries([caps, sides]);
  for (const x of [g, caps, sidesRaw, sides]) x.dispose();
  return out;
}

/**
 * Pumping rosette (face cam): a brass body disc (z in [-PUMP_BODY, 0]) carrying an annular track on
 * its back face (toward -Z) whose height follows the profile: track surface at z = -PUMP_BODY - h(phi).
 * Returns the track as one BufferGeometry; the body is built separately (a turned disc).
 */
export function buildPumpTrack(r: Rosette, baseRadius: number): THREE.BufferGeometry {
  const n = profileSamples(r.lobes);
  const { rIn, rOut } = pumpTrackRadii(baseRadius);
  const zb = -PUMP_BODY;
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  const h = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) h[i] = pumpTrackHeight(r, (i / n) * TAU);
  const dphi = TAU / n;

  // Top surface (faces -Z): vertices at rIn and rOut per angle, analytic normals.
  const top0 = 0;
  for (let i = 0; i <= n; i++) {
    const phi = i * dphi;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const hp = (h[(i + 1) % n] - h[(i - 1 + n) % n]) / (2 * dphi);
    for (const rad of [rIn, rOut]) {
      pos.push(rad * c, rad * s, zb - h[i]);
      // Surface P(r, phi) = (r c, r s, zb - h(phi)); dP/dr = (c, s, 0); dP/dphi = (-r s, r c, -h').
      // Normal toward -Z: dP/dr x dP/dphi = (s*(-h') - 0, 0 - c*(-h'), r c c + r s s) -> negate for -Z.
      const nx = -(-s * hp);
      const ny = -(c * hp);
      const nz = -rad;
      const l = Math.hypot(nx, ny, nz);
      nor.push(nx / l, ny / l, nz / l);
    }
  }
  for (let i = 0; i < n; i++) {
    const a = top0 + i * 2;
    const b = a + 2;
    // Winding so the face points toward -Z.
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }

  // Outer and inner walls: from the body face (zb) to the track surface.
  const wall = (rad: number, sign: number) => {
    const base = pos.length / 3;
    for (let i = 0; i <= n; i++) {
      const phi = i * dphi;
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      pos.push(rad * c, rad * s, zb + 0.01);
      pos.push(rad * c, rad * s, zb - h[i]);
      nor.push(sign * c, sign * s, 0, sign * c, sign * s, 0);
    }
    for (let i = 0; i < n; i++) {
      const a = base + i * 2;
      const b = a + 2;
      if (sign > 0) idx.push(a, a + 1, b, b, a + 1, b + 1);
      else idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  };
  wall(rOut, 1);
  wall(rIn, -1);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

/**
 * Distance from a rocking rosette's centre to the centre of a roller of radius rv pressed against
 * it along the ray at rosette-frame angle phi (envelope of the roller over the profile).
 */
export function rollerDistance(r: Rosette, baseRadius: number, rv: number, phi: number): number {
  if (rv <= 1e-6) return rosetteRadiusAt(r, baseRadius, phi);
  const rhoMin = Math.max(1, baseRadius - Math.abs(r.amplitude));
  const f = (d: number) => {
    const rho = rosetteRadiusAt(r, baseRadius, phi + d);
    const sd = rho * Math.sin(d);
    const q = rv * rv - sd * sd;
    return q < 0 ? -Infinity : rho * Math.cos(d) + Math.sqrt(q);
  };
  const dMax = Math.asin(Math.min(1, rv / rhoMin));
  // Lobe peaks (u integer) can be cusps: evaluate them exactly as well.
  let best = refineMax(f, dMax);
  const n = Math.max(1, r.lobes);
  const u0 = (n * (phi - dMax)) / TAU + (r.phase / 360) * n;
  const u1 = (n * (phi + dMax)) / TAU + (r.phase / 360) * n;
  for (let k = Math.ceil(u0); k <= Math.floor(u1); k++) {
    const d = ((k - (r.phase / 360) * n) * TAU) / n - phi;
    best = Math.max(best, f(d));
  }
  return best;
}

/** Max of f over [-dMax, dMax]: coarse scan, then two zoomed refinements around the best sample. */
function refineMax(f: (d: number) => number, dMax: number): number {
  let lo = -dMax;
  let hi = dMax;
  let best = f(0);
  let bestD = 0;
  for (let pass = 0; pass < 3; pass++) {
    const K = pass === 0 ? 64 : 24;
    const step = (hi - lo) / K;
    for (let k = 0; k <= K; k++) {
      const d = lo + k * step;
      const v = f(d);
      if (v > best) {
        best = v;
        bestD = d;
      }
    }
    lo = Math.max(-dMax, bestD - step);
    hi = Math.min(dMax, bestD + step);
  }
  return best;
}

/**
 * Axial reach of a face-cam track under a roller of radius rv whose axis is radial, touching the
 * track at radius rMid and rosette-frame angle phi: returns height of the roller's lowest point
 * above the body face (max over the envelope).
 */
export function pumpRollerHeight(r: Rosette, rMid: number, rv: number, phi: number): number {
  if (rv <= 1e-6) return pumpTrackHeight(r, phi);
  const f = (d: number) => {
    const ds = d * rMid;
    return pumpTrackHeight(r, phi + d) + Math.sqrt(Math.max(0, rv * rv - ds * ds)) - rv;
  };
  return refineMax(f, rv / rMid);
}
