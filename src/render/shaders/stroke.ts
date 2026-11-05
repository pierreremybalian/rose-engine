// GLSL ES 3.00 sources for the stroke passes (used with RawShaderMaterial + GLSL3).
import { OPEN_END, PASS_TEX_WIDTH, SEG_TEX_WIDTH, SEG_VERTS } from '../strokeMesh';

const HEADER = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
#define PASS_TEX_WIDTH ${PASS_TEX_WIDTH}
`;

/**
 * Path segments, shared by the ink and groove passes. One quad per segment, built in the vertex shader from
 * entries i and i+1 of the segment mesh (attribute-less; see buildSegmentMesh), gl_VertexID / SEG_VERTS = i.
 *
 * Each segment owns a fan: the region between its end normals nA and nB, which lean toward the neighbouring
 * segments' normals by s·turn/2. A fragment finds its distance to the path by projecting onto the segment
 * along the interpolated normal (Phong-style), so the distance field, and the normals and widths built on it,
 * turn smoothly along a sampled curve instead of in per-segment facets. Neighbouring fans share an edge, so
 * they tile. In the gap a turn leaves between two fans on its outer side, the distance is to the end point:
 * the tool's cone (a round pen tip), which meets both fan edges exactly. s → 0 where the turn is large and the
 * segment long next to the stroke width (a real corner): the fan becomes the plain perpendicular slab, giving
 * exact mitres and cones.
 *
 * Playback reveals [uProgressMin, uProgress] (in samples): segments outside it are culled, partly revealed ones
 * cut short (see the ink and groove mains for how the cut ends).
 */
const SEGMENT_VERT = /* glsl */ `
#define SEG_TEX_WIDTH ${SEG_TEX_WIDTH}
#define SEG_VERTS ${SEG_VERTS}
#define OPEN_END ${OPEN_END.toFixed(1)}
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform sampler2D uPoints; // x, y (mm, work frame), pump (mm), sample index (negative: last entry of a pass)
uniform sampler2D uTurns;  // signed turn at the entry (radians; OPEN_END at open ends), pass index, prev/next entry
uniform float uPxPerMm;
uniform float uProgress;
uniform float uProgressMin;
flat out vec2 vA;      // segment start, work frame (mm)
flat out vec2 vAB;     // segment vector (mm)
flat out vec4 vEdge;   // fan edge directions at A (xy) and B (zw): the segment's direction leaned by s·turn/2
flat out vec4 vNbr;    // the neighbours' fan edge directions at A and B; 0 at an open end
out vec2 vRel;         // fragment − A (mm)

ivec2 texAt(int i) {
  return ivec2(i % SEG_TEX_WIDTH, i / SEG_TEX_WIDTH);
}

vec2 rot(vec2 v, float a) {
  float c = cos(a), s = sin(a);
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}

/** How much of a turn the fan edge takes over: all of a gentle one; none of a real corner. */
float smoothing(float turn, float len, float w) {
  if (turn >= OPEN_END - 0.5) return 0.0;
  float sharp = smoothstep(0.35, 1.0, abs(turn));
  return 1.0 - smoothstep(0.3, 1.0, sharp * len / w);
}

/**
 * How far past an end point (× the quad half-width) the quad must reach on the outer side of a turn: over the
 * fan's lean and the gap up to the neighbour's fan edge, together turn·(1 − s/2) from the perpendicular.
 */
float reach(float turn, float s) {
  float a = abs(turn) * (1.0 - 0.5 * s);
  return a >= 1.5707963 ? 1.0 : sin(a);
}

struct Seg {
  vec4 pa;     // entries i and i+1
  vec4 pb;
  vec2 A;      // revealed part
  vec2 B;
  float f0;    // revealed part as fractions of the segment
  float f1;
  float turnA;
  float turnB;
  float pass;
  float prevA; // entry before A, and after B, along the path (-1: none)
  float nextB;
};

