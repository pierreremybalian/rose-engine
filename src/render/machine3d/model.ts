// Procedural 3D rose engine lathe. 1 scene unit = 1 mm.
//
// Machine frame (the group's local space):
//   +Y up; bench underside at y = 0. Spindle axis is the line (x = 0, y = H) along Z.
//   The work face sits at z = 0 (plus pose.pump), facing +Z; the tool approaches it from +Z and sits on +X.
//   Rosettes are behind the headstock (toward -Z); the rubbers touch them on the +X side.
//
// Kinematics (see src/engine/types.ts): the headstock rocks about a pivot below the spindle so the spindle
// axis moves by exactly -pose.rock along X, and slides by pose.pump along Z. The spindle (and rosettes)
// turn by pose.spindleAngle, CCW seen from +Z. The work disc is placed every frame with the engine's
// workPlacement() (machine = rot * work + t, tool point -> (slideRadius + rock, 0)), shifted by -rock, so
// disc-local (x, y) = toolPoint(pose) lands exactly under the tool tip at (slideRadius, H, pump).
// Each cam is turned by -rosettePhaseDeg() so its shape at the rubber (+X, phi = -spindleAngle) is the
// one the engine is cutting.
import * as THREE from 'three';
import type { IMachineModel } from '../types';
import { defaultRecipe, type Recipe, type Rosette } from '../../state/recipe';
import type { CameraPreset } from '../../state/store';
import type { Pose, Prepared } from '../../engine/types';
import { rosettePhaseDeg, toolPoint, workPlacement } from '../../engine';
import { createMaterials, type MachineMaterials } from './materials';
import {
  TAU,
  cylX,
  cylY,
  cylZ,
  discZ,
  handwheelGeometries,
  hexY,
  hexZ,
  knobY,
  latheZ,
  rboxSpan,
  ringZ,
  roundedPlateZ,
  springGeometry,
  standardGeometry,
} from './geom';
import {
  PUMP_BODY,
  ROCK_THICK,
  buildPumpTrack,
  buildRockRosette,
  pumpRollerHeight,
  pumpTrackBase,
  pumpTrackRadii,
  rollerDistance,
  rosetteShapeKey,
} from './rosettes';

// ---------------------------------------------------------------------------------------------
// Fixed stations (mm)
// ---------------------------------------------------------------------------------------------
const BENCH_T = 56; // mahogany plinth thickness (y 0..BENCH_T)
const FOOT_H = 6;
const BED_H = 64;
const BED_TOP = BENCH_T + FOOT_H + BED_H;
const PIVOT_Y = BED_TOP + 30;
const SPINDLE_R = 11;
const DISC_T = 4;
const STD_RT = 36; // standard top boss radius (around the spindle bearing)
const STD_RB = 22; // standard bottom boss radius (around the pivot)
const Z_FRONT_STD: [number, number] = [-84, -60];
const Z_REAR_STD: [number, number] = [-172, -148];
const Z_STACK0 = -188; // front face of the first rosette
const Z_SLIDE_REST: [number, number] = [70, 114];
const Z_BED_FRONT = 142;
const DIAL_Z = (Z_FRONT_STD[0] + Z_FRONT_STD[1]) / 2;
const LEAD_PITCH = 2;
const PUMP_BALL = 1.5; // radius of the face-cam follower ball

interface StackItem {
  rosette: Rosette;
  /** Index in recipe.rosettes (for rosettePhaseDeg). */
  index: number;
  /** z of the rosette group origin in spindle space (rock: centre plane; pump: body front face). */
  z: number;
  /** pump: maximum track height (for spacing / rubber). */
  hMax: number;
}

interface Layout {
  H: number;
  L: number;
  R0: number;
  rv: number;
  D: number;
  rc: number;
  stack: StackItem[];
  activeRock: number; // index into stack, -1 if none
  activePump: number;
  zStackEnd: number;
  zPumpStand: number;
  zHW: number;
  zTail: number;
  zBack: number;
  xNeg: number;
  xPos: number;
  xRubber: number;
  wayX0: number;
  wayX1: number;
  plateHalf: number;
}

const q = (v: number, step: number) => Math.ceil(v / step - 1e-9) * step;

function computeLayout(recipe: Recipe): Layout {
  const R0 = recipe.machine.rosetteRadius;
  // Rubber contact radius: exactly the recipe's (knife edge below 0.5 mm), so the follower sits where the engine's does.
  const rv = recipe.machine.rubberRadius < 0.5 ? 0 : recipe.machine.rubberRadius;
  const D = recipe.machine.workDiameter;
  const rock = recipe.rosettes.filter((r) => r.axis === 'rock');
  const pumps = recipe.rosettes.filter((r) => r.axis === 'pump');
  const activePumpRos = pumps.find((r) => r.enabled) ?? null;
  // Physical order on the spindle: rock rosettes, idle pump rosettes, the active face cam last (its rubber sits behind it).
  const ordered = [...rock, ...pumps.filter((r) => r !== activePumpRos), ...(activePumpRos ? [activePumpRos] : [])];
  const stack: StackItem[] = [];
  let z = Z_STACK0;
  let maxRockAmp = 0;
  for (const r of ordered) {
    if (r.axis === 'rock') {
      stack.push({ rosette: r, index: recipe.rosettes.indexOf(r), z: z - ROCK_THICK / 2, hMax: 0 });
      z -= ROCK_THICK + 6;
      maxRockAmp = Math.max(maxRockAmp, Math.abs(r.amplitude));
    } else {
      const hMax = q(pumpTrackBase(r) + Math.abs(r.amplitude), 1);
      stack.push({ rosette: r, index: recipe.rosettes.indexOf(r), z, hMax });
      z -= PUMP_BODY + hMax + 6;
    }
  }
  const zStackEnd = z + 6;
  const activeRock = stack.findIndex((s) => s.rosette.axis === 'rock' && s.rosette.enabled);
  const activePump = activePumpRos ? stack.length - 1 : -1;
  const zPumpStand = activePump >= 0 ? stack[activePump].z - PUMP_BODY - stack[activePump].hMax - PUMP_BALL - 38 : zStackEnd;
  const zHW = (activePump >= 0 ? zPumpStand : zStackEnd) - 36;
  const ecc = recipe.eccentric.enabled ? Math.abs(recipe.eccentric.offset) : 0;
  const ell = recipe.elliptical.enabled ? Math.abs(recipe.elliptical.e) : 0;
  const maxSlide = Math.max(Math.abs(recipe.slide.startRadius), Math.abs(recipe.slide.endRadius));
  const rc = Math.min(46, Math.max(18, q(D * 0.3, 2)));
  const need = Math.max(160, R0 + maxRockAmp + 22, D / 2 + ecc + ell + 16, 64);
  const H = BED_TOP + q(need, 10);
  const xRubber = q(R0 + maxRockAmp + Math.max(rv, 1.5) + 44, 2);
  const wayX1 = q(Math.max(140, D / 2 + ecc + ell + 30, maxSlide + 60), 10);
  return {
    H,
    L: H - PIVOT_Y,
    R0,
    rv: Math.round(rv * 10) / 10,
    D,
    rc,
    stack,
    activeRock,
    activePump,
    zStackEnd,
    zPumpStand,
    zHW,
    zTail: zHW - 14,
    zBack: -q(-(zHW - 40), 10),
    xNeg: -q(Math.max(R0 + 40, 100), 10),
    xPos: q(Math.max(xRubber + 34, 150), 10),
    xRubber,
    wayX0: -60,
    wayX1,
    plateHalf: q(ecc + ell + rc + 8, 2),
  };
}

