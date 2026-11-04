// CONTRACT FILE — interfaces between the render module, the 3D machine module and main.ts.
import type * as THREE from 'three';
import type { Recipe } from '../state/recipe';
import type { CameraPreset, Layout, WorkFrame } from '../state/store';
import type { Pose, Prepared, Toolpath } from '../engine/types';

/**
 * Workpiece UV convention (shared by surfaces and the 3D disc):
 * u = x / workDiameter + 0.5,  v = y / workDiameter + 0.5   (x, y in work-frame mm, +Y up).
 */

/** Implemented in src/render/machine3d/index.ts as `createMachineModel()`. */
export interface IMachineModel {
  /** Root group, added to the 3D scene by the render module. Units: 1 scene unit = 1 mm. Spindle axis along +Z toward the viewer side where the work is. */
  readonly group: THREE.Group;
  /** Rebuild rosette geometry, set work disc size, swap pen/cutter by recipe.mode. */
  setRecipe(recipe: Recipe, prepared: Prepared): void;
  /** Animate to a machine state. Called every frame during playback. */
  setPose(pose: Pose): void;
  /** Material for the workpiece disc face (provided by the active surface). Disc UVs follow the convention above. */
  setWorkMaterial(material: THREE.Material): void;
  /** World-space position of the tool tip (for the pen/cutter marker and camera framing). */
  getToolTip(target: THREE.Vector3): THREE.Vector3;
  /** Camera position + look-at target for a preset. */
  getCameraPreset(preset: CameraPreset): { position: THREE.Vector3; target: THREE.Vector3 };
  dispose(): void;
}

export interface PngOptions {
  width: number;
  height: number;
  /** Ink mode only: leave the paper transparent. */
  transparent: boolean;
}

/** Implemented in src/render/views.ts as `class RenderApp implements IRenderApp`. Owns the single WebGLRenderer. */
export interface IRenderApp {
  /** New recipe or toolpath: rebuild stroke mesh, surfaces, machine model. */
  setRecipe(recipe: Recipe, prepared: Prepared, toolpath: Toolpath): void;
  /** Number of samples revealed (float). Also moves the machine to poseAtSample(progress). */
  setProgress(samples: number): void;
  setLayout(layout: Layout): void;
  setFrame(frame: WorkFrame): void;
  setCameraPreset(preset: CameraPreset): void;
  /** Render the flat work view (current mode, fully revealed or current progress) at export size. */
  renderPNG(opts: PngOptions): Promise<Blob>;
  /** Fit the flat view to the whole work disc. */
  resetWorkView(): void;
  dispose(): void;
}
