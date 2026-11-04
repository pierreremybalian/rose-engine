// Dev fixtures for the render module: a synthetic Toolpath generator (concentric rosette loops) shaped
// exactly like the engine contract, a stub Prepared, a fallback poseAtSample, and a stub IMachineModel.
import * as THREE from 'three';
import type { Pass, Pose, Prepared, Toolpath } from '../src/engine/types';
import type { IMachineModel } from '../src/render/types';
import type { CameraPreset } from '../src/state/store';
import type { Recipe } from '../src/state/recipe';

const TAU = Math.PI * 2;

export interface FixtureOptions {
  passes: number;
  samplesPerRev: number;
  startRadius: number;
  endRadius: number;
  lobes: number;
  amplitude: number;
  /** Half-lobe phase alternation every pass (barleycorn). */
  alternate: boolean;
  /** Pump amplitude in mm (0 = no pump). */
  pump: number;
  pumpLobes: number;
}

export const SMALL_FIXTURE: FixtureOptions = {
  passes: 60,
  samplesPerRev: 2048,
  startRadius: 6,
  endRadius: 47,
  lobes: 18,
  amplitude: 1.1,
  alternate: true,
  pump: 0,
  pumpLobes: 0,
};

/** ~1.5M samples. */
export const LARGE_FIXTURE: FixtureOptions = {
  passes: 183,
  samplesPerRev: 8192,
  startRadius: 4,
  endRadius: 48,
  lobes: 36,
  amplitude: 0.6,
  alternate: true,
  pump: 0.04,
  pumpLobes: 9,
};