/** Read segment i and cut it to the revealed range; false when nothing of it is revealed. */
bool readSegment(int seg, out Seg g) {
  g.pa = texelFetch(uPoints, texAt(seg), 0);
  float sA = g.pa.w;
  // last entry of a pass, not revealed yet, or already drawn (incremental)
  if (sA < 0.0 || sA >= uProgress || sA + 1.0 <= uProgressMin) return false;
  g.pb = texelFetch(uPoints, texAt(seg + 1), 0);
  vec4 ta = texelFetch(uTurns, texAt(seg), 0);
  vec4 tb = texelFetch(uTurns, texAt(seg + 1), 0);
  g.turnA = ta.r;
  g.pass = ta.g;
  g.prevA = ta.b;
  g.turnB = tb.r;
  g.nextB = tb.a;
  g.f0 = clamp(uProgressMin - sA, 0.0, 1.0);
  g.f1 = clamp(uProgress - sA, 0.0, 1.0);
  g.A = mix(g.pa.xy, g.pb.xy, g.f0);
  g.B = mix(g.pa.xy, g.pb.xy, g.f1);
  return length(g.B - g.A) >= 1e-6;
}

void cull() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vA = vec2(0.0);
  vAB = vec2(0.0);
  vEdge = vec4(0.0);
  vNbr = vec4(0.0);
  vRel = vec2(0.0);
}

/**
 * The fans and the quad. w: half-width of the stroke (mm); apron: extra width all round for antialiasing (mm);
 * pad: extra length past both ends (mm). flatA / flatB: the end is a straight cut across the stroke (no lean,
 * no cone), so a draw that continues from there tiles with this one. exact: no lean at all (plain slabs).
 */
void placeSegment(Seg g, float w, float apron, float pad, bool flatA, bool flatB, bool exact) {
  vec2 d = g.B - g.A;
  float len = length(d);
  vec2 T = d / len;
  vec2 N = vec2(-T.y, T.x);
  bool openA = !flatA && g.turnA >= OPEN_END - 0.5;
  bool openB = !flatB && g.turnB >= OPEN_END - 0.5;
  float sA = flatA || exact ? 0.0 : smoothing(g.turnA, len, w);
  float sB = flatB || exact ? 0.0 : smoothing(g.turnB, len, w);
  float leanA = flatA ? 0.0 : -0.5 * sA * g.turnA;
  float leanB = flatB ? 0.0 : 0.5 * sB * g.turnB;
  vEdge = vec4(rot(T, leanA), rot(T, leanB));
  vec2 nbrA = flatA ? vEdge.xy : openA ? vec2(0.0) : rot(T, -g.turnA * (1.0 - 0.5 * sA));
  vec2 nbrB = flatB ? vEdge.zw : openB ? vec2(0.0) : rot(T, g.turnB * (1.0 - 0.5 * sB));
  vNbr = vec4(nbrA, nbrB);
  // The quad: the segment's rectangle, reaching past each end on the outer side of the turn there (right of a
  // left turn, left of a right turn) over the fan's lean and the gap; both sides at an open end.
  float W = w + apron;
  float eA = flatA ? 0.0 : openA ? 1.0 : reach(g.turnA, sA);
  float eB = flatB ? 0.0 : openB ? 1.0 : reach(g.turnB, sB);
  // corners (i along, j across) of two triangles: (0,0) (1,0) (0,1) / (0,1) (1,0) (1,1); j = 1 is the left side
  int corner = gl_VertexID % SEG_VERTS;
  int i = (corner == 1 || corner == 4 || corner == 5) ? 1 : 0;
  int j = (corner == 2 || corner == 3 || corner == 5) ? 1 : 0;
  bool outerA = openA || (j == 1 ? g.turnA < 0.0 : g.turnA > 0.0);
  bool outerB = openB || (j == 1 ? g.turnB < 0.0 : g.turnB > 0.0);
  float along = i == 0 ? -(outerA ? eA * W : 0.0) - pad : len + (outerB ? eB * W : 0.0) + pad;
  float across = j == 0 ? -W : W;
  vec2 rel = T * along + N * across;
  vA = g.A;
  vAB = d;
  vRel = rel;
  gl_Position = projectionMatrix * viewMatrix * (modelMatrix * vec4(g.A + rel, 0.0, 1.0));
}
`;

/** Fragment side of the segment fans (grooves): the projection onto the fan (see SEGMENT_VERT). */
const SEGMENT_FRAG = /* glsl */ `
flat in vec2 vA;
flat in vec2 vAB;
flat in vec4 vEdge;
flat in vec4 vNbr;
in vec2 vRel;

