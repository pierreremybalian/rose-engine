// Metal surface: groove G-buffer materials and the physically based engraved-metal look (+ enamel).
import * as THREE from 'three';
import type { MetalKind, MetalSettings } from '../../state/recipe';
import type { Toolpath } from '../../engine/types';
import { grooveBgFrag, grooveBgVert, grooveFrag, grooveVert } from '../shaders/stroke';

interface MetalPreset {
  /** Linear-sRGB F0 (base colour of a metalness-1 surface). */
  color: [number, number, number];
  roughness: number;
  anisotropy: number;
  iridescence?: { strength: number; ior: number; range: [number, number] };
}

export const METAL_PRESETS: Record<MetalKind, MetalPreset> = {
  silver: { color: [0.95, 0.93, 0.88], roughness: 0.2, anisotropy: 0.55 },
  gold: { color: [1.0, 0.71, 0.29], roughness: 0.22, anisotropy: 0.55 },
  rose: { color: [0.97, 0.6, 0.47], roughness: 0.22, anisotropy: 0.55 },
  brass: { color: [0.86, 0.68, 0.33], roughness: 0.27, anisotropy: 0.5 },
  steel: { color: [0.55, 0.56, 0.58], roughness: 0.24, anisotropy: 0.6 },
  blued: { color: [0.04, 0.095, 0.42], roughness: 0.2, anisotropy: 0.55, iridescence: { strength: 0.35, ior: 2.0, range: [250, 320] } },
};

/** Uniforms shared by every metal material (flat view, 3D disc) so one update reaches all of them. */
export interface MetalShared {
  uEnamelOn: { value: number };
  uEnamelColor: { value: THREE.Color };
  uEnamelOpacity: { value: number };
  uVirtualEye: { value: THREE.Vector3 };
  uExposure: { value: number };
  /** Flat view only: dial centre (view-space xy) and radius, for the glass glint. */
  uDial: { value: THREE.Vector3 };
  /** Flat view only: light azimuth as a unit vector in the view plane. */
  uLightXY: { value: THREE.Vector2 };
}

export function createMetalShared(): MetalShared {
  return {
    uEnamelOn: { value: 0 },
    uEnamelColor: { value: new THREE.Color(0x1b3fa0) },
    uEnamelOpacity: { value: 0.6 },
    uVirtualEye: { value: new THREE.Vector3(0, 0, 300) },
    uExposure: { value: 1 },
    uDial: { value: new THREE.Vector3(0, 0, 50) },
    uLightXY: { value: new THREE.Vector2(1, 0) },
  };
}

const NEUTRAL_TONEMAP = /* glsl */ `
uniform float uExposure;
vec3 reNeutralTonemap(vec3 color) {
  const float startCompression = 0.8 - 0.04;
  const float desaturation = 0.15;
  color *= uExposure;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) return color;
  float d = 1.0 - startCompression;
  float newPeak = 1.0 - d * d / (peak + d - startCompression);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(color, vec3(newPeak), g);
}
`;

const ENAMEL_PARS = /* glsl */ `
uniform float uEnamelOn;
uniform vec3 uEnamelColor;
uniform float uEnamelOpacity;
uniform vec3 uDial;
uniform vec2 uLightXY;
`;

/**
 * Translucent vitreous enamel over the cut metal (flinqué).
 * - Multiplicative only, so the engraving's sheen bands and the metal's highlights stay visible through it.
 * - The colour acts through a tint whose saturation grows with opacity × thickness and is capped well short
 *   of a pure filter (a pure filter turns any dark teal into neon cyan); the tint is partly compensated
 *   for luminance so dark and bright picks both land near the bare metal's value.
 * - Deeper cuts hold more glass: more saturated and darker.
 * - The physical clearcoat (set by applyMetalPreset) adds the glassy top reflection; the flat orthographic
 *   view also gets a soft window glint, since its virtual eye never sees the coat's mirror reflection.
 */
