// Small procedural geometry helpers. All lengths in mm.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const TAU = Math.PI * 2;

/** Rounded box centred on the origin. */
export function rbox(w: number, h: number, d: number, r: number, seg = 3): THREE.BufferGeometry {
  const rr = Math.max(0.01, Math.min(r, w / 2 - 0.01, h / 2 - 0.01, d / 2 - 0.01));
  return new RoundedBoxGeometry(w, h, d, seg, rr);
}

/** Rounded box spanning explicit min/max corners. */
export function rboxSpan(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  r: number,
): THREE.BufferGeometry {
  const g = rbox(x1 - x0, y1 - y0, z1 - z0, r);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

/**
 * Turned part around the Z axis from a (radius, z) profile, listed from one end to the other.
 * Profile points with radius 0 close the ends.
 */
export function latheZ(profile: [number, number][], segments = 48, sharp = false): THREE.BufferGeometry {
  // sharp: duplicate interior points so every profile corner gets a hard edge (machined look).
  const src = sharp ? profile.flatMap((p, i) => (i === 0 || i === profile.length - 1 ? [p] : [p, p])) : profile;
  const pts = src.map(([r, z]) => new THREE.Vector2(Math.max(0, r), z));
  const g = new THREE.LatheGeometry(pts, segments);
  // Lathe axis is +Y; rotate so it becomes +Z (y -> z).
  g.rotateX(Math.PI / 2);
  return g;
}

/** Cylinder along Z from z0 to z1. */
export function cylZ(r: number, z0: number, z1: number, seg = 32, open = false): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, Math.abs(z1 - z0), seg, 1, open);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, (z0 + z1) / 2);
  return g;
}

/** Cylinder along X from x0 to x1. */
export function cylX(r: number, x0: number, x1: number, seg = 24): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, Math.abs(x1 - x0), seg);
  g.rotateZ(-Math.PI / 2);
  g.translate((x0 + x1) / 2, 0, 0);
  return g;
}

/** Cylinder along Y from y0 to y1. */
export function cylY(r: number, y0: number, y1: number, seg = 24): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, Math.abs(y1 - y0), seg);
  g.translate(0, (y0 + y1) / 2, 0);
  return g;
}

/** Annular ring along Z with small chamfers: inner r0, outer r1, from z0 to z1. */
export function ringZ(r0: number, r1: number, z0: number, z1: number, ch = 0.6, seg = 64): THREE.BufferGeometry {
  const c = Math.min(ch, (r1 - r0) / 3, (z1 - z0) / 3);
  return latheZ(
    [
      [r0, z0 + c],
      [r0 + c, z0],
      [r1 - c, z0],
      [r1, z0 + c],
      [r1, z1 - c],
      [r1 - c, z1],
      [r0 + c, z1],
      [r0, z1 - c],
      [r0, z0 + c],
    ],
    seg,
    true,
  );
}

/** Solid turned disc along Z (closed), with chamfered edges. */
export function discZ(r: number, z0: number, z1: number, ch = 0.8, seg = 64): THREE.BufferGeometry {
  const c = Math.min(ch, r / 3, (z1 - z0) / 3);
  return latheZ(
    [
      [0, z0],
      [r - c, z0],
      [r, z0 + c],
      [r, z1 - c],
      [r - c, z1],
      [0, z1],
    ],
    seg,
    true,
  );
}

/** Hex nut/bolt head along Z (flat-to-flat ~ size). */
export function hexZ(size: number, z0: number, z1: number): THREE.BufferGeometry {
  const r = size / Math.sqrt(3);
  const g = new THREE.CylinderGeometry(r, r, z1 - z0, 6);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, (z0 + z1) / 2);
  return g;
}

/** Hex head along Y. */
export function hexY(size: number, y0: number, y1: number): THREE.BufferGeometry {
  const r = size / Math.sqrt(3);
  const g = new THREE.CylinderGeometry(r, r, y1 - y0, 6);
  g.translate(0, (y0 + y1) / 2, 0);
  return g;
}

/** Knurled thumb knob along +Y: a short fluted cylinder with a domed top. */
export function knobY(r: number, h: number, flutes = 18): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const n = flutes * 8;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * TAU;
    const rr = r * (1 - 0.06 * Math.max(0, Math.cos(a * flutes)) ** 4);
    const x = rr * Math.cos(a);
    const y = rr * Math.sin(a);
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  const body = new THREE.ExtrudeGeometry(shape, { depth: h * 0.75, bevelEnabled: true, bevelSize: 0.4, bevelThickness: 0.4, bevelSegments: 1, curveSegments: 4 });
  body.rotateX(-Math.PI / 2); // extrude +Z -> +Y
  const dome = new THREE.SphereGeometry(r * 0.92, 24, 8, 0, TAU, 0, Math.PI / 2);
  dome.scale(1, (h * 0.35) / (r * 0.92), 1);
  dome.translate(0, h * 0.72, 0);
  const merged = mergeGeometries([body.index ? body.toNonIndexed() : body, dome.toNonIndexed()]);
  body.dispose();
  dome.dispose();
  merged.computeVertexNormals();
  return merged;
}