float cross2(vec2 a, vec2 b) {
  return a.x * b.y - a.y * b.x;
}

/**
 * t with (rel − t·AB) parallel to mix(nA, nB, t): a quadratic in t (linear when nA = nB, the plain
 * perpendicular projection). The root continuous with that projection comes first; the other one only matters
 * where a strongly leaning fan folds. Returns a value outside [lo, hi) when the fragment is not in the fan
 * (lo/hi: the accepted range, with any slack).
 */
float fanParam(vec2 nA, vec2 nB, float lo, float hi) {
  vec2 m = nB - nA;
  float c0 = cross2(vRel, nA);
  float c1 = cross2(vRel, m) - cross2(vAB, nA);
  float c2 = -cross2(vAB, m);
  float disc = c1 * c1 - 4.0 * c2 * c0;
  float miss = -2.0 * abs(hi) - 1.0;
  if (disc < 0.0) return miss;
  float qq = -0.5 * (c1 + (c1 < 0.0 ? -1.0 : 1.0) * sqrt(disc));
  for (int k = 0; k < 2; k++) {
    float t = k == 0 ? (qq != 0.0 ? c0 / qq : miss) : (c2 != 0.0 ? qq / c2 : miss);
    if (t >= lo && t < hi) return t;
  }
  return miss;
}
`;

/**
 * Ink: coloured pen strokes. Width from a uniform (pump-modulated per sample), never thinner than uMinPx on
 * screen (thinner pens fade instead, so density stays right), antialiased from the distance to the path.
 *
 * Ink needs no normals, so it uses the exact polyline: plain slabs (no lean, so nothing folds over inside a
 * bend tighter than the pen) and the pen's round tip in the gap a turn leaves on its outer side, with half a
 * pixel of overlap so nothing falls between them. Where a pass covers a pixel more than once (the inside of
 * every turn, the overlaps) the depth test keeps the first fragment: each pass writes its own depth band,
 * lower for later passes, so it never inks a pixel twice while later passes still lay over earlier ones.
 * Cut ends of playback are straight cuts across the stroke, so a later draw continuing from there tiles with
 * this one (the depth buffer carries over between the draws).
 */
export const inkStrokeVert = /* glsl */ `${HEADER}
${SEGMENT_VERT}
uniform sampler2D uPassColors;
uniform float uLineWidth;
uniform float uOpacity;
uniform vec2 uZRange;
uniform float uPump;
uniform float uMinPx;
uniform float uPadPx;
flat out vec4 vInk;   // half-width (mm) and alpha at A and B
flat out vec3 vColor;
flat out vec3 vInfo;  // x: the stroke starts at A (round tip); y: half a pixel as a fraction of the segment; z: pass
flat out vec4 vNear;  // the neighbouring segments: the point before A and the point after B, relative to A
flat out vec2 vHas;   // whether there is one

vec2 pen(float z) {
  float zn = uZRange.y > uZRange.x ? clamp((z - uZRange.x) / (uZRange.y - uZRange.x), 0.0, 1.0) : 0.5;
  float wMm = uLineWidth * mix(1.0, mix(0.4, 1.6, zn), uPump);
  float wPx = wMm * uPxPerMm;
  return vec2(0.5 * max(wPx, uMinPx) / uPxPerMm, uOpacity * clamp(wPx / uMinPx, 0.0, 1.0));
}