export function fixtureToolpath(o: FixtureOptions): Toolpath {
  const n = o.samplesPerRev;
  const total = o.passes * n;
  const x = new Float32Array(total);
  const y = new Float32Array(total);
  const z = new Float32Array(total);
  const theta = new Float32Array(total);
  const passes: Pass[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let zMin = Infinity, zMax = -Infinity;
  let length = 0;
  for (let p = 0; p < o.passes; p++) {
    const r0 = o.passes > 1 ? o.startRadius + ((o.endRadius - o.startRadius) * p) / (o.passes - 1) : o.startRadius;
    const phase = o.alternate && p % 2 === 1 ? Math.PI : 0;
    const start = p * n;
    passes.push({ index: p, division: 0, slidePass: p, closed: true, start, count: n });
    for (let i = 0; i < n; i++) {
      const a = (TAU * i) / n;
      const r = r0 + o.amplitude * Math.cos(o.lobes * a + phase);
      const k = start + i;
      // Work turns CCW by spindle angle → tool point in work frame is at angle -a.
      x[k] = r * Math.cos(-a);
      y[k] = r * Math.sin(-a);
      z[k] = o.pump ? o.pump * Math.cos(o.pumpLobes * a) : 0;
      theta[k] = TAU * p + a;
      if (x[k] < minX) minX = x[k];
      if (x[k] > maxX) maxX = x[k];
      if (y[k] < minY) minY = y[k];
      if (y[k] > maxY) maxY = y[k];
      if (z[k] < zMin) zMin = z[k];
      if (z[k] > zMax) zMax = z[k];
      if (i > 0) length += Math.hypot(x[k] - x[k - 1], y[k] - y[k - 1]);
    }
    length += Math.hypot(x[start] - x[start + n - 1], y[start] - y[start + n - 1]);
  }
  return {
    x, y, z, theta, passes,
    samplesPerRev: n,
    totalSamples: total,
    zMin, zMax,
    bounds: { minX, minY, maxX, maxY },
    totalLength: length,
  };
}

export function fixturePrepared(recipe: Recipe): Prepared {
  return { recipe };
}

/** Fallback pose when the engine is not available: derived from the toolpath arrays. */
export function fixturePoseAtSample(_prepared: Prepared, tp: Toolpath, sample: number): Pose {
  const s = Math.max(0, Math.min(tp.totalSamples - 1, sample));
  const i = Math.floor(s);
  const f = s - i;
  const j = Math.min(tp.totalSamples - 1, i + 1);
  const th = tp.theta[i] + (tp.theta[j] - tp.theta[i]) * f;
  const xx = tp.x[i] + (tp.x[j] - tp.x[i]) * f;
  const yy = tp.y[i] + (tp.y[j] - tp.y[i]) * f;
  let pass = 0;
  for (let k = 0; k < tp.passes.length; k++) if (tp.passes[k].start <= i) pass = k;
  return {
    pass,
    division: 0,
    slidePass: pass,
    spindleAngle: th,
    rock: 0,
    pump: tp.z[i],
    slideRadius: Math.hypot(xx, yy),
    divisionAngle: 0,
  };
}

/** Minimal stand-in for the procedural machine: a headstock block, a spindle and a work disc that spins. */
export function createStubMachine(): IMachineModel {
  const group = new THREE.Group();
  const brass = new THREE.MeshStandardMaterial({ color: 0xb08d57, metalness: 1, roughness: 0.35 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 1, roughness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2c30, metalness: 0.2, roughness: 0.7 });

  const bed = new THREE.Mesh(new THREE.BoxGeometry(520, 30, 200), dark);
  bed.position.set(0, -140, -60);
  bed.castShadow = bed.receiveShadow = true;
  group.add(bed);

  const head = new THREE.Mesh(new THREE.BoxGeometry(160, 200, 120), brass);
  head.position.set(0, -25, -160);
  head.castShadow = head.receiveShadow = true;
  group.add(head);

  const spindle = new THREE.Group();
  group.add(spindle);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(18, 18, 120, 48), steel);
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = -60;
  shaft.castShadow = true;
  spindle.add(shaft);
  const chuck = new THREE.Mesh(new THREE.CylinderGeometry(55, 55, 18, 64), steel);
  chuck.rotation.x = Math.PI / 2;
  chuck.position.z = -10;
  chuck.castShadow = true;
  spindle.add(chuck);

  let discRadius = 50;
  let disc = new THREE.Mesh(new THREE.CircleGeometry(discRadius, 128), new THREE.MeshStandardMaterial({ color: 0xdddddd }) as THREE.Material);
  disc.position.z = 1;
  disc.castShadow = true;
  spindle.add(disc);
  const discEdge = new THREE.Mesh(new THREE.CylinderGeometry(discRadius, discRadius, 2, 128, 1, true), steel);
  discEdge.rotation.x = Math.PI / 2;
  spindle.add(discEdge);

  const tool = new THREE.Mesh(new THREE.ConeGeometry(4, 40, 24), steel);
  tool.rotation.x = Math.PI / 2;
  tool.position.set(30, 0, 22);
  tool.castShadow = true;
  group.add(tool);

  let workMaterial: THREE.Material | null = null;

  return {
    group,
    setRecipe(recipe: Recipe) {
      const r = recipe.machine.workDiameter / 2;
      if (r !== discRadius) {
        discRadius = r;
        disc.geometry.dispose();
        disc.geometry = new THREE.CircleGeometry(r, 128);
        discEdge.geometry.dispose();
        discEdge.geometry = new THREE.CylinderGeometry(r, r, 2, 128, 1, true);
      }
      if (workMaterial) disc.material = workMaterial;
    },
    setPose(pose: Pose) {
      spindle.rotation.z = pose.spindleAngle;
      tool.position.x = pose.slideRadius + pose.rock;
    },
    setWorkMaterial(material: THREE.Material) {
      workMaterial = material;
      disc.material = material;
    },
    getToolTip(target: THREE.Vector3) {
      return target.set(tool.position.x, 0, 2);
    },
    getCameraPreset(preset: CameraPreset) {
      switch (preset) {
        case 'rosette':
          return { position: new THREE.Vector3(-260, 120, 60), target: new THREE.Vector3(0, -20, -160) };
        case 'tool':
          return { position: new THREE.Vector3(70, 40, 130), target: new THREE.Vector3(10, 0, 0) };
        default:
          return { position: new THREE.Vector3(280, 220, 380), target: new THREE.Vector3(0, -40, -60) };
      }
    },
    dispose() {
      group.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
      });
    },
  };
}
