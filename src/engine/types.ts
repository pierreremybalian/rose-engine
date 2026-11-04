// CONTRACT FILE — engine output shapes consumed by render, 3D machine and export modules.
import type { Recipe } from '../state/recipe';

/** One continuous tool stroke inside the Toolpath sample arrays. */
export interface Pass {
  /** Global pass index across all eccentric divisions (0..passes*divisions-1). */
  index: number;
  /** Eccentric division this pass belongs to (0 if eccentric disabled). */
  division: number;
  /** Pass index within the slide program (0..slide.passes-1). */
  slidePass: number;
  /** true = last sample connects back to the first (concentric loop). false for spiral paths. */
  closed: boolean;
  /** Index of the first sample in the Toolpath arrays. */
  start: number;
  /** Number of samples in this stroke. For closed passes the first point is NOT repeated at the end. */
  count: number;
}

/**
 * Work-frame coordinates: origin = centre of the workpiece, +X right, +Y up (maths orientation, NOT screen),
 * units mm. Samples are in drawing order; all strokes are stored back to back.
 */
export interface Toolpath {
  x: Float32Array;
  y: Float32Array;
  /** Pump displacement in mm (signed, 0 when no pump rosette). Metal depth = baseDepth + z; ink width scales with it. */
  z: Float32Array;
  /** Cumulative spindle angle in radians at each sample (monotonic across the whole toolpath). */
  theta: Float32Array;
  passes: Pass[];
  samplesPerRev: number;
  totalSamples: number;
  zMin: number;
  zMax: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Total stroke length in mm. */
  totalLength: number;
}

/**
 * Machine state at one instant. Machine frame: spindle axis at origin, tool fixed on +X.
 * The work turns CCW by spindleAngle. The headstock is displaced by `rock` along -X (away from the tool),
 * so the effective cutting radius is slideRadius + rock. The tool point in the spindle frame is therefore
 * rotate((slideRadius + rock, 0), -spindleAngle), then mapped through the elliptical/eccentric chucks into the work frame.
 */
export interface Pose {
  pass: number;
  division: number;
  slidePass: number;
  /** Radians, cumulative. */
  spindleAngle: number;
  /** mm, lateral headstock displacement from 'rock' rosettes. */
  rock: number;
  /** mm, axial headstock displacement from 'pump' rosettes. */
  pump: number;
  /** mm, tool distance from spindle axis set by the cross-slide. */
  slideRadius: number;
  /** Radians, eccentric dividing-wheel rotation of the work about its own centre. */
  divisionAngle: number;
}

/** Precomputed per-recipe data (e.g. rubber follower tables). Opaque to consumers. */
export interface Prepared {
  recipe: Recipe;
  [key: string]: unknown;
}
