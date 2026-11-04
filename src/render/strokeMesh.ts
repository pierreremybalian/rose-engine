// Ribbon geometry for the whole toolpath. Built once per toolpath; playback, width, colour and surface
// changes are all uniforms, so nothing here runs during animation.
import * as THREE from 'three';
import type { Toolpath } from '../engine/types';
import type { InkSettings } from '../state/recipe';
import { hexToRgb, passColor } from '../state/colors';

/** Width of the per-pass colour texture (passes wrap onto further rows). */
export const PASS_TEX_WIDTH = 1024;
/** Tangent attribute is stored as normalized int16 holding (miter-scaled tangent) / MITER_MAX. */
export const MITER_MAX = 2;

export interface StrokeMesh {
  geometry: THREE.BufferGeometry;
  /** First index (into the index buffer) of each pass's triangles. */
  indexStart: Uint32Array;
  /** Number of segments (quads) of each pass. */
  segments: Uint32Array;
  /** Sample starts of each pass (copy, for binary search). */
  passStart: Uint32Array;
  totalSamples: number;
  totalIndices: number;
}

/**
 * Two vertices per sample (t = -1 left, +1 right), indexed triangles per stroke, no joins between strokes.
 * Closed passes get one extra vertex pair: a copy of the first sample whose sample index is start+count,
 * so the closing segment reveals in order and interpolates its sample index correctly.
 *
 * Attributes:
 *   position  vec3  x, y (mm, work frame), z = pump displacement (mm)
 *   aTangent  vec2  int16 normalized: unit tangent × miter length / MITER_MAX
 *   aSide     float int8: -1 / +1
 *   aPass     float global pass index
 *   aSample   float sample index (drawing order)
 */
export function buildStrokeMesh(tp: Toolpath): StrokeMesh {
  const passes = tp.passes;
  let vertCount = 0;
  let segCount = 0;
  for (const p of passes) {
    if (p.count <= 0) continue;
    vertCount += 2 * p.count + (p.closed && p.count > 2 ? 2 : 0);
    segCount += p.closed && p.count > 2 ? p.count : Math.max(0, p.count - 1);
  }

  const position = new Float32Array(vertCount * 3);
  const tangent = new Int16Array(vertCount * 2);
  const side = new Int8Array(vertCount);
  const passAttr = new Float32Array(vertCount);
  const sampleAttr = new Float32Array(vertCount);
  const index = vertCount > 65535 ? new Uint32Array(segCount * 6) : new Uint16Array(segCount * 6);
  const indexStart = new Uint32Array(passes.length);
  const segments = new Uint32Array(passes.length);
  const passStart = new Uint32Array(passes.length);

  const xs = tp.x, ys = tp.y, zs = tp.z;
  let v = 0; // vertex cursor
  let ii = 0; // index cursor
  const scale = 32767 / MITER_MAX;

  const writeVertexPair = (k: number, sampleIndex: number, passIndex: number, tx: number, ty: number) => {
    for (let s = 0; s < 2; s++) {
      const o = v + s;
      position[o * 3] = xs[k];
      position[o * 3 + 1] = ys[k];
      position[o * 3 + 2] = zs[k];
      tangent[o * 2] = Math.round(tx * scale);
      tangent[o * 2 + 1] = Math.round(ty * scale);
      side[o] = s === 0 ? -1 : 1;
      passAttr[o] = passIndex;
      sampleAttr[o] = sampleIndex;
    }
    v += 2;
  };

  for (let pi = 0; pi < passes.length; pi++) {
    const p = passes[pi];
    passStart[pi] = p.start;
    indexStart[pi] = ii;
    const n = p.count;
    if (n <= 0) {
      segments[pi] = 0;
      continue;
    }
    const closed = p.closed && n > 2;
    const firstVertex = v;
    // Previous segment direction (unit); seeded from the wrap segment for closed loops.
    let px = 0, py = 0;
    let firstTx = 1, firstTy = 0;
    if (closed) {
      const a = p.start + n - 1, b = p.start;
      const dx = xs[b] - xs[a], dy = ys[b] - ys[a];
      const l = Math.hypot(dx, dy);
      if (l > 1e-12) { px = dx / l; py = dy / l; }
    }
    for (let i = 0; i < n; i++) {
      const k = p.start + i;
      let nk: number;
      if (i < n - 1) nk = k + 1;
      else nk = closed ? p.start : -1;
      // outgoing direction
      let ox = 0, oy = 0;
      if (nk >= 0) {
        const dx = xs[nk] - xs[k], dy = ys[nk] - ys[k];
        const l = Math.hypot(dx, dy);
        if (l > 1e-12) { ox = dx / l; oy = dy / l; }
      }
      if (ox === 0 && oy === 0) { ox = px; oy = py; }
      if (px === 0 && py === 0) { px = ox; py = oy; }
      // averaged tangent with miter length 1/cos(half turn), clamped
      let tx = px + ox, ty = py + oy;
      let tl = Math.hypot(tx, ty);
      if (tl < 1e-9) { tx = ox; ty = oy; tl = Math.hypot(tx, ty) || 1; }
      tx /= tl; ty /= tl;
      const c = tx * ox + ty * oy;
      const miter = Math.min(MITER_MAX, 1 / Math.max(c, 1 / MITER_MAX));
      if (tx === 0 && ty === 0) { tx = 1; }
      writeVertexPair(k, k, p.index, tx * miter, ty * miter);
      if (i === 0) { firstTx = tx * miter; firstTy = ty * miter; }
      px = ox; py = oy;
    }
    if (closed) writeVertexPair(p.start, p.start + n, p.index, firstTx, firstTy);
    const segs = closed ? n : n - 1;
    for (let s = 0; s < segs; s++) {
      const a0 = firstVertex + 2 * s, a1 = a0 + 1, b0 = a0 + 2, b1 = a0 + 3;
      index[ii++] = a0; index[ii++] = a1; index[ii++] = b0;
      index[ii++] = a1; index[ii++] = b1; index[ii++] = b0;
    }
    segments[pi] = segs;
  }

  const g = new THREE.BufferGeometry();
  const release = function (this: { array: unknown }) {
    // Free the CPU copy once uploaded: the GPU buffers are all we need.
    this.array = null;
  };
  const attrs: [string, THREE.BufferAttribute][] = [
    ['position', new THREE.BufferAttribute(position, 3)],
    ['aTangent', new THREE.BufferAttribute(tangent, 2, true)],
    ['aSide', new THREE.BufferAttribute(side, 1, false)],
    ['aPass', new THREE.BufferAttribute(passAttr, 1)],
    ['aSample', new THREE.BufferAttribute(sampleAttr, 1)],
  ];
  for (const [name, a] of attrs) {
    if (vertCount > 200000) a.onUpload(release);
    g.setAttribute(name, a);
  }
  const idx = new THREE.BufferAttribute(index, 1);
  if (vertCount > 200000) idx.onUpload(release);
  g.setIndex(idx);
  // Bounds are known; never let three walk the arrays (they may be released).
  const b = tp.bounds;
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const r = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2 + 5;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, 0), Number.isFinite(r) ? r : 1e4);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(b.minX - 5, b.minY - 5, -10), new THREE.Vector3(b.maxX + 5, b.maxY + 5, 10));

  return { geometry: g, indexStart, segments, passStart, totalSamples: tp.totalSamples, totalIndices: ii };
}