void main() {
  Seg g;
  if (!readSegment(gl_VertexID / SEG_VERTS, g)) {
    cull();
    vInk = vec4(0.0);
    vColor = vec3(0.0);
    vInfo = vec3(0.0);
    vNear = vec4(0.0);
    vHas = vec2(0.0);
    return;
  }
  // neighbours, except across a cut end (the rest of this segment is drawn on its own)
  bool hasPrev = g.f0 <= 0.0 && g.prevA >= 0.0;
  bool hasNext = g.f1 >= 1.0 && g.nextB >= 0.0;
  vec2 prev = hasPrev ? texelFetch(uPoints, texAt(int(g.prevA + 0.5)), 0).xy : g.A;
  vec2 next = hasNext ? texelFetch(uPoints, texAt(int(g.nextB + 0.5)), 0).xy : g.B;
  vNear = vec4(prev - g.A, next - g.A);
  vHas = vec2(hasPrev ? 1.0 : 0.0, hasNext ? 1.0 : 0.0);
  vec2 pa = pen(mix(g.pa.z, g.pb.z, g.f0));
  vec2 pb = pen(mix(g.pa.z, g.pb.z, g.f1));
  vInk = vec4(pa.x, pb.x, pa.y, pb.y);
  int pi = int(g.pass + 0.5);
  vColor = texelFetch(uPassColors, ivec2(pi % PASS_TEX_WIDTH, pi / PASS_TEX_WIDTH), 0).rgb;
  bool flatA = g.f0 > 0.0;
  bool flatB = g.f1 < 1.0;
  float len = length(g.B - g.A);
  vInfo = vec3(!flatA && g.turnA >= OPEN_END - 0.5 ? 1.0 : 0.0, (0.5 + uPadPx) / (uPxPerMm * len), g.pass);
  placeSegment(g, max(pa.x, pb.x), 1.0 / uPxPerMm, (0.5 + uPadPx) / uPxPerMm, flatA, flatB, true);
}
`;

export const inkStrokeFrag = /* glsl */ `${HEADER}
uniform float uPxPerMm;
uniform float uClipR;
uniform mat3 uFragToWork;
flat in vec2 vA;
flat in vec2 vAB;
flat in vec4 vEdge;
flat in vec4 vNbr;
in vec2 vRel;
flat in vec4 vInk;
flat in vec3 vColor;
flat in vec3 vInfo;
flat in vec4 vNear;
flat in vec2 vHas;
out vec4 fragColor;

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float l = dot(ab, ab);
  float t = l > 0.0 ? clamp(dot(p - a, ab) / l, 0.0, 1.0) : 0.0;
  return length(p - a - t * ab);
}

void main() {
  // Where this pixel is, in the work frame, from one map shared by every segment, so neighbouring segments
  // agree on it exactly (each quad's own interpolation carries its vertices' rounding).
  vec2 P = (uFragToWork * vec3(gl_FragCoord.xy, 1.0)).xy;
  vec2 rel = P - vA;
  // the pen only marks the plate: an antialiased clip at the rim (work frame, plate centre at the origin)
  float clip = 1.0;
  if (uClipR > 0.0) {
    clip = clamp((uClipR - length(P)) * uPxPerMm + 0.5, 0.0, 1.0);
    if (clip <= 0.0) discard;
  }
  float l2 = dot(vAB, vAB);
  float t = dot(rel, vAB) / l2;
  float slack = vInfo.y;
  if (t < -slack) {
    // before A: the round tip where the stroke starts, or the gap after the previous segment (the depth test
    // drops it there if the previous segment inked it already)
    vec2 q = rel;
    if (vInfo.x < 0.5 && dot(q, vNbr.xy) < 0.0) discard;
    t = 0.0;
  } else if (t > 1.0 + slack) {
    // past B: the gap before the next segment (or the round tip where the stroke ends)
    if (dot(rel - vAB, vNbr.zw) > 0.0) discard;
    t = 1.0;
  }
  vec2 q = rel - clamp(t, 0.0, 1.0) * vAB;
  // inside the slack the slab carries on along its line
  if (t > -slack && t < 1.0 + slack) q = rel - t * vAB;
  float tc = clamp(t, 0.0, 1.0);
  float hw = mix(vInk.x, vInk.y, tc);
  // coverage from the distance to the path here (this segment or a neighbour), so neighbouring segments agree
  float d = length(q);
  if (vHas.x > 0.5) d = min(d, segDist(rel, vNear.xy, vec2(0.0)));
  if (vHas.y > 0.5) d = min(d, segDist(rel, vAB, vNear.zw));
  float cov = clamp((hw - d) * uPxPerMm + 0.5, 0.0, 1.0);
  float a = cov * mix(vInk.z, vInk.w, tc) * clip;
  if (a <= 0.0) discard;
  fragColor = vec4(vColor * a, a); // premultiplied
  // One depth band per pass, lower for later passes; inside it, four coverage levels (2^-23 steps of a 24-bit
  // buffer). A pixel a pass already inked only takes another of its fragments if that one covers it clearly
  // more (an edge of the stroke running inside a tight bend): a slight darkening there, never a seam.
  gl_FragDepth = 1.0 - ((vInfo.z + 1.0) * 8.0 + floor(cov * 4.0)) * 1.1920928955078125e-7;
}
`;

/**
 * Metal groove pass: each fragment computes its segment's V cut, cut = depth − distance / tan(half angle), and
 * gl_FragDepth makes the deepest cut win where cuts overlap, so walls of different cuts meet in exact straight
 * ridges. Writes the surface normal (rgb, 0..1 encoded) and the cut depth (a, 0..1 of uDepthRange). With MRT,
 * attachment 1 holds the tool-mark direction as a doubled angle (rg) and anisotropy strength (b).
 * Playback: the cut so far ends in the tool's cone, where the tool is.
 */
export const grooveVert = /* glsl */ `${HEADER}
${SEGMENT_VERT}
uniform float uBaseDepth;
uniform float uTanHalf;
flat out vec3 vDepth;  // cut depth at A and B (mm); half a pixel as a fraction of the segment

