// Ink surface: coloured pen strokes on a paper disc.
import * as THREE from 'three';
import type { InkSettings } from '../../state/recipe';
import type { Toolpath } from '../../engine/types';
import { hexToRgb } from '../../state/colors';
import { backgroundFrag, backgroundVert, inkStrokeFrag, inkStrokeVert } from '../shaders/stroke';

export interface InkUniforms {
  [k: string]: THREE.IUniform;
  uPassColors: { value: THREE.Texture | null };
  uPxPerMm: { value: number };
  uLineWidth: { value: number };
  uOpacity: { value: number };
  uZRange: { value: THREE.Vector2 };
  uPump: { value: number };
  uMinPx: { value: number };
  uProgress: { value: number };
  uProgressMin: { value: number };
}

export function createInkUniforms(): InkUniforms {
  return {
    uPassColors: { value: null },
    uPxPerMm: { value: 10 },
    uLineWidth: { value: 0.25 },
    uOpacity: { value: 0.9 },
    uZRange: { value: new THREE.Vector2(0, 0) },
    uPump: { value: 0 },
    uMinPx: { value: 1 },
    uProgress: { value: 0 },
    uProgressMin: { value: -1 },
  };
}

export function updateInkUniforms(u: InkUniforms, ink: InkSettings, tp: Toolpath | null): void {
  u.uLineWidth.value = Math.max(0.001, ink.lineWidth);
  u.uOpacity.value = THREE.MathUtils.clamp(ink.opacity, 0, 1);
  const zMin = tp && Number.isFinite(tp.zMin) ? tp.zMin : 0;
  const zMax = tp && Number.isFinite(tp.zMax) ? tp.zMax : 0;
  u.uZRange.value.set(zMin, zMax);
  u.uPump.value = zMax - zMin > 1e-6 ? 1 : 0;
}

/** Premultiplied-alpha blending: correct on opaque paper and on a transparent export alike. */
export function createInkStrokeMaterial(u: InkUniforms): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: inkStrokeVert,
    fragmentShader: inkStrokeFrag,
    uniforms: u,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    premultipliedAlpha: true,
  });
}

export interface BackgroundUniforms {
  [k: string]: THREE.IUniform;
  uRadius: { value: number };
  uPaper: { value: THREE.Vector3 };
  uSurround: { value: THREE.Vector3 };
  uPaperOn: { value: number };
  uShadow: { value: number };
  uAlpha: { value: number };
  uCenter: { value: THREE.Vector2 };
}

/** Neutral surround around the work (sRGB). */
export const SURROUND_SRGB: [number, number, number] = [0.125, 0.126, 0.135];

export function createBackgroundUniforms(): BackgroundUniforms {
  return {
    uRadius: { value: 50 },
    uPaper: { value: new THREE.Vector3(0.957, 0.937, 0.894) },
    uSurround: { value: new THREE.Vector3(...SURROUND_SRGB) },
    uPaperOn: { value: 1 },
    uShadow: { value: 1 },
    uAlpha: { value: 1 },
    uCenter: { value: new THREE.Vector2() },
  };
}

export function srgbHexToVec3(hex: string, out: THREE.Vector3): THREE.Vector3 {
  const [r, g, b] = hexToRgb(hex);
  return out.set(r / 255, g / 255, b / 255);
}

export function createBackgroundMaterial(u: BackgroundUniforms): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: backgroundVert,
    fragmentShader: backgroundFrag,
    uniforms: u,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/**
 * 3D workpiece material for ink mode: the 4096² ink target holds sRGB bytes (blended in sRGB like a 2D
 * canvas), so decode them in the shader instead of relying on an sRGB texture format.
 */
export function createInkDiscMaterial(map: THREE.Texture): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map, roughness: 0.82, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
        vec4 sampledDiffuseColor = sRGBTransferEOTF( texture2D( map, vMapUv ) );
        diffuseColor *= sampledDiffuseColor;
      #endif`,
    );
  };
  m.customProgramCacheKey = () => 'rose-ink-disc';
  return m;
}
