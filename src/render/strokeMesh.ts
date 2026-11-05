// Stroke geometry for the whole toolpath: path segments for the ink and groove passes. Built once per toolpath;
// playback, width, colour and surface changes are all uniforms, so nothing here runs during animation.
import * as THREE from 'three';
import type { Toolpath } from '../engine/types';
import type { InkSettings } from '../state/recipe';
import { hexToRgb, passColor } from '../state/colors';

/** Width of the per-pass colour texture (passes wrap onto further rows). */
export const PASS_TEX_WIDTH = 1024;
/** Width of the segment textures (entries wrap onto further rows). */
export const SEG_TEX_WIDTH = 2048;
/** Vertices per segment: two triangles, no index buffer (the vertex shader builds the quad). */
export const SEG_VERTS = 6;

/**
 * Path segments for the ink and groove passes: one quad per segment, whose fragments work from the distance to
 * the path (see SEGMENT_VERT in shaders/stroke.ts). There are no vertex attributes: the vertex shader reads
 * segment i's end points from entries i and i+1 of `points` (gl_VertexID / SEG_VERTS = i).
 *
 * Entries are the samples of each pass in order, plus a copy of the first sample after a closed pass (sample
 * index start+count, so the closing segment reveals in order). The last entry of every pass starts no segment.
 *
 *   points  RGBA32F  x, y (mm, work frame), z = pump (mm), w = sample index; w = -1 - sample on the last entry of a pass
 *   turns   RGBA32F  r: signed turn of the path at this entry, radians (CCW +); OPEN_END at the ends of open passes
 *                    g: global pass index (ink colour)
 *                    b: entry of the path point before this one (round the loop for a closed pass), -1 at an open start
 *                    a: entry of the path point after this one (round the loop), -1 at an open end
 */
export const OPEN_END = 8;

export interface SegmentMesh {
  /** Attribute-less geometry; the draw range counts vertices (SEG_VERTS per entry). */
  geometry: THREE.BufferGeometry;
  points: THREE.DataTexture;
  turns: THREE.DataTexture;
  /** First entry of each pass. */
  entryStart: Uint32Array;
  /** Segments of each pass. */
  segments: Uint32Array;
  passStart: Uint32Array;
  entries: number;
  totalSamples: number;
}