void main() {
  Seg g;
  if (!readSegment(gl_VertexID / SEG_VERTS, g)) {
    cull();
    vDepth = vec3(0.0);
    return;
  }
  float dA0 = max(uBaseDepth + g.pa.z, 0.0);
  float dB0 = max(uBaseDepth + g.pb.z, 0.0);
  float dA = mix(dA0, dB0, g.f0);
  float dB = mix(dA0, dB0, g.f1);
  if (max(dA, dB) <= 0.0) {
    cull();
    vDepth = vec3(0.0);
    return;
  }
  // a cut-short end is the tool's full cone; so is B when the tool is there and the path goes on
  if (g.f0 > 0.0) g.turnA = OPEN_END;
  if (g.f1 < 1.0 || (g.pb.w >= 0.0 && g.pa.w + 1.0 >= uProgress)) g.turnB = OPEN_END;
  // Grooves narrower than ~1.2px are drawn wider with a proportionally shallower wall (pixel-average look).
  float w = max(max(dA, dB) * uTanHalf, 0.6 / uPxPerMm);
  vDepth = vec3(dA, dB, 0.5 / (uPxPerMm * length(g.B - g.A)));
  placeSegment(g, w, 0.0, 0.0, false, false, false);
}
`;

export function grooveFrag(mrt: boolean): string {
  return /* glsl */ `${HEADER}
uniform mat4 modelMatrix;
uniform float uTanHalf;
uniform float uPxPerMm;
uniform float uDepthRange;
uniform float uAniso;
uniform float uClipR;
${SEGMENT_FRAG}
flat in vec3 vDepth;
layout(location = 0) out vec4 gNormal;
${mrt ? 'layout(location = 1) out vec4 gAniso;' : ''}