const ENAMEL_APPLY = /* glsl */ `
vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;
#ifdef USE_NORMALMAP
if (uEnamelOn > 0.5) {
  const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
  float cutDepth = texture2D(normalMap, vNormalMapUv).a;
  float op = clamp(uEnamelOpacity, 0.0, 1.0);
  float thickness = 0.7 + 1.6 * cutDepth;
  vec3 hueN = uEnamelColor / max(max(uEnamelColor.r, uEnamelColor.g), max(uEnamelColor.b, 1e-4));
  float sat = min(0.92, 1.0 - exp(-2.4 * op * thickness));
  // bright reflections keep a little more of their own colour so the sparkle survives
  float lumIn = dot(outgoingLight, LUM);
  sat /= 1.0 + 0.2 * lumIn;
  vec3 tint = mix(vec3(1.0), hueN, sat);
  tint *= clamp(inversesqrt(max(dot(tint, LUM), 1e-3)), 1.0, 1.25);
  float dark = exp(-op * (0.35 + 0.9 * cutDepth));
  outgoingLight *= tint * dark;
  #ifdef ROSE_FLAT
    vec2 pd = (geometryPosition.xy - uDial.xy) / max(uDial.z, 1e-3);
    float along = dot(pd, uLightXY);
    float across = abs(dot(pd, vec2(-uLightXY.y, uLightXY.x)));
    float glint = exp(-pow((along - 0.45) / 0.2, 2.0)) + 0.4 * exp(-pow((along + 0.12) / 0.05, 2.0));
    glint *= 1.0 - smoothstep(0.55, 1.05, across);
    outgoingLight += vec3(0.95, 0.97, 1.0) * 0.11 * glint;
  #endif
}
#endif
`;

/** Doubled-angle anisotropy direction (survives MSAA averaging; disagreement → isotropic). */
const ANISO_DECODE_FROM = 'vec2 anisotropyV = anisotropyMat * normalize( 2.0 * anisotropyPolar.rg - vec2( 1.0 ) ) * anisotropyPolar.b;';
const ANISO_DECODE_TO = /* glsl */ `
vec2 aniso2 = 2.0 * anisotropyPolar.rg - vec2( 1.0 );
float anisoLen = length( aniso2 );
float anisoHalf = 0.5 * atan( aniso2.y, aniso2.x + 1e-6 );
// rotate 90°: roughness is stretched across the groove, so highlights run along the cut like tool marks
vec2 anisoDir = vec2( -sin( anisoHalf ), cos( anisoHalf ) );
vec2 anisotropyV = anisotropyMat * anisoDir * anisotropyPolar.b * min( anisoLen, 1.0 );
`;

const VIEW_DIR_FROM = 'vec3 geometryViewDir = ( isOrthographic ) ? vec3( 0, 0, 1 ) : normalize( vViewPosition );';
const VIEW_DIR_TO = 'vec3 geometryViewDir = normalize( uVirtualEye - geometryPosition );';

function mustReplace(src: string, from: string, to: string): string {
  if (!src.includes(from)) {
    console.warn('[render] shader patch target not found:', from.slice(0, 60));
    return src;
  }
  return src.replace(from, to);
}

/**
 * MeshPhysicalMaterial for engraved metal.
 * - 'flat': the flat work view. normalMap/anisotropyMap UVs come from the screen position (the groove
 *   buffers are rendered at viewport resolution), the view vector comes from a virtual eye above the dial
 *   (so the orthographic view still gets a sheen gradient), and output is tone-mapped + sRGB-encoded in the
 *   shader so on-screen and PNG renders (render targets) look identical.
 * - 'disc': the 3D workpiece; regular UVs, regular renderer tone mapping.
 */
export function createMetalMaterial(variant: 'flat' | 'disc', shared: MetalShared): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    metalness: 1,
    roughness: 0.2,
    color: 0xffffff,
    normalScale: new THREE.Vector2(1, 1),
  });
  if (variant === 'flat') {
    m.toneMapped = false;
    m.dithering = true;
  }
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared);
    let fs = shader.fragmentShader;
    if (variant === 'flat') fs = '#define ROSE_FLAT\n' + fs;
    fs = mustReplace(fs, '#include <clipping_planes_pars_fragment>', `#include <clipping_planes_pars_fragment>\n${ENAMEL_PARS}\nuniform vec3 uVirtualEye;\n${NEUTRAL_TONEMAP}`);
    fs = mustReplace(fs, 'vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;', ENAMEL_APPLY);
    fs = mustReplace(
      fs,
      '#include <lights_physical_fragment>',
      mustReplace(THREE.ShaderChunk.lights_physical_fragment, ANISO_DECODE_FROM, ANISO_DECODE_TO),
    );
    if (variant === 'flat') {
      fs = mustReplace(
        fs,
        '#include <lights_fragment_begin>',
        mustReplace(THREE.ShaderChunk.lights_fragment_begin, VIEW_DIR_FROM, VIEW_DIR_TO),
      );
      fs = mustReplace(fs, '#include <tonemapping_fragment>', 'gl_FragColor.rgb = reNeutralTonemap( gl_FragColor.rgb );');
      fs = mustReplace(fs, '#include <colorspace_fragment>', 'gl_FragColor = sRGBTransferOETF( gl_FragColor );');
      let vs = shader.vertexShader;
      vs = mustReplace(
        vs,
        '#include <fog_vertex>',
        `#include <fog_vertex>
        #ifdef USE_NORMALMAP
          vNormalMapUv = gl_Position.xy / gl_Position.w * 0.5 + 0.5;
        #endif
        #ifdef USE_ANISOTROPYMAP
          vAnisotropyMapUv = gl_Position.xy / gl_Position.w * 0.5 + 0.5;
        #endif`,
      );
      shader.vertexShader = vs;
    }
    shader.fragmentShader = fs;
  };
  m.customProgramCacheKey = () => `rose-metal-${variant}`;
  return m;
}

