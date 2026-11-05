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
  /** Tilted view only: where the tilt has carried the enamel window glint, in dial radii. */
  uGlintShift: { value: THREE.Vector2 };
}

/** Per-material uniforms of the tilted view: plate-space render target placement. */
export interface TiltUniforms {
  /** Work frame → display frame (the placement). */
  uToDisplay: { value: THREE.Matrix3 };
  /** Plate render target rectangle: (x0, y0) in display mm and (1/width, 1/height) in 1/mm. */
  uPlateRect: { value: THREE.Vector4 };
  /** Mip bias for the supersampled G-buffer: sharp at ~1:1, still filtered where the tilt compresses it. */
  uLodBias: { value: number };
  /**
   * Tangent frame of the tilted plate (view space): the plate's x and y axes, unit length. The G-buffer
   * holds display-frame normals, so this maps them onto the tilted plate exactly; at tilt 0 it is the
   * identity frame the flat view uses.
   */
  uTbnT: { value: THREE.Vector3 };
  uTbnB: { value: THREE.Vector3 };
}

export function createTiltUniforms(lodBias = 0): TiltUniforms {
  return {
    uToDisplay: { value: new THREE.Matrix3() },
    uPlateRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uLodBias: { value: lodBias },
    uTbnT: { value: new THREE.Vector3(1, 0, 0) },
    uTbnB: { value: new THREE.Vector3(0, 1, 0) },
  };
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
    uGlintShift: { value: new THREE.Vector2() },
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
uniform vec2 uGlintShift;
#ifdef ROSE_TILT
  varying vec2 vRosePlate;
  uniform float uLodBias;
  uniform vec3 uTbnT;
  uniform vec3 uTbnB;
#endif
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
  #if defined( ROSE_FLAT ) || defined( ROSE_TILT )
    #ifdef ROSE_FLAT
      vec2 pd = (geometryPosition.xy - uDial.xy) / max(uDial.z, 1e-3);
    #else
      // tilted: the glint is a reflection, so it slides across the dial as the plate turns
      vec2 pd = (vRosePlate - uDial.xy) / max(uDial.z, 1e-3) - uGlintShift;
    #endif
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
 *   buffers are rendered at viewport resolution). The G-buffer already holds view-space (display-frame)
 *   normals, so the tangent frame is the identity: a frame from the UV derivatives would scale each screen
 *   axis by 1/its size and make the shading depend on the viewport (or PNG tile) shape. The view vector
 *   comes from a virtual eye above the dial
 *   (so the orthographic view still gets a sheen gradient), and output is tone-mapped + sRGB-encoded in the
 *   shader so on-screen and PNG renders (render targets) look identical.
 * - 'disc': the 3D workpiece; regular UVs, regular renderer tone mapping.
 * - 'tilt': the tilted flat view. The disc is a real tilted plane seen through a perspective camera at the
 *   virtual eye, so it uses true view vectors; normal/anisotropy UVs map the work-frame position into a
 *   plate-space G-buffer target (`tiltU`). Tone mapping and encoding as 'flat'.
 */
export function createMetalMaterial(
  variant: 'flat' | 'disc' | 'tilt',
  shared: MetalShared,
  tiltU?: TiltUniforms,
): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    metalness: 1,
    roughness: 0.2,
    color: 0xffffff,
    normalScale: new THREE.Vector2(1, 1),
  });
  if (variant !== 'disc') {
    m.toneMapped = false;
    m.dithering = true;
  }
  if (variant === 'tilt') {
    // drawn over the (untilted) surround, which it may cross in depth
    m.depthTest = false;
    m.depthWrite = false;
  }
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared);
    if (tiltU) Object.assign(shader.uniforms, tiltU);
    let fs = shader.fragmentShader;
    if (variant === 'flat') fs = '#define ROSE_FLAT\n' + fs;
    if (variant === 'tilt') fs = '#define ROSE_TILT\n' + fs;
    fs = mustReplace(fs, '#include <clipping_planes_pars_fragment>', `#include <clipping_planes_pars_fragment>\n${ENAMEL_PARS}\nuniform vec3 uVirtualEye;\n${NEUTRAL_TONEMAP}`);
    fs = mustReplace(fs, 'vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;', ENAMEL_APPLY);
    fs = mustReplace(
      fs,
      '#include <lights_physical_fragment>',
      mustReplace(THREE.ShaderChunk.lights_physical_fragment, ANISO_DECODE_FROM, ANISO_DECODE_TO),
    );
    if (variant === 'flat' || variant === 'tilt') {
      // a fixed tangent frame instead of one from UV derivatives (flat: identity; tilted: the plate's axes)
      const frame = variant === 'flat' ? 'mat3( vec3( 1.0, 0.0, 0.0 ), vec3( 0.0, 1.0, 0.0 ), normal )' : 'mat3( uTbnT, uTbnB, normal )';
      const begin = THREE.ShaderChunk.normal_fragment_begin.replace(/mat3 tbn = getTangentFrame\([\s\S]*?\);/, `mat3 tbn = ${frame};`);
      if (begin === THREE.ShaderChunk.normal_fragment_begin) console.warn('[render] tangent frame patch target not found');
      fs = mustReplace(fs, '#include <normal_fragment_begin>', begin);
    }
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
    if (variant === 'tilt') {
      // G-buffer reads go through uLodBias
      fs = mustReplace(fs, '#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps);
      fs = fs.replace(
        /texture2D\(\s*(normalMap|anisotropyMap)\s*,\s*(vNormalMapUv|vAnisotropyMapUv)\s*\)/g,
        'texture( $1, $2, uLodBias )',
      );
      fs = mustReplace(fs, '#include <tonemapping_fragment>', 'gl_FragColor.rgb = reNeutralTonemap( gl_FragColor.rgb );');
      fs = mustReplace(fs, '#include <colorspace_fragment>', 'gl_FragColor = sRGBTransferOETF( gl_FragColor );');
      let vs = shader.vertexShader;
      vs = mustReplace(vs, '#include <common>', '#include <common>\nuniform mat3 uToDisplay;\nuniform vec4 uPlateRect;\nvarying vec2 vRosePlate;');
      vs = mustReplace(
        vs,
        '#include <fog_vertex>',
        `#include <fog_vertex>
        vRosePlate = ( uToDisplay * vec3( position.xy, 1.0 ) ).xy;
        #ifdef USE_NORMALMAP
          vNormalMapUv = ( vRosePlate - uPlateRect.xy ) * uPlateRect.zw;
        #endif
        #ifdef USE_ANISOTROPYMAP
          vAnisotropyMapUv = ( vRosePlate - uPlateRect.xy ) * uPlateRect.zw;
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
  /** Segment mesh textures (buildSegmentMesh). */
  uPoints: { value: THREE.Texture | null };
  uTurns: { value: THREE.Texture | null };
  /** Plate radius (work frame, centred on the origin) the cut is clipped to; 0 = no clip. */
  uClipR: { value: number };
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
    uPoints: { value: null },
    uTurns: { value: null },
    uClipR: { value: 0 },
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
    // the quads are built in the vertex shader and may wind either way
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