void main() {
  // the cutter only removes material on the plate
  vec2 wp = vA + vRel;
  if (uClipR > 0.0 && dot(wp, wp) > uClipR * uClipR) discard;
  // Half a pixel of slack (vDepth.z, in t) past the fan edges, where the fan carries on continuously: MSAA
  // covers per sample but keeps or discards a fragment per pixel, so a pixel whose centre is just over the
  // edge must still be drawn for the samples only this quad covers. Any fan or cone distance is to a point of
  // the path, so no segment ever cuts deeper than the tool would: the deepest cut of them all is the true one.
  vec2 nA = vec2(-vEdge.y, vEdge.x);
  vec2 nB = vec2(-vEdge.w, vEdge.z);
  float t = fanParam(nA, nB, -vDepth.z, 1.0 + vDepth.z);
  vec2 q;
  if (t >= -vDepth.z && t < 1.0 + vDepth.z) {
    q = vRel - t * vAB;
  } else {
    // outside the fan: the tool's cone around an end point, only in the gap between this fan and the next
    t = dot(vRel, vAB) < 0.5 * dot(vAB, vAB) ? 0.0 : 1.0;
    q = vRel - t * vAB;
    if (t > 0.5) {
      if (dot(q, vEdge.zw) < 0.0 || dot(q, vNbr.zw) > 0.0) discard;
    } else {
      if (dot(q, vEdge.xy) > 0.0 || dot(q, vNbr.xy) < 0.0) discard;
    }
  }
  float dist = length(q);
  float depth = mix(vDepth.x, vDepth.y, clamp(t, 0.0, 1.0));
  float hw = max(depth * uTanHalf, 0.6 / uPxPerMm); // drawn half-width here
  float cut = depth * (1.0 - dist / hw);
  if (cut <= 0.0) discard;
  // the wall rises depth/hw per unit away from the path: the normal leans toward the groove's centre
  vec2 u = dist > 0.0 ? q / dist : vec2(0.0);
  mat2 toDisplay = mat2(modelMatrix); // placement rotation
  vec3 n = normalize(vec3(toDisplay * u * (-depth / hw), 1.0));
  float h = clamp(cut / uDepthRange, 0.0, 1.0);
  gNormal = vec4(n * 0.5 + 0.5, h);
  ${
    mrt
      ? `// tool marks run along the tool's motion: across the distance gradient (around the cone at a corner)
  vec2 tg = toDisplay * (dist > 0.0 ? vec2(-u.y, u.x) : vAB / sqrt(dot(vAB, vAB)));
  gAniso = vec4(vec2(tg.x * tg.x - tg.y * tg.y, 2.0 * tg.x * tg.y) * 0.5 + 0.5, uAniso, 1.0);`
      : ''
  }
  gl_FragDepth = 1.0 - 0.999 * h;
}
`;
}

/** Flat (uncut) surface for the groove buffers, with a small bevel at the rim of the work disc. */
export const grooveBgVert = /* glsl */ `${HEADER}
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
out vec2 vP;      // display frame
out vec2 vLocal;  // work frame (relative to the work centre)
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vP = w.xy;
  vLocal = position.xy;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export function grooveBgFrag(mrt: boolean): string {
  return /* glsl */ `${HEADER}
uniform mat4 modelMatrix;
uniform float uRadius;
uniform float uBevel;
in vec2 vP;
in vec2 vLocal;
layout(location = 0) out vec4 gNormal;
${mrt ? 'layout(location = 1) out vec4 gAniso;' : ''}
void main() {
  float r = length(vLocal);
  vec3 n = vec3(0.0, 0.0, 1.0);
  float h = 0.0;
  if (uBevel > 0.0 && r > uRadius - uBevel) {
    vec2 dir = (modelMatrix * vec4(vLocal / max(r, 1e-6), 0.0, 0.0)).xy;
    n = normalize(vec3(dir * 0.9, 1.0));
  }
  gNormal = vec4(n * 0.5 + 0.5, h);
  ${mrt ? 'gAniso = vec4(0.5, 0.5, 0.0, 1.0);' : ''}
}
`;
}

/** Paper disc on a neutral surround with a soft drop shadow. Outputs sRGB directly. */
export const backgroundVert = grooveBgVert;
export const backgroundFrag = /* glsl */ `${HEADER}
uniform float uRadius;
uniform vec3 uPaper;
uniform vec3 uSurround;
uniform float uPaperOn;
uniform float uShadow;
uniform float uAlpha;
uniform vec2 uCenter; // work centre in the display frame
uniform float uTiltOn;
uniform mat3 uShadowH; // tilted view: window point → the plate point seen through it
in vec2 vP;
in vec2 vLocal;
out vec4 fragColor;
void main() {
  float r = length(vLocal);
  float aa = max(fwidth(r), 1e-6);
  float inside = clamp((uRadius - r) / aa + 0.5, 0.0, 1.0);
  vec2 sp = vP;
  float shOk = 1.0;
  if (uTiltOn > 0.5) {
    // the shadow follows the tilted plate's silhouette
    vec3 hp = uShadowH * vec3(vP, 1.0);
    shOk = step(1e-9, hp.z);
    sp = hp.xy / max(hp.z, 1e-9);
  }
  vec2 q = sp - uCenter - vec2(0.0, -0.018 * uRadius);
  float rs = length(q);
  float sh = shOk * uShadow * 0.6 * (1.0 - smoothstep(uRadius * 0.97, uRadius * 1.12, rs));
  vec3 col = uSurround * (1.0 - sh);
  // a faint vignette on the surround keeps the eye on the work
  col *= 1.0 - 0.18 * smoothstep(uRadius * 1.1, uRadius * 3.0, r) * uShadow;
  col = mix(col, uPaper, inside * uPaperOn);
  fragColor = vec4(col * uAlpha, uAlpha);
}
`;