/** Pass containing sample s (largest pass whose start <= s). Returns -1 if there are no passes. */
export function passAt(passStart: ArrayLike<number>, s: number): number {
  let lo = 0, hi = passStart.length - 1;
  if (hi < 0) return -1;
  if (s < passStart[0]) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (passStart[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Index-buffer range covering every segment that may contain fragments with sample value in [a, b].
 * Segment k of a pass spans samples [start+k, start+k+1].
 */
export function indexRange(m: StrokeMesh, a: number, b: number): { start: number; count: number } {
  if (m.passStart.length === 0 || b < 0 || b < a) return { start: 0, count: 0 };
  const segIndex = (s: number, upper: boolean): number => {
    const p = passAt(m.passStart, s);
    const local = s - m.passStart[p];
    let k = upper ? Math.ceil(local) : Math.floor(local) - 1;
    k = Math.max(0, Math.min(m.segments[p], k));
    return m.indexStart[p] + 6 * k;
  };
  const start = a <= 0 ? 0 : segIndex(a, false);
  const end = b >= m.totalSamples ? m.totalIndices : segIndex(b, true);
  return { start, count: Math.max(0, end - start) };
}

/** Per-pass colour texture (sRGB bytes; the ink shader blends in sRGB space like a 2D canvas). */
export function createPassColorTexture(passCount: number): THREE.DataTexture {
  const w = PASS_TEX_WIDTH;
  const h = Math.max(1, Math.ceil(passCount / w));
  const data = new Uint8Array(w * h * 4);
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export function fillPassColors(tex: THREE.DataTexture, ink: InkSettings, passCount: number): void {
  const data = tex.image.data as Uint8Array;
  const cache = new Map<string, [number, number, number]>();
  for (let i = 0; i < passCount; i++) {
    const hex = passColor(ink, i, passCount);
    let rgb = cache.get(hex);
    if (!rgb) {
      rgb = hexToRgb(hex);
      cache.set(hex, rgb);
    }
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  tex.needsUpdate = true;
}

/** Work-frame point at a fractional sample (follows the closing segment of closed passes). */
export function pointAtSample(tp: Toolpath, passStart: ArrayLike<number>, s: number, out: { x: number; y: number }): boolean {
  if (tp.totalSamples <= 0 || tp.passes.length === 0) return false;
  const sc = Math.max(0, Math.min(tp.totalSamples, s));
  let p = passAt(passStart, Math.min(sc, tp.totalSamples - 1e-6));
  let pass = tp.passes[p];
  let local = sc - pass.start;
  if (local >= pass.count && p < tp.passes.length - 1) {
    p += 1;
    pass = tp.passes[p];
    local = 0;
  }
  const i = Math.min(pass.count - 1, Math.floor(local));
  const f = Math.max(0, Math.min(1, local - i));
  const k = pass.start + i;
  let k2: number;
  if (i + 1 < pass.count) k2 = k + 1;
  else k2 = pass.closed ? pass.start : k;
  out.x = tp.x[k] + (tp.x[k2] - tp.x[k]) * f;
  out.y = tp.y[k] + (tp.y[k2] - tp.y[k]) * f;
  return true;
}