/** Light direction (display frame, unit) from azimuth/elevation in degrees. */
export function lightDirection(azimuthDeg: number, elevationDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(elevationDeg, 2, 89));
  return out.set(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el));
}

/** Rotation that carries the room environment's ceiling (+Y) onto the light direction. */
export function envRotationForLight(L: THREE.Vector3, out = new THREE.Euler()): THREE.Euler {
  const y = L.clone().normalize();
  // room "front" (+Z) leans toward the dial normal (+Z) as far as it can while staying ⟂ to y
  const z = new THREE.Vector3(0, 0, 1).addScaledVector(y, -y.z);
  if (z.lengthSq() < 1e-6) z.set(0, -1, 0);
  z.normalize();
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  return out.setFromRotationMatrix(m);
}

export function applyMetalPreset(m: THREE.MeshPhysicalMaterial, s: MetalSettings, variant: 'flat' | 'disc'): void {
  const p = METAL_PRESETS[s.material] ?? METAL_PRESETS.silver;
  m.color.setRGB(p.color[0], p.color[1], p.color[2], THREE.LinearSRGBColorSpace);
  m.roughness = variant === 'disc' ? Math.min(1, p.roughness + 0.04) : p.roughness;
  m.anisotropy = variant === 'flat' ? p.anisotropy : 0;
  if (p.iridescence) {
    m.iridescence = p.iridescence.strength;
    m.iridescenceIOR = p.iridescence.ior;
    m.iridescenceThicknessMinimum = p.iridescence.range[0];
    m.iridescenceThicknessMaximum = p.iridescence.range[1];
  } else {
    m.iridescence = 0;
  }
  if (s.enamel) {
    m.clearcoat = 1;
    m.clearcoatRoughness = 0.04;
  } else {
    m.clearcoat = 0;
  }
}

export function updateMetalShared(shared: MetalShared, s: MetalSettings): void {
  shared.uEnamelOn.value = s.enamel ? 1 : 0;
  shared.uEnamelColor.value.set(s.enamelColor);
  shared.uEnamelOpacity.value = THREE.MathUtils.clamp(s.enamelOpacity, 0, 1);
}

/** Uniforms of the groove (G-buffer) pass. */
export interface GrooveUniforms {
  [k: string]: THREE.IUniform;
  uBaseDepth: { value: number };
  uTanHalf: { value: number };
  uPxPerMm: { value: number };
  uDepthRange: { value: number };
  uProgress: { value: number };
  uProgressMin: { value: number };
  uAniso: { value: number };
}

export function createGrooveUniforms(): GrooveUniforms {
  return {
    uBaseDepth: { value: 0.08 },
    uTanHalf: { value: Math.tan(Math.PI / 3) },
    uPxPerMm: { value: 10 },
    uDepthRange: { value: 0.2 },
    uProgress: { value: 0 },
    uProgressMin: { value: -1 },
    uAniso: { value: 1 },
  };
}

export function updateGrooveUniforms(u: GrooveUniforms, s: MetalSettings, tp: Toolpath | null): void {
  const angle = THREE.MathUtils.clamp(s.toolAngle, 20, 170);
  u.uBaseDepth.value = Math.max(0, s.baseDepth);
  u.uTanHalf.value = Math.tan(THREE.MathUtils.degToRad(angle / 2));
  const zMax = tp && Number.isFinite(tp.zMax) ? tp.zMax : 0;
  u.uDepthRange.value = Math.max(1e-3, s.baseDepth + Math.max(0, zMax)) * 1.001;
}

export function createGrooveMaterial(u: GrooveUniforms, mrt: boolean): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: grooveVert,
    fragmentShader: grooveFrag(mrt),
    uniforms: u,
    depthTest: true,
    depthWrite: true,
    depthFunc: THREE.LessDepth,
    side: THREE.DoubleSide,
  });
}

export function createGrooveBgMaterial(u: { uRadius: { value: number }; uBevel: { value: number } }, mrt: boolean): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: grooveBgVert,
    fragmentShader: grooveBgFrag(mrt),
    uniforms: u,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}
