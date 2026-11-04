// GLSL ES 3.00 sources for the stroke ribbon (used with RawShaderMaterial + GLSL3).
import { MITER_MAX, PASS_TEX_WIDTH } from '../strokeMesh';

const HEADER = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
#define MITER_MAX ${MITER_MAX.toFixed(1)}
#define PASS_TEX_WIDTH ${PASS_TEX_WIDTH}
`;

const STROKE_ATTRIBUTES = /* glsl */ `
in vec3 position;   // x, y mm (work frame), z = pump mm
in vec2 aTangent;   // normalized int16: tangent * miter / MITER_MAX
in float aSide;     // -1 | +1
in float aPass;
in float aSample;
`;

/** Ink: coloured pen strokes, width from a uniform (pump-modulated), fwidth-antialiased edges. */
export const inkStrokeVert = /* glsl */ `${HEADER}
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform sampler2D uPassColors;
uniform float uPxPerMm;
uniform float uLineWidth;
uniform float uOpacity;
uniform vec2 uZRange;
uniform float uPump;
uniform float uMinPx;
${STROKE_ATTRIBUTES}
out float vT;
out float vEdge;
out float vAlpha;
out vec3 vColor;
out float vSample;

void main() {
  float zn = uZRange.y > uZRange.x ? clamp((position.z - uZRange.x) / (uZRange.y - uZRange.x), 0.0, 1.0) : 0.5;
  float wMm = uLineWidth * mix(1.0, mix(0.4, 1.6, zn), uPump);
  float wPx = wMm * uPxPerMm;
  // Never thinner than uMinPx on screen; thinner pens fade instead so density stays right.
  float corePx = max(wPx, uMinPx);
  float halfDrawn = 0.5 * corePx + 1.0; // +1px apron for the antialiased edge
  vec2 T = aTangent * MITER_MAX;
  vec2 N = vec2(-T.y, T.x);
  vec2 p = position.xy + N * (aSide * halfDrawn / uPxPerMm);
  vT = aSide;
  vEdge = 0.5 * corePx / halfDrawn;
  vAlpha = uOpacity * clamp(wPx / uMinPx, 0.0, 1.0);
  int pi = int(aPass + 0.5);
  vColor = texelFetch(uPassColors, ivec2(pi % PASS_TEX_WIDTH, pi / PASS_TEX_WIDTH), 0).rgb;
  vSample = aSample;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
}
`;

export const inkStrokeFrag = /* glsl */ `${HEADER}
uniform float uProgress;
uniform float uProgressMin;
in float vT;
in float vEdge;
in float vAlpha;
in vec3 vColor;
in float vSample;
out vec4 fragColor;

void main() {
  if (vSample > uProgress || vSample <= uProgressMin) discard;
  float d = abs(vT);
  float aa = max(fwidth(vT), 1e-4);
  float cov = clamp((vEdge - d) / aa + 0.5, 0.0, 1.0);
  float a = cov * vAlpha;
  if (a <= 0.0) discard;
  fragColor = vec4(vColor * a, a); // premultiplied
}
`;

/**
 * Metal groove pass: V-groove cross-section from t. Writes the surface normal (rgb, 0..1 encoded) and the
 * cut depth (a, 0..1 of uDepthRange); gl_FragDepth makes the deepest cut win where cuts overlap.
 * With MRT, attachment 1 holds the groove direction as a doubled angle (rg) and anisotropy strength (b).
 */
export const grooveVert = /* glsl */ `${HEADER}
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform float uBaseDepth;
uniform float uTanHalf;
uniform float uPxPerMm;
${STROKE_ATTRIBUTES}
out float vT;
out float vDepth;
out float vSlopeK;
out vec2 vTan;
out float vSample;

void main() {
  float depth = max(uBaseDepth + position.z, 0.0);
  float halfW = depth * uTanHalf;
  // Grooves narrower than ~1.2px are drawn wider with a proportionally shallower wall (pixel-average look).
  float minHalf = 0.6 / uPxPerMm;
  float drawnHalf = max(halfW, minHalf);
  vSlopeK = drawnHalf > 0.0 ? halfW / drawnHalf : 0.0;
  vec2 T = aTangent * MITER_MAX;
  vec2 N = vec2(-T.y, T.x);
  vec4 wp = modelMatrix * vec4(position.xy + N * (aSide * drawnHalf), 0.0, 1.0);
  vec2 td = (modelMatrix * vec4(T, 0.0, 0.0)).xy;
  vTan = td / max(length(td), 1e-9);
  vT = aSide;
  vDepth = depth;
  vSample = aSample;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export function grooveFrag(mrt: boolean): string {
  return /* glsl */ `${HEADER}
uniform float uTanHalf;
uniform float uDepthRange;
uniform float uProgress;
uniform float uProgressMin;
uniform float uAniso;
in float vT;
in float vDepth;
in float vSlopeK;
in vec2 vTan;
in float vSample;
layout(location = 0) out vec4 gNormal;
${mrt ? 'layout(location = 1) out vec4 gAniso;' : ''}

void main() {
  if (vSample > uProgress || vSample <= uProgressMin) discard;
  float a = abs(vT);
  float cut = vDepth * (1.0 - a);
  if (cut <= 0.0) discard;
  vec2 tg = normalize(vTan);
  vec2 nd = vec2(-tg.y, tg.x);
  // Wall rises 1/tan(half angle) per unit of lateral distance; normal leans toward the groove centre.
  float slope = vSlopeK / uTanHalf;
  vec3 n = normalize(vec3(-sign(vT) * nd * slope, 1.0));
  float h = clamp(cut / uDepthRange, 0.0, 1.0);
  gNormal = vec4(n * 0.5 + 0.5, h);
  ${mrt ? 'gAniso = vec4(vec2(tg.x * tg.x - tg.y * tg.y, 2.0 * tg.x * tg.y) * 0.5 + 0.5, uAniso, 1.0);' : ''}
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
in vec2 vP;
in vec2 vLocal;
out vec4 fragColor;
void main() {
  float r = length(vLocal);
  float aa = max(fwidth(r), 1e-6);
  float inside = clamp((uRadius - r) / aa + 0.5, 0.0, 1.0);
  vec2 q = vP - uCenter - vec2(0.0, -0.018 * uRadius);
  float rs = length(q);
  float sh = uShadow * 0.6 * (1.0 - smoothstep(uRadius * 0.97, uRadius * 1.12, rs));
  vec3 col = uSurround * (1.0 - sh);
  // a faint vignette on the surround keeps the eye on the work
  col *= 1.0 - 0.18 * smoothstep(uRadius * 1.1, uRadius * 3.0, r) * uShadow;
  col = mix(col, uPaper, inside * uPaperOn);
  fragColor = vec4(col * uAlpha, uAlpha);
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
