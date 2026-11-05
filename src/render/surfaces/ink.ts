// Ink surface: coloured pen strokes on a paper disc.
import * as THREE from 'three';
import type { InkSettings } from '../../state/recipe';
import type { Toolpath } from '../../engine/types';
import { hexToRgb } from '../../state/colors';
import { backgroundFrag, backgroundVert, inkStrokeFrag, inkStrokeVert, paperTiltFrag, paperTiltVert } from '../shaders/stroke';
import type { TiltUniforms } from './metal';

export interface InkUniforms {
  [k: string]: THREE.IUniform;
  /** Segment mesh textures (buildSegmentMesh). */
  uPoints: { value: THREE.Texture | null };
  uTurns: { value: THREE.Texture | null };
  uPassColors: { value: THREE.Texture | null };
  uPxPerMm: { value: number };
  uLineWidth: { value: number };
  uOpacity: { value: number };
  uZRange: { value: THREE.Vector2 };
  uPump: { value: number };
  uMinPx: { value: number };
  uProgress: { value: number };
  uProgressMin: { value: number };
  /** Plate radius (work frame, centred on the origin) the strokes are clipped to; 0 = no clip. */
  uClipR: { value: number };
  /**
   * Extra overlap between neighbouring segments, px (on top of half a pixel). 0.5 for multisampled targets:
   * a segment keeps or drops a fragment per pixel, so its quad must cover every sample of the pixels it keeps.
   */
  uPadPx: { value: number };
  /** gl_FragCoord → work frame (mm) for the target and camera being drawn (see RenderApp.drawInk). */
  uFragToWork: { value: THREE.Matrix3 };
}

export function createInkUniforms(): InkUniforms {
  return {
    uPoints: { value: null },
    uTurns: { value: null },
    uPassColors: { value: null },
    uPxPerMm: { value: 10 },
    uLineWidth: { value: 0.25 },
    uOpacity: { value: 0.9 },
    uZRange: { value: new THREE.Vector2(0, 0) },
    uPump: { value: 0 },
    uMinPx: { value: 1 },
    uProgress: { value: 0 },
    uProgressMin: { value: -1 },
    uClipR: { value: 0 },
    uPadPx: { value: 0 },
    uFragToWork: { value: new THREE.Matrix3() },
  };
}

/**
 * gl_FragCoord (window px of a w × h target, origin bottom-left) → work frame, for an orthographic camera and
 * the work's placement (model) matrix. Composed and inverted in double precision.
 */
export function fragToWork(cam: THREE.Camera, model: THREE.Matrix4, w: number, h: number, out: THREE.Matrix3): THREE.Matrix3 {
  const m = new THREE.Matrix4()
    .makeScale(w / 2, h / 2, 1)
    .setPosition(w / 2, h / 2, 0)
    .multiply(cam.projectionMatrix)
    .multiply(cam.matrixWorldInverse)
    .multiply(model);
  const e = m.elements;
  // window = [a b; d e]·(x, y) + (c, f)
  const a = e[0], b = e[4], c = e[12], d = e[1], ee = e[5], f = e[13];
  const det = a * ee - b * d;
  const k = det !== 0 ? 1 / det : 0;
  const i00 = ee * k, i01 = -b * k, i10 = -d * k, i11 = a * k;
  return out.set(i00, i01, -(i00 * c + i01 * f), i10, i11, -(i10 * c + i11 * f), 0, 0, 1);
}

export function updateInkUniforms(u: InkUniforms, ink: InkSettings, tp: Toolpath | null): void {
  u.uLineWidth.value = Math.max(0.001, ink.lineWidth);
  u.uOpacity.value = THREE.MathUtils.clamp(ink.opacity, 0, 1);
  const zMin = tp && Number.isFinite(tp.zMin) ? tp.zMin : 0;
  const zMax = tp && Number.isFinite(tp.zMax) ? tp.zMax : 0;
  u.uZRange.value.set(zMin, zMax);
  u.uPump.value = zMax - zMin > 1e-6 ? 1 : 0;
}

/**
 * Premultiplied-alpha blending: correct on opaque paper and on a transparent export alike. The depth test keeps
 * each pass from inking a pixel twice (see inkStrokeFrag): ink targets need a depth buffer, cleared with them.
 */
export function createInkStrokeMaterial(u: InkUniforms): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: inkStrokeVert,
    fragmentShader: inkStrokeFrag,
    uniforms: u,
    transparent: true,
    depthTest: true,
    depthWrite: true,
    depthFunc: THREE.LessDepth,
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
  /** 1 while drawing the surround of the tilted view: the shadow follows the tilted plate through uShadowH. */
  uTiltOn: { value: number };
  uShadowH: { value: THREE.Matrix3 };
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
    uTiltOn: { value: 0 },
    uShadowH: { value: new THREE.Matrix3() },
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

export interface PaperTiltUniforms extends TiltUniforms {
  [k: string]: THREE.IUniform;
  uTex: { value: THREE.Texture | null };
  uNormal: { value: THREE.Vector3 };
  uLight: { value: THREE.Vector3 };
  uEye: { value: THREE.Vector3 };
}

export function createPaperTiltUniforms(tiltU: TiltUniforms): PaperTiltUniforms {
  return {
    ...tiltU,
    uTex: { value: null },
    uNormal: { value: new THREE.Vector3(0, 0, 1) },
    uLight: { value: new THREE.Vector3(0, 0, 1) },
    uEye: { value: new THREE.Vector3(0, 0, 240) },
  };
}

/** The tilted paper disc of the ink view (drawn over the untilted surround, so no depth test). */
export function createPaperTiltMaterial(u: PaperTiltUniforms): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: paperTiltVert,
    fragmentShader: paperTiltFrag,
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