/**
 * Tilted paper (ink mode): the plate-space ink target mapped onto the tilted disc, with a soft relative
 * Lambert term and a faint paper sheen. Both are normalized to the untilted plate, so tilt 0 is unchanged.
 * Input and output are sRGB bytes, like the flat ink view.
 */
export const paperTiltVert = /* glsl */ `${HEADER}
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 uToDisplay;
uniform vec4 uPlateRect;
in vec3 position;
out vec2 vUv;
out vec3 vWorld;
void main() {
  vec2 d = (uToDisplay * vec3(position.xy, 1.0)).xy;
  vUv = (d - uPlateRect.xy) * uPlateRect.zw;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const paperTiltFrag = /* glsl */ `${HEADER}
uniform sampler2D uTex;
uniform vec3 uNormal; // plate normal, world
uniform vec3 uLight;  // toward the light, world (unit)
uniform vec3 uEye;    // eye, world
uniform float uLodBias;
in vec2 vUv;
in vec3 vWorld;
out vec4 fragColor;
float sheen(vec3 n, vec3 h) {
  return pow(max(dot(n, h), 0.0), 18.0);
}
void main() {
  vec3 c = texture(uTex, vUv, uLodBias).rgb;
  float lam = (0.72 + 0.28 * max(dot(uNormal, uLight), 0.0)) / (0.72 + 0.28 * max(uLight.z, 0.0));
  vec3 v = normalize(uEye - vWorld);
  vec3 h = normalize(uLight + v);
  float s = 0.06 * (sheen(uNormal, h) - sheen(vec3(0.0, 0.0, 1.0), h));
  fragColor = vec4(c * lam + s * vec3(1.0, 0.99, 0.96), 1.0);
}
`;

/** Tool marker: ring + crosshair ticks with a dark halo, constant size in pixels. */
export const markerVert = /* glsl */ `${HEADER}
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec2 uCenter;
uniform float uSizeMm;
in vec3 position;
out vec2 vQ;
void main() {
  vQ = position.xy;
  gl_Position = projectionMatrix * viewMatrix * vec4(uCenter + position.xy * uSizeMm, 0.5, 1.0);
}
`;

export const markerFrag = /* glsl */ `${HEADER}
uniform float uSizePx;
uniform vec3 uColor;
in vec2 vQ;
out vec4 fragColor;
float shape(vec2 q, float grow) {
  float r = length(q);
  float ring = 1.0 - smoothstep(0.8 + grow, 1.6 + grow, abs(r - 8.0));
  float axis = min(abs(q.x), abs(q.y));
  float ticks = (1.0 - smoothstep(0.55 + grow, 1.3 + grow, axis)) * smoothstep(10.5 - grow, 11.5 - grow, r) * (1.0 - smoothstep(17.0 + grow, 18.0 + grow, r));
  float dotc = 1.0 - smoothstep(1.2 + grow, 2.2 + grow, r);
  return max(max(ring, ticks), dotc);
}
void main() {
  vec2 q = vQ * uSizePx;
  float m = shape(q, 0.0);
  float halo = shape(q, 1.6);
  vec3 col = mix(vec3(0.05, 0.05, 0.06), uColor, m);
  float a = max(m, halo * 0.55);
  if (a <= 0.0) discard;
  fragColor = vec4(col * a, a);
}
`;

/** Copies a cached viewport image (1:1 texels) to the canvas. */
export const blitVert = /* glsl */ `${HEADER}
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const blitFrag = /* glsl */ `${HEADER}
uniform sampler2D uTex;
in vec2 vUv;
out vec4 fragColor;
void main() {
  fragColor = texture(uTex, vUv);
}
`;