/** Everything that forces a rebuild of the static structure (rosette geometry is cached separately). */
function structureKey(l: Layout): string {
  return JSON.stringify({
    H: l.H,
    R0: l.R0,
    rv: l.rv,
    rc: l.rc,
    s: l.stack.map((s) => [s.rosette.id, s.rosette.axis, s.z, s.hMax]),
    a: [l.activeRock, l.activePump],
    x: [l.xNeg, l.xPos, l.xRubber, l.wayX1, l.plateHalf],
  });
}

// ---------------------------------------------------------------------------------------------

interface Built {
  root: THREE.Group;
  layout: Layout;
  cradle: THREE.Group;
  spindle: THREE.Group;
  chuckPlate: THREE.Group;
  spacer: THREE.Object3D;
  ellHousing: THREE.Group;
  rockRubber: { slider: THREE.Group; roller: THREE.Object3D; item: StackItem; restX: number } | null;
  pumpRubber: { slider: THREE.Group; roller: THREE.Object3D; item: StackItem; restZ: number } | null;
  saddle: THREE.Group;
  toolZ: THREE.Group;
  pen: THREE.Group;
  cutter: THREE.Group;
  penHolder: THREE.Group;
  cutterHolder: THREE.Group;
  leadscrew: THREE.Group;
  plunger: THREE.Group;
  needle: THREE.Object3D;
  spring: THREE.Mesh;
  springA: THREE.Vector3; // cradle-local anchor
  springB: THREE.Vector3; // machine-frame anchor
  rosetteMeshes: THREE.Mesh[];
  carrierEcc: THREE.Object3D;
  carrierPlain: THREE.Object3D;
}

export class MachineModel implements IMachineModel {
  readonly group = new THREE.Group();
  private mats: MachineMaterials = createMaterials();
  private built: Built | null = null;
  private key = '';
  private shapes = '';
  private rosetteCache = new Map<string, THREE.BufferGeometry>();
  private recipe: Recipe = defaultRecipe();
  private prepared: Prepared | null = null;
  private pose: Pose = {
    pass: 0,
    division: 0,
    slidePass: 0,
    spindleAngle: 0,
    rock: 0,
    pump: 0,
    slideRadius: 20,
    divisionAngle: 0,
  };
  private plateAngle = 0;

  // Persistent work disc (survives structure rebuilds).
  private disc = new THREE.Group();
  private discFace: THREE.Mesh;
  private discEdge: THREE.Mesh;
  private discBack: THREE.Mesh;
  private discCarrier = new THREE.Group();
  private discGeos: THREE.BufferGeometry[] = [];

  // Key light (shadow caster) shipped with the model so shadows fit the machine.
  readonly keyLight = new THREE.DirectionalLight('#fff4e6', 3.2);

  constructor() {
    this.group.name = 'RoseEngineMachine';
    const faceGeo = new THREE.CircleGeometry(0.5, 256); // uv = x/D + 0.5 once scaled by D
    const edgeGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 256, 1, true);
    edgeGeo.rotateX(Math.PI / 2);
    const backGeo = new THREE.CircleGeometry(0.5, 128);
    backGeo.rotateY(Math.PI);
    this.discGeos.push(faceGeo, edgeGeo, backGeo);
    this.discFace = new THREE.Mesh(faceGeo, this.mats.paper);
    this.discFace.name = 'workFace';
    this.discFace.receiveShadow = true;
    this.discEdge = new THREE.Mesh(edgeGeo, this.mats.discEdge);
    this.discEdge.castShadow = true;
    this.discEdge.receiveShadow = true;
    this.discBack = new THREE.Mesh(backGeo, this.mats.discEdge);
    this.discBack.castShadow = true;
    this.disc.name = 'workDisc';
    this.disc.add(this.discFace, this.discEdge, this.discBack, this.discCarrier);
    this.group.add(this.disc);

    this.keyLight.name = 'machineKeyLight';
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.bias = -0.0003;
    this.keyLight.shadow.normalBias = 0.8;
    this.keyLight.shadow.radius = 4;
    this.group.add(this.keyLight, this.keyLight.target);