/** Spoked handwheel in the XY plane (axis Z), centred at origin, front face toward +Z. */
export function handwheelGeometries(
  rimR: number,
  rimThick: number,
  hubR: number,
  hubLen: number,
  spokes: number,
): { rim: THREE.BufferGeometry; spokes: THREE.BufferGeometry; hub: THREE.BufferGeometry } {
  const rim = new THREE.TorusGeometry(rimR, rimThick, 16, 96);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * TAU + Math.PI / 2;
    const len = rimR - hubR * 0.6;
    const s = new THREE.CylinderGeometry(rimThick * 0.55, rimThick * 0.75, len, 12);
    s.translate(0, hubR * 0.6 + len / 2, 0);
    s.rotateZ(a - Math.PI / 2);
    parts.push(s);
  }
  const sp = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  const hub = latheZ(
    [
      [0, -hubLen / 2],
      [hubR * 0.8, -hubLen / 2],
      [hubR, -hubLen / 2 + 1.5],
      [hubR, hubLen / 2 - 1.5],
      [hubR * 0.8, hubLen / 2],
      [0, hubLen / 2],
    ],
    32,
  );
  return { rim, spokes: sp, hub };
}

/** Helical coil spring along +X from 0 to len (scale x by newLen/len to stretch a little). */
export function springGeometry(coilR: number, wireR: number, turns: number, unitLen: number): THREE.BufferGeometry {
  class Helix extends THREE.Curve<THREE.Vector3> {
    constructor() {
      super();
    }
    getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
      const a = t * turns * TAU;
      return target.set(t * unitLen, coilR * Math.cos(a), coilR * Math.sin(a));
    }
  }
  return new THREE.TubeGeometry(new Helix(), Math.ceil(turns * 24), wireR, 8, false);
}

/**
 * Headstock standard: a link plate joining a top boss (radius rt at (0, L)) and a bottom boss
 * (radius rb at the pivot (0, 0)), with a bearing bore, pivot bore and a lightening window.
 * Extruded along Z from z0 to z1.
 */
export function standardGeometry(
  L: number,
  rt: number,
  rb: number,
  boreR: number,
  pivotR: number,
  z0: number,
  z1: number,
): THREE.BufferGeometry {
  const g = Math.asin((rb - rt) / L); // tangent angle (negative: plate widens upwards)
  const s = new THREE.Shape();
  s.moveTo(rb * Math.cos(g), rb * Math.sin(g));
  s.lineTo(rt * Math.cos(g), L + rt * Math.sin(g));
  s.absarc(0, L, rt, g, Math.PI - g, false);
  s.lineTo(-rb * Math.cos(g), rb * Math.sin(g));
  s.absarc(0, 0, rb, Math.PI - g, TAU + g, false);

  const bore = new THREE.Path();
  bore.absarc(0, L, boreR, 0, TAU, true);
  s.holes.push(bore);
  const piv = new THREE.Path();
  piv.absarc(0, 0, pivotR, 0, TAU, true);
  s.holes.push(piv);

  // Lightening window: a tapered slot with round ends.
  const y0 = rb + 16;
  const y1 = L - rt - 14;
  if (y1 - y0 > 24) {
    const w0 = Math.max(4, rb * 0.35);
    const w1 = Math.max(5, rt * 0.42);
    const win = new THREE.Path();
    win.absarc(0, y0 + w0, w0, Math.PI, TAU, false);
    win.lineTo(w1, y1 - w1);
    win.absarc(0, y1 - w1, w1, 0, Math.PI, false);
    win.lineTo(-w0, y0 + w0);
    // Holes must wind opposite to the outline: reverse by building it as a fresh path.
    const pts = win.getPoints(24).reverse();
    s.holes.push(new THREE.Path(pts));
  }

  const bevel = 2;
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: z1 - z0 - 2 * bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    curveSegments: 48,
  });
  geo.translate(0, 0, z0 + bevel);
  return geo;
}

/** Rounded-rectangle plate in XY (centred), extruded along Z from z0 to z1. */
export function roundedPlateZ(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  r: number,
  z0: number,
  z1: number,
  bevel = 0.8,
): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const rr = Math.min(r, (x1 - x0) / 2 - 0.01, (y1 - y0) / 2 - 0.01);
  s.moveTo(x0 + rr, y0);
  s.lineTo(x1 - rr, y0);
  s.absarc(x1 - rr, y0 + rr, rr, -Math.PI / 2, 0, false);
  s.lineTo(x1, y1 - rr);
  s.absarc(x1 - rr, y1 - rr, rr, 0, Math.PI / 2, false);
  s.lineTo(x0 + rr, y1);
  s.absarc(x0 + rr, y1 - rr, rr, Math.PI / 2, Math.PI, false);
  s.lineTo(x0, y0 + rr);
  s.absarc(x0 + rr, y0 + rr, rr, Math.PI, Math.PI * 1.5, false);
  const b = Math.min(bevel, (z1 - z0) / 3);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: z1 - z0 - 2 * b,
    bevelEnabled: b > 0,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 2,
    curveSegments: 16,
  });
  g.translate(0, 0, z0 + b);
  return g;
}