export function buildSegmentMesh(tp: Toolpath): SegmentMesh {
  const passes = tp.passes;
  let entries = 0;
  for (const p of passes) if (p.count > 0) entries += p.count + (p.closed && p.count > 2 ? 1 : 0);
  const rows = Math.max(1, Math.ceil(entries / SEG_TEX_WIDTH));
  const pts = new Float32Array(SEG_TEX_WIDTH * rows * 4);
  const turns = new Float32Array(SEG_TEX_WIDTH * rows * 4);
  const entryStart = new Uint32Array(passes.length);
  const segments = new Uint32Array(passes.length);
  const passStart = new Uint32Array(passes.length);
  const xs = tp.x, ys = tp.y, zs = tp.z;

  // scratch per pass: unit direction of each segment (0, 0 when degenerate)
  let maxEntries = 0;
  for (const p of passes) maxEntries = Math.max(maxEntries, p.count + 1);
  const dx = new Float64Array(maxEntries);
  const dy = new Float64Array(maxEntries);
  const inX = new Float64Array(maxEntries + 1);
  const inY = new Float64Array(maxEntries + 1);

  let e = 0;
  for (let pi = 0; pi < passes.length; pi++) {
    const p = passes[pi];
    passStart[pi] = p.start;
    entryStart[pi] = e;
    const n = p.count;
    if (n <= 0) continue;
    const closed = p.closed && n > 2;
    const m = n + (closed ? 1 : 0); // entries of this pass
    const at = (j: number) => p.start + (j < n ? j : 0);
    for (let j = 0; j < m; j++) {
      const k = at(j);
      const o = (e + j) * 4;
      pts[o] = xs[k];
      pts[o + 1] = ys[k];
      pts[o + 2] = zs[k];
      pts[o + 3] = j === m - 1 ? -1 - (p.start + j) : p.start + j;
    }
    segments[pi] = m - 1;
    // segment directions, from the stored (float32) positions so they match the shader's
    const segs = m - 1;
    for (let j = 0; j < segs; j++) {
      const a = (e + j) * 4, b = a + 4;
      const ux = pts[b] - pts[a], uy = pts[b + 1] - pts[a + 1];
      const l = Math.hypot(ux, uy);
      if (l > 1e-6) {
        dx[j] = ux / l;
        dy[j] = uy / l;
      } else {
        dx[j] = 0;
        dy[j] = 0;
      }
    }
    // incoming direction at each entry: the last non-degenerate segment before it (wrapping for closed loops)
    let cx = 0, cy = 0;
    if (closed) {
      for (let j = segs - 1; j >= 0; j--) if (dx[j] !== 0 || dy[j] !== 0) { cx = dx[j]; cy = dy[j]; break; }
    }
    for (let j = 0; j < m; j++) {
      inX[j] = cx;
      inY[j] = cy;
      if (j < segs && (dx[j] !== 0 || dy[j] !== 0)) { cx = dx[j]; cy = dy[j]; }
    }
    // outgoing direction: the first non-degenerate segment from it on; then the signed turn between the two
    let ox = 0, oy = 0;
    if (closed) {
      for (let j = 0; j < segs; j++) if (dx[j] !== 0 || dy[j] !== 0) { ox = dx[j]; oy = dy[j]; break; }
    }
    for (let j = m - 1; j >= 0; j--) {
      if (j < segs && (dx[j] !== 0 || dy[j] !== 0)) { ox = dx[j]; oy = dy[j]; }
      const ix = inX[j], iy = inY[j];
      const o = (e + j) * 4;
      turns[o] = (ix === 0 && iy === 0) || (ox === 0 && oy === 0) ? OPEN_END : Math.atan2(ix * oy - iy * ox, ix * ox + iy * oy);
      turns[o + 1] = p.index;
      // neighbours along the path; a closed pass's entry 0 and closing copy n are the same point
      turns[o + 2] = j > 0 ? e + j - 1 : closed ? e + n - 1 : -1;
      turns[o + 3] = j < m - 1 ? e + j + 1 : closed ? e + 1 : -1;
    }
    e += m;
  }

  const points = new THREE.DataTexture(pts, SEG_TEX_WIDTH, rows, THREE.RGBAFormat, THREE.FloatType);
  const turnTex = new THREE.DataTexture(turns, SEG_TEX_WIDTH, rows, THREE.RGBAFormat, THREE.FloatType);
  for (const t of [points, turnTex]) {
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.flipY = false;
    t.needsUpdate = true;
    if (entries > 100000) {
      // Free the CPU copy once uploaded: the GPU texture is all we need.
      t.onUpdate = () => {
        (t.image as { data: unknown }).data = null;
      };
    }
  }

  const g = new THREE.BufferGeometry();
  g.setDrawRange(0, entries * SEG_VERTS);
  // Bounds are known; there are no attributes for three to walk.
  const b = tp.bounds;
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const r = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2 + 5;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, 0), Number.isFinite(r) ? r : 1e4);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(b.minX - 5, b.minY - 5, -10), new THREE.Vector3(b.maxX + 5, b.maxY + 5, 10));

  return { geometry: g, points, turns: turnTex, entryStart, segments, passStart, entries, totalSamples: tp.totalSamples };
}

export function disposeSegmentMesh(m: SegmentMesh): void {
  m.geometry.dispose();
  m.points.dispose();
  m.turns.dispose();
}

/**
 * Vertex range (for setDrawRange) covering every segment that may hold samples in [a, b].
 * Segment k of a pass spans samples [start+k, start+k+1].
 */
export function segmentRange(m: SegmentMesh, a: number, b: number): { start: number; count: number } {
  if (m.passStart.length === 0 || m.entries === 0 || b <= 0 || b < a) return { start: 0, count: 0 };
  const entry = (s: number, upper: boolean): number => {
    const p = passAt(m.passStart, s);
    const local = s - m.passStart[p];
    let k = upper ? Math.ceil(local) : Math.floor(local) - 1;
    k = Math.max(0, Math.min(m.segments[p], k));
    return m.entryStart[p] + k;
  };
  const start = a <= 0 ? 0 : entry(a, false);
  const end = b >= m.totalSamples ? m.entries : entry(b, true);
  return { start: start * SEG_VERTS, count: Math.max(0, end - start) * SEG_VERTS };
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