    this.applyRecipe(this.recipe, true);
    this.setPose(this.pose);
  }

  // -------------------------------------------------------------------------------------------
  // IMachineModel
  // -------------------------------------------------------------------------------------------

  setRecipe(recipe: Recipe, prepared: Prepared): void {
    this.prepared = prepared;
    this.applyRecipe(recipe, false);
    this.setPose(this.pose);
  }

  setWorkMaterial(material: THREE.Material): void {
    this.discFace.material = material;
  }

  setPose(pose: Pose): void {
    this.pose = pose;
    const b = this.built;
    if (!b) return;
    const lay = b.layout;
    const L = lay.L;
    const H = lay.H;
    const rock = pose.rock;
    const pump = pose.pump;
    const theta = pose.spindleAngle;

    // Rocking headstock: rotate about the pivot so the spindle axis moves exactly -rock in X, and lift
    // the cradle by the tiny cosine drop so the axis stays at height H (matches the engine's pure shift).
    const a = Math.asin(Math.max(-0.5, Math.min(0.5, rock / L)));
    b.cradle.rotation.z = a;
    b.cradle.position.set(0, PIVOT_Y + L * (1 - Math.cos(a)), pump);
    // Keep the spindle's world orientation at exactly spindleAngle (cancel the cradle tilt).
    b.spindle.rotation.z = wrap(theta) - a;

    // Work disc: engine placement (spindle axis at origin, before the rock shift) moved onto our axis.
    const wp = this.placement(pose);
    const cx = wp.x - rock;
    const cy = H + wp.y;
    this.disc.position.set(cx, cy, pump);
    this.disc.rotation.set(0, 0, wp.rotation);

    // Chuck slide plate: points from the spindle axis toward the work centre (spindle frame).
    if (b.chuckPlate.visible) {
      const ox = cx + rock;
      const oy = cy - H;
      const ct = Math.cos(theta);
      const st = Math.sin(theta);
      const sx = ct * ox + st * oy;
      const sy = -st * ox + ct * oy;
      if (sx * sx + sy * sy > 0.0625) {
        let ang = Math.atan2(sy, sx);
        // The plate is symmetric: pick the orientation nearest the previous one.
        let d = wrapPi(ang - this.plateAngle);
        if (Math.abs(d) > Math.PI / 2) {
          ang += Math.PI;
          d = wrapPi(ang - this.plateAngle);
        }
        this.plateAngle = wrapPi(this.plateAngle + d);
      }
      b.chuckPlate.rotation.z = this.plateAngle;
    }

    // Tool on the cross-slide.
    b.saddle.position.x = pose.slideRadius;
    b.toolZ.position.z = pump;
    b.leadscrew.rotation.x = -((pose.slideRadius / LEAD_PITCH) % 1) * TAU;

    // Cams turn by their total phase (rosette.phase + pass program); geometry is built at phase 0.
    for (const rm of b.rosetteMeshes) {
      const item = rm.userData.item as StackItem;
      rm.rotation.z = (-this.phaseDeg(item, pose) * Math.PI) / 180;
    }
    // Rubbers ride their rosettes (world orientation of rosettes = theta; contact on +X => phi = -theta).
    if (b.rockRubber) {
      const rr = b.rockRubber;
      const ros = { ...rr.item.rosette, phase: this.phaseDeg(rr.item, pose) };
      const s = rollerDistance(ros, lay.R0, lay.rv, -theta);
      rr.slider.position.x = -rock + s - rr.restX;
      if (lay.rv > 0) rr.roller.rotation.z = -wrap(theta * (lay.R0 / lay.rv));
    }
    if (b.pumpRubber) {
      const pr = b.pumpRubber;
      const { rMid } = pumpTrackRadii(lay.R0);
      const ros = { ...pr.item.rosette, phase: this.phaseDeg(pr.item, pose) };
      const h = pumpRollerHeight(ros, rMid, PUMP_BALL, -theta);
      const zc = pump + pr.item.z - PUMP_BODY - h - PUMP_BALL;
      pr.slider.position.z = zc - pr.restZ;
    }

    // Dial indicator: plunger follows the front bearing boss; 1 mm per needle revolution.
    b.plunger.position.x = -rock;
    b.needle.rotation.z = -rock * TAU;

    // Spring between the cradle lug and the bed post.
    const A = b.springA;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const ax = A.x * ca - A.y * sa;
    const ay = PIVOT_Y + L * (1 - ca) + A.x * sa + A.y * ca;
    const B = b.springB;
    b.spring.position.set(ax, ay, A.z + pump);
    b.spring.rotation.set(0, 0, Math.atan2(B.y - ay, B.x - ax));
    b.spring.scale.x = Math.hypot(B.x - ax, B.y - ay) / (b.spring.userData.restLen as number);
  }

  getToolTip(target: THREE.Vector3): THREE.Vector3 {
    const H = this.built ? this.built.layout.H : 0;
    target.set(this.pose.slideRadius, H, this.pose.pump);
    this.group.updateWorldMatrix(true, false);
    return target.applyMatrix4(this.group.matrixWorld);
  }

  /**
   * Camera presets in world space. Framing assumes a perspective camera with a vertical FOV of about
   * 35 degrees and a landscape aspect.
   */
  getCameraPreset(preset: CameraPreset): { position: THREE.Vector3; target: THREE.Vector3 } {
    const lay = this.built!.layout;
    const H = lay.H;
    let target: THREE.Vector3;
    let dir: THREE.Vector3;
    let dist: number;
    if (preset === 'rosette') {
      const zEnd = lay.stack.length ? lay.zStackEnd : Z_REAR_STD[0] - 20;
      const zMid = (Math.min(Z_STACK0, zEnd + 20) + zEnd) / 2;
      target = new THREE.Vector3(lay.R0 * 0.45, H - 6, zMid);
      dir = new THREE.Vector3(0.66, 0.42, -0.62);
      dist = lay.R0 * 2.6 + 170;
    } else if (preset === 'tool') {
      // From the upper left-front, so the holder (on +X) never hides the nib or the work.
      target = new THREE.Vector3(this.pose.slideRadius - 10, H - 4, this.pose.pump + 8);
      dir = new THREE.Vector3(-0.46, 0.4, 0.79);
      dist = Math.max(170, lay.D * 1.25);
    } else {
      const x0 = lay.xNeg - 44;
      const x1 = Math.max(lay.xPos, lay.wayX1 + 40) + 44;
      const z0 = lay.zBack - 44;
      const z1 = Z_BED_FRONT + 56;
      target = new THREE.Vector3((x0 + x1) / 2, H * 0.6, (z0 + z1) / 2 + 10);
      const r = 0.5 * Math.hypot(x1 - x0, z1 - z0, H + 40);
      dir = new THREE.Vector3(0.64, 0.48, 0.6);
      dist = r * 2.25;
    }
    const position = target.clone().addScaledVector(dir.normalize(), dist);
    this.group.updateWorldMatrix(true, false);
    position.applyMatrix4(this.group.matrixWorld);
    target.applyMatrix4(this.group.matrixWorld);
    return { position, target };
  }

  dispose(): void {
    if (this.built) this.disposeStructure(this.built);
    this.built = null;
    for (const g of this.rosetteCache.values()) g.dispose();
    this.rosetteCache.clear();
    for (const g of this.discGeos) g.dispose();
    this.disposeGroup(this.discCarrier);
    this.keyLight.dispose();
    this.mats.dispose();
    this.group.clear();
  }

  // -------------------------------------------------------------------------------------------
  // Extras (not part of IMachineModel; used by the dev harness and for checks)
  // -------------------------------------------------------------------------------------------

  /** World position of a work-frame point (x, y) on the disc face, given the current pose. */
  workToWorld(x: number, y: number, target: THREE.Vector3): THREE.Vector3 {
    this.disc.updateWorldMatrix(true, false);
    return target.set(x, y, 0).applyMatrix4(this.disc.matrixWorld);
  }

  /** Rubber slider offsets from rest (mm): how far each rubber had to move to stay in contact. */
  debugRubbers(): { rock: number | null; pump: number | null } {
    const b = this.built;
    return {
      rock: b?.rockRubber ? b.rockRubber.slider.position.x : null,
      pump: b?.pumpRubber ? b.pumpRubber.slider.position.z : null,
    };
  }

  /** The work-frame tool point used for the current pose (engine toolPoint). */
  currentWorkPoint(): { x: number; y: number; z: number } {
    return this.workPoint(this.pose);
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  private workPoint(pose: Pose): { x: number; y: number; z: number } {
    if (this.prepared) return toolPoint(this.prepared, pose);
    // No prepared recipe yet: plain spindle, no chucks.
    const rho = pose.slideRadius + pose.rock;
    const t = pose.spindleAngle + pose.divisionAngle;
    return { x: rho * Math.cos(t), y: -rho * Math.sin(t), z: pose.pump };
  }

  private placement(pose: Pose): { rotation: number; x: number; y: number } {
    if (this.prepared) return workPlacement(this.prepared, pose);
    return { rotation: wrap(pose.spindleAngle + pose.divisionAngle), x: 0, y: 0 };
  }

  private phaseDeg(item: StackItem, pose: Pose): number {
    if (this.prepared && item.index >= 0) return rosettePhaseDeg(this.prepared, item.index, pose);
    return item.rosette.phase;
  }

  private applyRecipe(recipe: Recipe, force: boolean): void {
    this.recipe = recipe;
    const layout = computeLayout(recipe);
    const key = structureKey(layout);
    const shapeKeys = layout.stack.map((s) => rosetteShapeKey(s.rosette, layout.R0)).join(';');
    if (force || key !== this.key || !this.built) {
      if (this.built) this.disposeStructure(this.built);
      this.built = this.buildStructure(layout);
      this.group.add(this.built.root);
      this.key = key;
      this.shapes = shapeKeys;
      this.pruneRosetteCache(layout);
      this.buildCarrier(layout);
      this.placeLight(layout);
    } else {
      const b = this.built;
      if (shapeKeys !== this.shapes) {
        // Same layout, new cam shapes: swap rosette geometry only.
        b.rosetteMeshes.forEach((rm, i) => {
          rm.geometry = this.rosetteGeometry(layout.stack[i], layout.R0);
        });
        this.shapes = shapeKeys;
        this.pruneRosetteCache(layout);
      }
      // Point everything at the new recipe's rosette objects (same stack order).
      b.layout = layout;
      b.rosetteMeshes.forEach((rm, i) => {
        rm.userData.item = layout.stack[i];
      });
      if (b.rockRubber) b.rockRubber.item = layout.stack[layout.activeRock];
      if (b.pumpRubber) b.pumpRubber.item = layout.stack[layout.activePump];
    }
    const b = this.built;
    // Work disc size.
    const D = recipe.machine.workDiameter;
    this.discFace.scale.set(D, D, 1);
    this.discEdge.scale.set(D, D, DISC_T);
    this.discEdge.position.z = -DISC_T / 2;
    this.discBack.scale.set(D, D, 1);
    this.discBack.position.z = -DISC_T;
    // Chucks.
    const ecc = recipe.eccentric.enabled;
    const ell = recipe.elliptical.enabled;
    b.chuckPlate.visible = ecc || ell;
    b.spacer.visible = !(ecc || ell);
    b.ellHousing.visible = ell;
    b.carrierEcc.visible = ecc;
    b.carrierPlain.visible = !ecc;
    // Tool by mode.
    const ink = recipe.mode === 'ink';
    b.pen.visible = ink;
    b.penHolder.visible = ink;
    b.cutter.visible = !ink;
    b.cutterHolder.visible = !ink;
    this.mats.penBand.color.set(recipe.ink.palette[0] ?? '#1d2a5c');
  }

  /** Dispose cached rosette geometry the layout no longer uses. */
  private pruneRosetteCache(layout: Layout): void {
    const used = new Set(layout.stack.map((s) => rosetteShapeKey(s.rosette, layout.R0)));
    for (const [k, g] of this.rosetteCache) {
      if (!used.has(k)) {
        g.dispose();
        this.rosetteCache.delete(k);
      }
    }
  }

  private placeLight(l: Layout): void {
    const cx = (l.xNeg + l.xPos) / 2;
    const cz = (l.zBack + Z_BED_FRONT) / 2;
    const ext = Math.max(l.xPos - l.xNeg, Z_BED_FRONT - l.zBack, l.H) * 0.75 + 40;
    this.keyLight.target.position.set(cx, l.H * 0.5, cz);
    this.keyLight.position.set(cx - 360, l.H * 0.5 + 900, cz + 380);
    const cam = this.keyLight.shadow.camera;
    cam.left = -ext;
    cam.right = ext;
    cam.top = ext;
    cam.bottom = -ext;
    cam.near = 100;
    cam.far = 2400;
    cam.updateProjectionMatrix();
  }

  private disposeGroup(g: THREE.Object3D): void {
    const cached = new Set(this.rosetteCache.values());
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry && !cached.has(m.geometry)) m.geometry.dispose();
    });
    g.clear();
  }

  private disposeStructure(b: Built): void {
    this.group.remove(b.root);
    this.disposeGroup(b.root);
  }

  private rosetteGeometry(item: StackItem, R0: number): THREE.BufferGeometry {
    const k = rosetteShapeKey(item.rosette, R0);
    let g = this.rosetteCache.get(k);
    if (!g) {
      const r0 = { ...item.rosette, phase: 0 };
      g = r0.axis === 'rock' ? buildRockRosette(r0, R0) : buildPumpTrack(r0, R0);
      this.rosetteCache.set(k, g);
    }
    return g;
  }

  /** Work holder behind the disc (child of the disc, turns with it). */
  private buildCarrier(l: Layout): void {
    this.disposeGroup(this.discCarrier);
    const m = this.mats;
    const rc = l.rc;
    // Brass dividing wheel with index holes (eccentric chuck).
    const s = new THREE.Shape();
    s.absarc(0, 0, rc, 0, TAU, false);
    const holes = 36;
    for (let i = 0; i < holes; i++) {
      const a = (i / holes) * TAU;
      const h = new THREE.Path();
      h.absarc((rc - 3.2) * Math.cos(a), (rc - 3.2) * Math.sin(a), 0.9, 0, TAU, true);
      s.holes.push(h);
    }
    const wheel = new THREE.ExtrudeGeometry(s, {
      depth: 6.4,
      bevelEnabled: true,
      bevelSize: 0.6,
      bevelThickness: 0.6,
      bevelSegments: 2,
      curveSegments: 96,
    });
    wheel.translate(0, 0, -11.4);
    const ecc = new THREE.Group();
    ecc.add(mesh(wheel, m.brass));
    ecc.add(mesh(discZ(rc * 0.55, -12.5, -11.6, 0.4), m.steelGround));
    const plain = new THREE.Group();
    plain.add(mesh(discZ(rc * 0.78, -12, -4, 1), m.steelGround));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI / 4;
      const bolt = mesh(hexZ(4.2, -13.4, -12), m.steelDark);
      bolt.position.set(rc * 0.55 * Math.cos(a), rc * 0.55 * Math.sin(a), 0);
      plain.add(bolt);
    }
    this.discCarrier.add(ecc, plain);
    if (this.built) {
      this.built.carrierEcc = ecc;
      this.built.carrierPlain = plain;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Structure
  // -------------------------------------------------------------------------------------------

  private buildStructure(l: Layout): Built {
    const m = this.mats;
    const root = new THREE.Group();
    root.name = 'structure';
    const H = l.H;
    const L = l.L;
    const zBack = l.zBack;

    // --- Bench plinth (mahogany) -----------------------------------------------------------
    const bx0 = l.xNeg - 44;
    const bx1 = Math.max(l.xPos, l.wayX1 + 40) + 44;
    const bz0 = zBack - 44;
    const bz1 = Z_BED_FRONT + 56;
    const bench = mesh(rboxSpan(bx0, bx1, 0, BENCH_T, bz0, bz1, 5), m.wood, false, true);
    root.add(bench);
    // Ebonised edge moulding.
    root.add(mesh(rboxSpan(bx0 + 10, bx1 - 10, BENCH_T - 0.5, BENCH_T + 1.5, bz0 + 10, bz1 - 10, 0.9), m.woodHandle, false, true));

    // --- Bed casting -------------------------------------------------------------------------
    const y0 = BENCH_T + FOOT_H;
    root.add(mesh(rboxSpan(l.xNeg, l.xPos, y0, y0 + 14, zBack, Z_BED_FRONT, 4), m.iron));
    root.add(mesh(rboxSpan(l.xNeg + 9, l.xPos - 9, y0 + 10, BED_TOP, zBack + 9, Z_BED_FRONT - 9, 6), m.iron));
    // Feet.
    for (const fx of [l.xNeg + 26, l.xPos - 26]) {
      for (const fz of [zBack + 26, Z_BED_FRONT - 26]) {
        const f = mesh(latheZ([[0, 0], [17, 0], [17, 2], [13, 4], [13, FOOT_H + 2], [0, FOOT_H + 2]], 32), m.steelDark);
        f.rotation.x = -Math.PI / 2; // lathe z -> +y
        f.position.set(fx, BENCH_T, fz);
        root.add(f);
      }
    }
    // Nameplate on the front of the bed.
    const plate = mesh(rboxSpan(-70, 70, 0, 34, 0, 2, 0.8), m.plate, false, false);
    plate.position.set((l.xNeg + l.xPos) / 2, y0 + 16, Z_BED_FRONT - 9);
    root.add(plate);
    for (const sx of [-63, 63]) {
      const scr = mesh(latheZ([[0, 0], [2.2, 0], [2.2, 0.6], [1.4, 1.4], [0, 1.6]], 16), m.brass);
      scr.position.set(plate.position.x + sx, y0 + 33, Z_BED_FRONT - 7);
      root.add(scr);
    }

    // --- Pivot: shaft + pillow blocks (fixed) ------------------------------------------------
    const pz0 = Z_REAR_STD[0] - 22;
    const pz1 = Z_FRONT_STD[1] + 22;
    const pivot = mesh(cylZ(7.5, pz0 - 4, pz1 + 4, 32), m.steel);
    pivot.position.set(0, PIVOT_Y, 0);
    root.add(pivot);
    for (const [za, zb] of [
      [pz0, pz0 + 16],
      [pz1 - 16, pz1],
    ] as [number, number][]) {
      root.add(mesh(rboxSpan(-34, 34, BED_TOP, BED_TOP + 12, za - 2, zb + 2, 3), m.iron));
      root.add(mesh(rboxSpan(-22, 22, BED_TOP + 8, PIVOT_Y + 4, za, zb, 4), m.iron));
      const cap = mesh(latheZ([[0, za], [17, za], [18, za + 1], [18, zb - 1], [17, zb], [0, zb]], 40), m.brass);
      cap.position.set(0, PIVOT_Y, 0);
      root.add(cap);
      for (const sx of [-26, 26]) {
        const bolt = mesh(hexY(7, BED_TOP + 12, BED_TOP + 16), m.steelDark);
        bolt.position.set(sx, 0, (za + zb) / 2);
        root.add(bolt);
      }
      for (const zz of [za - 4.5, zb + 4.5]) {
        const nut = mesh(hexZ(13, zz - 2.5, zz + 2.5), m.steelDark);
        nut.position.set(0, PIVOT_Y, 0);
        if ((zz < za && za === pz0) || (zz > zb && zb === pz1)) root.add(nut);
        else nut.geometry.dispose();
      }
    }

    // --- Rocking cradle ----------------------------------------------------------------------
    const cradle = new THREE.Group();
    cradle.name = 'cradle';
    root.add(cradle);
    for (const [z0, z1] of [Z_FRONT_STD, Z_REAR_STD]) {
      cradle.add(mesh(standardGeometry(L, STD_RT, STD_RB, 16.5, 8, z0, z1), m.iron));
      // Brass bearing bush.
      const bush = mesh(ringZ(SPINDLE_R + 0.3, 21, z0 - 3, z1 + 3, 1), m.brass);
      bush.position.y = L;
      cradle.add(bush);
      // Pivot boss bush.
      const pb = mesh(ringZ(7.6, 13, z0 - 2, z1 + 2, 0.8), m.brass);
      cradle.add(pb);
      // Oil cup on top of the bearing.
      const cup = mesh(
        latheZ([[0, 0], [3, 0], [3, 3], [5.5, 4], [5.5, 9], [4.5, 10], [0, 10.5]], 24),
        m.brass,
      );
      cup.rotation.x = -Math.PI / 2;
      cup.position.set(0, L + STD_RT - 2, (z0 + z1) / 2);
      cradle.add(cup);
    }
    // Tie bars between the standards.
    const halfW = (y: number) => STD_RB + ((STD_RT - STD_RB) * y) / L;
    for (const ty of [0.5 * L, 0.2 * L]) {
      const tx = halfW(ty) - 7;
      for (const sx of [-tx, tx]) {
        const bar = mesh(cylZ(4.5, Z_REAR_STD[1] - 2, Z_FRONT_STD[0] + 2, 20), m.steel);
        bar.position.set(sx, ty, 0);
        cradle.add(bar);
      }
    }
    // Spring lug on the rear standard (+X side).
    const lugY = 0.38 * L;
    const lugX = halfW(lugY);
    const zLug = (Z_REAR_STD[0] + Z_REAR_STD[1]) / 2;
    cradle.add(mesh(rboxSpan(lugX - 6, lugX + 10, lugY - 6, lugY + 6, zLug - 5, zLug + 5, 2), m.iron));
    const springA = new THREE.Vector3(lugX + 10, lugY, zLug);

    // Elliptical chuck housing (non-rotating, carried by the front standard).
    const ellHousing = new THREE.Group();
    ellHousing.add(mesh(ringZ(40, 51, -46, -28, 1.2), m.brass));
    const ring = mesh(ringZ(39, 41.5, -45, -29, 0.4), m.steelDark);
    ellHousing.add(ring);
    ellHousing.add(mesh(rboxSpan(-11, 11, L - 66, L - 48, Z_FRONT_STD[1] - 4, -34, 3), m.iron));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      const sc = mesh(cylZ(1.6, -28, -26.8, 12), m.steelDark);
      sc.position.set(46 * Math.cos(a), L + 46 * Math.sin(a), 0);
      ellHousing.add(sc);
    }
    // Ring parts are centred on the spindle: lift them.
    ellHousing.children[0].position.y = L;
    ring.position.y = L;
    cradle.add(ellHousing);

    // --- Spindle (turns) ----------------------------------------------------------------------
    const spindle = new THREE.Group();
    spindle.name = 'spindle';
    spindle.position.y = L;
    cradle.add(spindle);
    spindle.add(mesh(cylZ(SPINDLE_R, l.zTail, Z_FRONT_STD[1] + 2, 40), m.steel));
    // Nose: shoulder, thread, collar.
    const nose: [number, number][] = [
      [SPINDLE_R, Z_FRONT_STD[1] + 2],
      [16, Z_FRONT_STD[1] + 3],
      [16, -50],
      [13.2, -49.5],
    ];
    for (let zt = -49; zt < -37; zt += 1.25) {
      nose.push([14.2, zt + 0.3], [13.2, zt + 0.9]);
    }
    nose.push([13.2, -36.5], [17, -36], [17, -30.5], [0, -30.5]);
    spindle.add(mesh(latheZ(nose, 48), m.steel));
    // Faceplate.
    spindle.add(mesh(discZ(34, -30.5, -22, 1.4, 96), m.steelGround));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      const bolt = mesh(latheZ([[0, -22], [3, -22], [3, -20.6], [2.6, -20.2], [0, -20.2]], 16), m.steelDark);
      bolt.position.set(28.5 * Math.cos(a), 28.5 * Math.sin(a), 0);
      spindle.add(bolt);
    }
    // Spacer (no chuck): carries the work holder.
    const spacer = mesh(latheZ([[0, -22], [l.rc * 0.62, -22], [l.rc * 0.62, -13], [l.rc * 0.6, -12], [0, -12]], 64), m.steel);
    spindle.add(spacer);
    // Chuck slide plate (eccentric / elliptical): oriented every frame toward the work centre.
    const chuckPlate = new THREE.Group();
    const ph = l.plateHalf;
    const pw = Math.max(16, l.rc * 0.7);
    chuckPlate.add(mesh(roundedPlateZ(-ph, ph, -pw, pw, 8, -22, -14, 0.8), m.steelGround));
    for (const sy of [-pw + 2.5, pw - 2.5]) {
      chuckPlate.add(mesh(rboxSpan(-ph + 4, ph - 4, sy - 2.5, sy + 2.5, -14.5, -12, 0.6), m.brass));
    }
    // Adjusting screw head at the +X end.
    const adj = mesh(latheZ([[0, 0], [4, 0], [4, 6], [3, 7], [0, 7]], 20), m.steel);
    adj.rotation.y = Math.PI / 2;
    adj.position.set(ph, 0, -18);
    chuckPlate.add(adj);
    const adjKnob = mesh(cylX(5.5, ph + 6, ph + 12, 18), m.brass);
    adjKnob.position.z = -18;
    chuckPlate.add(adjKnob);
    spindle.add(chuckPlate);

    // Rosette stack.
    const rosetteMeshes: THREE.Mesh[] = [];
    let first = true;
    for (const item of l.stack) {
      const g = this.rosetteGeometry(item, l.R0);
      if (item.rosette.axis === 'rock') {
        const rm = mesh(g, m.brass);
        rm.position.z = item.z;
        rm.userData.item = item;
        spindle.add(rm);
        rosetteMeshes.push(rm);
        const hub = mesh(ringZ(SPINDLE_R + 0.2, 22, item.z - ROCK_THICK / 2 - 1.5, item.z + ROCK_THICK / 2 + 1.5, 0.8), m.brassSatin);
        spindle.add(hub);
        // Spacer collar behind.
        const col = mesh(ringZ(SPINDLE_R + 0.2, 17, item.z - ROCK_THICK / 2 - 6, item.z - ROCK_THICK / 2 - 1.5, 0.6), m.steel);
        spindle.add(col);
      } else {
        const body = mesh(discZ(l.R0 * 0.97, item.z - PUMP_BODY, item.z, 1.2, 128), m.brassSatin);
        spindle.add(body);
        const track = mesh(g, m.brass);
        track.position.z = item.z;
        track.userData.item = item;
        spindle.add(track);
        rosetteMeshes.push(track);
        const hub = mesh(ringZ(SPINDLE_R + 0.2, 20, item.z - PUMP_BODY - 3, item.z + 2, 0.8), m.brassSatin);
        spindle.add(hub);
        const col = mesh(ringZ(SPINDLE_R + 0.2, 17, item.z - PUMP_BODY - item.hMax - 6, item.z - PUMP_BODY - 3, 0.6), m.steel);
        spindle.add(col);
      }
      if (first) {
        // Lock nut in front of the stack.
        const nut = mesh(hexZ(30, Z_STACK0 + 1, Z_STACK0 + 9), m.steelDark);
        spindle.add(nut);
        first = false;
      }
    }
    // Tail lock nut + handwheel.
    spindle.add(mesh(hexZ(30, l.zStackEnd - 8, l.zStackEnd), m.steelDark));
    {
      const hw = handwheelGeometries(44, 4, 14, 22, 5);
      const g = new THREE.Group();
      g.add(mesh(hw.rim, m.brass), mesh(hw.spokes, m.brass), mesh(hw.hub, m.brassSatin));
      // Crank handle at the rim, pointing back (-Z).
      const handle = mesh(
        latheZ([[0, 0], [4, 0], [4.5, -3], [6.2, -14], [5.2, -26], [6, -32], [0, -34]], 24),
        m.woodHandle,
      );
      handle.position.set(0, 40, -3);
      g.add(handle);
      const pin = mesh(cylZ(2.2, -4, 2, 12), m.steel);
      pin.position.set(0, 40, 0);
      g.add(pin);
      g.position.z = l.zHW;
      spindle.add(g);
    }

    // --- Rubbers -----------------------------------------------------------------------------
    let rockRubber: Built['rockRubber'] = null;
    if (l.activeRock >= 0) {
      const item = l.stack[l.activeRock];
      const zA = item.z;
      const xs = l.xRubber;
      const rv = l.rv; // contact radius: 0 = knife edge
      const rs = Math.max(rv, 1.5); // size of the fork around it
      const restX = l.R0 + rv;
      // Stand: foot, column, clamp head (fixed).
      root.add(mesh(rboxSpan(xs - 26, xs + 26, BED_TOP, BED_TOP + 12, zA - 22, zA + 22, 3), m.iron));
      root.add(mesh(cylY(9, BED_TOP + 10, H - 12, 32), m.steel).translateX(xs).translateZ(zA));
      root.add(mesh(rboxSpan(xs - 13, xs + 13, H - 14, H + 13, zA - 12, zA + 12, 3), m.iron));
      const knob = mesh(knobY(7, 10), m.brass);
      knob.position.set(xs, H + 13, zA);
      root.add(knob);
      // Slider: rod + fork + follower (moves along X to keep contact).
      const slider = new THREE.Group();
      const roller = new THREE.Group();
      roller.position.set(restX, H, zA);
      if (rv > 0) {
        slider.add(mesh(cylX(5, restX + rs + 6, xs + 22, 24), m.steel).translateY(H).translateZ(zA));
        const forkW = ROCK_THICK / 2 + 3.2;
        const fx0 = restX - rs * 0.3;
        slider.add(mesh(rboxSpan(fx0, restX + rs + 10, H - rs - 3.5, H + rs + 3.5, zA + forkW - 2.4, zA + forkW, 1), m.brass));
        slider.add(mesh(rboxSpan(fx0, restX + rs + 10, H - rs - 3.5, H + rs + 3.5, zA - forkW, zA - forkW + 2.4, 1), m.brass));
        slider.add(mesh(rboxSpan(restX + rs + 4, restX + rs + 12, H - rs - 3.5, H + rs + 3.5, zA - forkW, zA + forkW, 1), m.brass));
        roller.add(mesh(ringZ(Math.min(0.9, rv * 0.5), rv, -ROCK_THICK / 2 - 1, ROCK_THICK / 2 + 1, Math.min(0.5, rv * 0.2), 48), m.steel));
        // Index flat on the roller so its spin reads.
        roller.add(mesh(rboxSpan(-0.25, 0.25, rv * 0.35, rv * 0.9, ROCK_THICK / 2 + 1, ROCK_THICK / 2 + 1.3, 0.1), m.steelDark));
        const axle = mesh(cylZ(Math.min(0.9, rv * 0.5), zA - forkW - 0.6, zA + forkW + 0.6, 12), m.steelDark);
        axle.position.set(restX, H, 0);
        slider.add(axle);
      } else {
        // Knife-edge rubber: a hardened wedge whose edge rides the profile exactly.
        const w = new THREE.Shape();
        w.moveTo(0, 0);
        w.lineTo(9, -4.5);
        w.lineTo(16, -4.5);
        w.lineTo(16, 4.5);
        w.lineTo(9, 4.5);
        w.lineTo(0, 0);
        const wg = new THREE.ExtrudeGeometry(w, { depth: ROCK_THICK + 2, bevelEnabled: false });
        wg.translate(0, 0, -(ROCK_THICK + 2) / 2);
        roller.add(mesh(wg, m.steel));
        slider.add(mesh(rboxSpan(restX + 14, restX + 26, H - 7, H + 7, zA - 7, zA + 7, 1.5), m.brass));
        slider.add(mesh(cylX(5, restX + 26, xs + 22, 24), m.steel).translateY(H).translateZ(zA));
      }
      slider.add(roller);
      root.add(slider);
      rockRubber = { slider, roller, item, restX };
    }
    let pumpRubber: Built['pumpRubber'] = null;
    if (l.activePump >= 0) {
      // Ball-ended follower (small radius: the engine reads the raw face profile).
      const item = l.stack[l.activePump];
      const { rMid } = pumpTrackRadii(l.R0);
      const restZ = item.z - PUMP_BODY - pumpTrackBase(item.rosette) - PUMP_BALL;
      const zs = l.zPumpStand;
      const xs = rMid;
      root.add(mesh(rboxSpan(xs - 22, xs + 22, BED_TOP, BED_TOP + 12, zs - 22, zs + 22, 3), m.iron));
      root.add(mesh(cylY(9, BED_TOP + 10, H - 12, 32), m.steel).translateX(xs).translateZ(zs));
      root.add(mesh(rboxSpan(xs - 12, xs + 12, H - 14, H + 13, zs - 13, zs + 13, 3), m.iron));
      const knob = mesh(knobY(7, 10), m.brass);
      knob.position.set(xs, H + 13, zs);
      root.add(knob);
      const slider = new THREE.Group();
      slider.add(mesh(cylZ(5, zs - 18, restZ - 16, 24), m.steel).translateX(xs).translateY(H));
      const tipG = latheZ([[5, restZ - 16], [5.6, restZ - 15], [5.6, restZ - 9], [3, restZ - 6], [1.6, restZ - 2], [0, restZ - 1]], 32);
      slider.add(mesh(tipG, m.brass).translateX(xs).translateY(H));
      const roller = new THREE.Group();
      roller.position.set(xs, H, restZ);
      roller.add(mesh(new THREE.SphereGeometry(PUMP_BALL, 24, 16), m.steel));
      slider.add(roller);
      root.add(slider);
      pumpRubber = { slider, roller, item, restZ };
    }

    // --- Return spring (cradle lug -> bed post) -----------------------------------------------
    const postX = springA.x + 74;
    const springB = new THREE.Vector3(postX - 8, PIVOT_Y + lugY, zLug);
    root.add(mesh(rboxSpan(postX - 14, postX + 14, BED_TOP, BED_TOP + 10, zLug - 14, zLug + 14, 3), m.iron));
    root.add(mesh(cylY(6, BED_TOP + 8, PIVOT_Y + lugY + 8, 24), m.steel).translateX(postX).translateZ(zLug));
    root.add(mesh(rboxSpan(postX - 9, postX + 2, PIVOT_Y + lugY - 5, PIVOT_Y + lugY + 5, zLug - 5, zLug + 5, 1.5), m.brass));
    const springLen = springB.x - springA.x;
    const spring = mesh(springGeometry(5, 1.1, 13, springLen), m.steel);
    spring.userData.restLen = springLen;
    root.add(spring);

    // --- Dial indicator on the front bearing boss --------------------------------------------
    const dialX = STD_RT + 40;
    const dialR = 22;
    const dial = new THREE.Group();
    dial.position.set(dialX, H, DIAL_Z);
    dial.add(mesh(latheZ([[0, -7], [dialR - 1, -7], [dialR, -6], [dialR, 5], [0, 5]], 64), m.steel));
    dial.add(mesh(ringZ(dialR - 3, dialR + 1.2, 4, 8, 0.8, 64), m.steel));
    const face = new THREE.Mesh(new THREE.CircleGeometry(dialR - 2.6, 64), m.dialFace);
    face.position.z = 5.4;
    dial.add(face);
    const needle = new THREE.Group();
    needle.position.z = 6.2;
    needle.add(mesh(rboxSpan(-0.7, 0.7, -4, dialR - 5, -0.3, 0.3, 0.2), m.needle, false));
    needle.add(mesh(cylZ(1.8, -0.4, 0.8, 16), m.brass, false));
    dial.add(needle);
    const glass = new THREE.Mesh(new THREE.CircleGeometry(dialR - 2.8, 48), m.glass);
    glass.position.z = 7.6;
    dial.add(glass);
    // Stem toward the boss, lug at the back, top cap.
    dial.add(mesh(cylX(3.6, -dialR - 12, -dialR + 1, 20), m.steel));
    dial.add(mesh(rboxSpan(-5, 5, -5, 5, -16, -6, 1.5), m.steel));
    dial.add(mesh(cylY(3.2, dialR - 1, dialR + 4, 16), m.steel));
    root.add(dial);
    const plunger = new THREE.Group();
    plunger.add(mesh(cylX(1.6, STD_RT + 1.2, dialX - dialR - 10, 12), m.steel).translateY(H).translateZ(DIAL_Z));
    const ball = mesh(new THREE.SphereGeometry(1.8, 16, 12), m.steelDark);
    ball.position.set(STD_RT + 1.8, H, DIAL_Z);
    plunger.add(ball);
    root.add(plunger);
    // Magnetic base + post.
    const postZ = DIAL_Z - 24;
    root.add(mesh(rboxSpan(dialX - 18, dialX + 18, BED_TOP, BED_TOP + 26, postZ - 15, postZ + 15, 3), m.steelDark));
    root.add(mesh(rboxSpan(dialX - 19, dialX + 19, BED_TOP + 9, BED_TOP + 17, postZ - 16, postZ + 16, 1), m.steelGround));
    root.add(mesh(cylY(4.5, BED_TOP + 26, H + 4, 20), m.steel).translateX(dialX).translateZ(postZ));
    root.add(mesh(rboxSpan(dialX - 6, dialX + 6, H - 6, H + 6, postZ - 7, DIAL_Z - 15, 2), m.steel));

    // --- Slide rest ----------------------------------------------------------------------------
    const [sz0, sz1] = Z_SLIDE_REST;
    // Waisted cast pedestal (profile in XY, extruded along Z).
    {
      const xc = 40;
      const bw = 70;
      const ww = 34;
      const tw = Math.min(110, (l.wayX1 - l.wayX0) / 2 - 6);
      const yb = BED_TOP + 10;
      const yt = H - 64;
      const ym = yb + (yt - yb) * 0.55;
      const ps = new THREE.Shape();
      ps.moveTo(xc - bw, yb);
      ps.lineTo(xc + bw, yb);
      ps.quadraticCurveTo(xc + ww, yb + 10, xc + ww, ym);
      ps.quadraticCurveTo(xc + ww, yt - 6, xc + tw, yt);
      ps.lineTo(xc - tw, yt);
      ps.quadraticCurveTo(xc - ww, yt - 6, xc - ww, ym);
      ps.quadraticCurveTo(xc - ww, yb + 10, xc - bw, yb);
      const pg = new THREE.ExtrudeGeometry(ps, { depth: sz1 - sz0 - 6, bevelEnabled: true, bevelSize: 3, bevelThickness: 3, bevelSegments: 3, curveSegments: 24 });
      pg.translate(0, 0, sz0 + 3);
      root.add(mesh(pg, m.iron));
      root.add(mesh(rboxSpan(xc - bw - 12, xc + bw + 12, BED_TOP, BED_TOP + 12, sz0 - 12, sz1 + 12, 3), m.iron));
      for (const bx of [xc - bw - 4, xc + bw + 4]) {
        for (const bz of [sz0 - 5, sz1 + 5]) {
          const bolt = mesh(hexY(9, BED_TOP + 12, BED_TOP + 17), m.steelDark);
          bolt.position.set(bx, 0, bz);
          root.add(bolt);
        }
      }
      root.add(mesh(rboxSpan(l.wayX0 + 4, l.wayX1 - 4, yt - 2, H - 52, sz0 - 2, sz1 + 2, 3), m.iron));
    }
    // Way (ground steel) + dovetail gibs.
    root.add(mesh(rboxSpan(l.wayX0, l.wayX1, H - 53, H - 41, sz0 + 3, sz1 - 3, 1.2), m.steelGround));
    for (const gz of [sz0 + 2, sz1 - 2]) {
      root.add(mesh(rboxSpan(l.wayX0 + 2, l.wayX1 - 2, H - 50, H - 41, gz - 2.2, gz + 2.2, 0.6), m.steelDark));
    }
    // Leadscrew in front, with end brackets and handwheel.
    const leadZ = sz1 + 10;
    const leadY = H - 48;
    for (const bxp of [l.wayX0 + 6, l.wayX1 - 4]) {
      root.add(mesh(rboxSpan(bxp - 6, bxp + 6, H - 60, H - 38, sz1 - 4, leadZ + 7, 2), m.iron));
    }
    const leadscrew = new THREE.Group();
    leadscrew.position.set(0, leadY, leadZ);
    {
      const thread: [number, number][] = [[0, l.wayX0]];
      for (let x = l.wayX0; x < l.wayX1 + 8; x += LEAD_PITCH) {
        thread.push([3.6, x + 0.2], [4.4, x + LEAD_PITCH / 2], [3.6, x + LEAD_PITCH - 0.2]);
      }
      thread.push([0, l.wayX1 + 8]);
      const tg = latheZ(thread, 20);
      tg.rotateY(Math.PI / 2); // z -> x
      leadscrew.add(mesh(tg, m.steel));
      leadscrew.add(mesh(cylX(4.5, l.wayX1 + 8, l.wayX1 + 30, 20), m.steel));
      // Micrometer collar.
      leadscrew.add(mesh(cylX(11, l.wayX1 + 10, l.wayX1 + 20, 48), m.steelGround));
      const hw = handwheelGeometries(30, 3, 8, 12, 3);
      const wg = new THREE.Group();
      wg.add(mesh(hw.rim, m.brass), mesh(hw.spokes, m.brass), mesh(hw.hub, m.brassSatin));
      const handle = mesh(latheZ([[0, 0], [3, 0], [4.4, 6], [3.8, 16], [4.4, 20], [0, 21]], 20), m.woodHandle);
      handle.position.set(0, 26, 3);
      wg.add(handle);
      wg.rotation.y = Math.PI / 2;
      wg.position.x = l.wayX1 + 26;
      leadscrew.add(wg);
    }
    root.add(leadscrew);

    // Saddle (moves with slideRadius) carrying the tool holders.
    const saddle = new THREE.Group();
    saddle.name = 'saddle';
    saddle.add(mesh(rboxSpan(-30, 30, H - 41, H - 27, sz0 - 2, sz1 + 2, 2), m.steelGround));
    saddle.add(mesh(rboxSpan(-10, 10, H - 54, H - 39, sz1 - 2, leadZ + 6, 1.5), m.steelGround));
    for (const sx of [-21, 21]) {
      const gs = mesh(hexZ(5, sz1 + 2, sz1 + 5), m.steelDark);
      gs.position.set(sx, H - 34, 0);
      saddle.add(gs);
    }
    // Pen holder: block with a brass collar and clamp knobs.
    const penHolder = new THREE.Group();
    penHolder.add(mesh(rboxSpan(-14, 14, H - 28, H - 9, 40, 98, 2.5), m.steelGround));
    penHolder.add(mesh(rboxSpan(-11, 11, H - 9, H + 11, 44, 94, 4), m.brass));
    const collar = mesh(ringZ(6.2, 10.5, 36, 44, 1), m.brass);
    collar.position.y = H;
    penHolder.add(collar);
    for (const kz of [56, 82]) {
      const k = mesh(knobY(5, 8), m.brass);
      k.position.set(0, H + 11, kz);
      penHolder.add(k);
    }
    saddle.add(penHolder);
    // Cutter holder: steel block with set screws.
    const cutterHolder = new THREE.Group();
    cutterHolder.add(mesh(rboxSpan(-14, 14, H - 28, H - 3.2, 42, 96, 2), m.steelGround));
    cutterHolder.add(mesh(rboxSpan(-14, 14, H + 3.2, H + 12, 42, 96, 2), m.steelGround));
    cutterHolder.add(mesh(rboxSpan(-14, -4, H - 3.2, H + 3.2, 42, 96, 0.8), m.steelGround));
    for (const kz of [52, 68, 84]) {
      const sc = mesh(latheZ([[0, 0], [3.4, 0], [3.4, 4], [0, 4]], 6), m.steelDark);
      sc.rotation.x = -Math.PI / 2;
      sc.position.set(0, H + 12, kz);
      cutterHolder.add(sc);
    }
    saddle.add(cutterHolder);
    // Tools ride on toolZ (follows the work face along Z with the pump).
    const toolZ = new THREE.Group();
    saddle.add(toolZ);
    const pen = new THREE.Group();
    pen.position.y = H;
    pen.add(mesh(cylZ(0.32, 0, 3.2, 12), m.steel));
    pen.add(mesh(latheZ([[0.55, 3], [1.1, 3.4], [2.2, 7], [4.4, 13], [4.8, 14], [0, 14]], 32), m.steel));
    pen.add(
      mesh(
        latheZ(
          [
            [0, 14],
            [4.6, 14],
            [5.0, 16],
            [5.0, 28],
            [5.5, 30],
            [5.5, 106],
            [5.0, 109],
            [3.6, 111],
            [0, 111.5],
          ],
          40,
        ),
        m.penBody,
      ),
    );
    const band = mesh(ringZ(5.45, 5.75, 99, 104, 0.2, 40), m.penBand);
    pen.add(band);
    const band2 = mesh(ringZ(5.0, 5.3, 25, 28, 0.2, 40), m.penBand);
    pen.add(band2);
    toolZ.add(pen);
    const cutter = new THREE.Group();
    cutter.position.y = H;
    {
      // V-pointed square shank (HSS).
      const tip = new THREE.ConeGeometry(4.2, 7, 4, 1);
      tip.rotateX(-Math.PI / 2); // point toward -Z
      tip.rotateZ(Math.PI / 4);
      tip.translate(0, 0, 3.5);
      cutter.add(mesh(tip, m.steel));
      cutter.add(mesh(rboxSpan(-3, 3, -3, 3, 7, 104, 0.5), m.steel));
    }
    toolZ.add(cutter);
    root.add(saddle);

    return {
      root,
      layout: l,
      cradle,
      spindle,
      chuckPlate,
      spacer,
      ellHousing,
      rockRubber,
      pumpRubber,
      saddle,
      toolZ,
      pen,
      cutter,
      penHolder,
      cutterHolder,
      leadscrew,
      plunger,
      needle,
      spring,
      springA,
      springB,
      rosetteMeshes,
      carrierEcc: new THREE.Group(),
      carrierPlain: new THREE.Group(),
    };
  }
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, cast = true, receive = true): THREE.Mesh {
  const me = new THREE.Mesh(geo, mat);
  me.castShadow = cast;
  me.receiveShadow = receive;
  return me;
}

function wrap(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

function wrapPi(a: number): number {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  else if (r < -Math.PI) r += TAU;
  return r;
}
