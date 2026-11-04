// Dev harness for the 3D rose engine model (src/render/machine3d). Run: npx vite --port 5176 --strictPort
// then open /dev/machine.html. Exposes window.__h for the Playwright screenshot script.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createMachineModel, MachineModel } from '../src/render/machine3d';
import { defaultRecipe, defaultRosette, type Recipe } from '../src/state/recipe';
import type { CameraPreset } from '../src/state/store';
import { computeToolpath, poseAt, poseAtSample, prepare, toolPoint } from '../src/engine';
import type { Prepared, Toolpath } from '../src/engine/types';

const view = document.getElementById('view')!;
const bar = document.getElementById('bar')!;
const status = document.getElementById('status')!;
if (new URLSearchParams(location.search).has('clean')) document.body.classList.add('clean');

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = backdrop();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 5, 20000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const model = createMachineModel() as MachineModel;
scene.add(model.group);

// ---------------------------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------------------------
type ConfigName = 'sine12' | 'concave5' | 'pump' | 'eccentric' | 'elliptical' | 'knife';
function makeRecipe(name: ConfigName): Recipe {
  const r = defaultRecipe();
  r.slide.passes = 18;
  r.slide.startRadius = 10;
  r.slide.endRadius = 44;
  if (name === 'concave5') {
    r.rosettes = [defaultRosette({ id: 'c5', lobes: 5, amplitude: 3.5, profile: 'concave' })];
    r.slide.phaseMode = 'linear';
    r.slide.phaseStep = 2.5;
  } else if (name === 'pump') {
    r.rosettes = [
      defaultRosette({ id: 'r12', lobes: 12, amplitude: 1.2 }),
      defaultRosette({ id: 'p8', axis: 'pump', lobes: 8, amplitude: 1.6, profile: 'sine' }),
    ];
  } else if (name === 'eccentric') {
    r.rosettes = [defaultRosette({ id: 'f7', lobes: 7, amplitude: 1.5, profile: 'flame' })];
    r.slide.passes = 6;
    r.slide.startRadius = 6;
    r.slide.endRadius = 16;
    r.slide.phaseMode = 'linear';
    r.eccentric = { enabled: true, offset: 18, angle: 30, divisions: 6, divisionStep: 0 };
  } else if (name === 'knife') {
    r.machine.rubberRadius = 0;
    r.rosettes = [defaultRosette({ id: 'k8', lobes: 8, amplitude: 2.5, profile: 'flame' })];
  } else if (name === 'elliptical') {
    r.rosettes = [defaultRosette({ id: 's16', lobes: 16, amplitude: 1.0, profile: 'sine' })];
    r.elliptical = { enabled: true, e: 8, angle: 20 };
  }
  return r;
}

// ---------------------------------------------------------------------------------------------
// Placeholder work material: "F" glyph + axis arrows (+X right, +Y up seen from +Z) + the toolpath
// ---------------------------------------------------------------------------------------------
const TEX = 2048;
const texCanvas = document.createElement('canvas');
texCanvas.width = texCanvas.height = TEX;
const tex = new THREE.CanvasTexture(texCanvas);
tex.colorSpace = THREE.SRGBColorSpace;
tex.anisotropy = 8;
const inkMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0 });
const metalMat = new THREE.MeshStandardMaterial({ map: tex, color: '#e6e9ec', roughness: 0.28, metalness: 1 });

function drawWork(recipe: Recipe, tp: Toolpath): void {
  const ctx = texCanvas.getContext('2d')!;
  const D = recipe.machine.workDiameter;
  const S = TEX;
  const px = (x: number) => (x / D + 0.5) * S;
  const py = (y: number) => (1 - (y / D + 0.5)) * S;
  const metal = recipe.mode === 'metal';
  ctx.fillStyle = metal ? '#d9dde1' : recipe.ink.paper;
  ctx.fillRect(0, 0, S, S);
  // Reference rings every 10 mm.
  ctx.strokeStyle = metal ? 'rgba(0,0,0,0.12)' : 'rgba(120,100,70,0.25)';
  ctx.lineWidth = 2;
  for (let r = 10; r < D / 2; r += 10) {
    ctx.beginPath();
    ctx.arc(px(0), py(0), (r / D) * S, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Axis arrows: +X red, +Y green.
  const arrow = (x1: number, y1: number, col: string, label: string) => {
    ctx.strokeStyle = ctx.fillStyle = col;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(px(0), py(0));
    ctx.lineTo(px(x1), py(y1));
    ctx.stroke();
    const a = Math.atan2(py(y1) - py(0), px(x1) - px(0));
    ctx.beginPath();
    ctx.moveTo(px(x1) + 40 * Math.cos(a), py(y1) + 40 * Math.sin(a));
    ctx.lineTo(px(x1) + 40 * Math.cos(a + 2.5), py(y1) + 40 * Math.sin(a + 2.5));
    ctx.lineTo(px(x1) + 40 * Math.cos(a - 2.5), py(y1) + 40 * Math.sin(a - 2.5));
    ctx.fill();
    ctx.font = 'bold 90px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, px(x1 * 1.25), py(y1 * 1.25));
  };
  arrow(D * 0.3, 0, '#c0392b', '+X');
  arrow(0, D * 0.3, '#1e8449', '+Y');
  // "F" glyph in the upper-left quadrant.
  ctx.fillStyle = 'rgba(30,30,30,0.85)';
  ctx.font = `bold ${Math.round(S * 0.22)}px Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('F', px(-D * 0.2), py(D * 0.2));
  // Toolpath.
  ctx.strokeStyle = metal ? 'rgba(40,40,50,0.85)' : recipe.ink.palette[0];
  ctx.lineWidth = Math.max(2, (recipe.ink.lineWidth / D) * S);
  for (const pass of tp.passes) {
    ctx.beginPath();
    for (let i = 0; i < pass.count; i++) {
      const k = pass.start + i;
      if (i === 0) ctx.moveTo(px(tp.x[k]), py(tp.y[k]));
      else ctx.lineTo(px(tp.x[k]), py(tp.y[k]));
    }
    if (pass.closed) ctx.closePath();
    ctx.stroke();
  }
  tex.needsUpdate = true;
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------
let recipe = makeRecipe('sine12');
let prepared: Prepared = prepare(recipe);
let toolpath: Toolpath = computeToolpath(prepared);
let sample = toolpath.samplesPerRev * 3.3;
let playing = true;
let config: ConfigName = 'sine12';

function load(name: ConfigName, mode = recipe.mode): void {
  config = name;
  recipe = makeRecipe(name);
  recipe.mode = mode;
  prepared = prepare(recipe);
  toolpath = computeToolpath(prepared);
  model.setRecipe(recipe, prepared);
  model.setWorkMaterial(mode === 'ink' ? inkMat : metalMat);
  drawWork(recipe, toolpath);
  sample = Math.min(sample, toolpath.totalSamples - 1);
  refreshButtons();
}

function setPreset(p: CameraPreset): void {
  const { position, target } = model.getCameraPreset(p);
  camera.position.copy(position);
  controls.target.copy(target);
  controls.update();
}

function applySample(s: number): void {
  sample = ((s % toolpath.totalSamples) + toolpath.totalSamples) % toolpath.totalSamples;
  model.setPose(poseAtSample(prepared, toolpath, sample));
}

/** Numeric check: world tool tip vs disc-local toolPoint mapped to world, at many poses. */
function check(n = 64): { maxErr: number; rubberRock: [number, number] | null; rubberPump: [number, number] | null } {
  const tip = new THREE.Vector3();
  const w = new THREE.Vector3();
  let maxErr = 0;
  let rr: [number, number] | null = null;
  let rp: [number, number] | null = null;
  const strokes = toolpath.passes.length;
  for (let i = 0; i < n; i++) {
    const pass = Math.floor((i * 7919) % strokes);
    const theta = ((i * 0.6180339887) % 1) * Math.PI * 2 * (recipe.slide.spiral ? recipe.slide.passes : 1);
    const pose = poseAt(prepared, pass, theta);
    model.setPose(pose);
    const p = toolPoint(prepared, pose);
    model.getToolTip(tip);
    model.workToWorld(p.x, p.y, w);
    maxErr = Math.max(maxErr, tip.distanceTo(w));
    const d = model.debugRubbers();
    if (d.rock !== null) rr = rr ? [Math.min(rr[0], d.rock), Math.max(rr[1], d.rock)] : [d.rock, d.rock];
    if (d.pump !== null) rp = rp ? [Math.min(rp[0], d.pump), Math.max(rp[1], d.pump)] : [d.pump, d.pump];
  }
  applySample(sample);
  return { maxErr, rubberRock: rr, rubberPump: rp };
}

// ---------------------------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------------------------
const buttons: { el: HTMLButtonElement; on: () => boolean }[] = [];
function btn(label: string, fn: () => void, on: () => boolean = () => false): void {
  const el = document.createElement('button');
  el.textContent = label;
  el.onclick = fn;
  bar.appendChild(el);
  buttons.push({ el, on });
}
function sep(): void {
  const s = document.createElement('span');
  s.className = 'sep';
  bar.appendChild(s);
}
function refreshButtons(): void {
  for (const b of buttons) b.el.classList.toggle('on', b.on());
}
btn('Overview', () => setPreset('overview'));
btn('Rosette', () => setPreset('rosette'));
btn('Tool', () => setPreset('tool'));
sep();
btn('Ink', () => load(config, 'ink'), () => recipe.mode === 'ink');
btn('Metal', () => load(config, 'metal'), () => recipe.mode === 'metal');
sep();
btn('12-lobe sine', () => load('sine12'), () => config === 'sine12');
btn('5-lobe concave', () => load('concave5'), () => config === 'concave5');
btn('Pump', () => load('pump'), () => config === 'pump');
btn('Eccentric', () => load('eccentric'), () => config === 'eccentric');
btn('Elliptical', () => load('elliptical'), () => config === 'elliptical');
sep();
btn('Play/Pause', () => {
  playing = !playing;
}, () => playing);
btn('Check', () => console.log('[machine3d check]', check()));

// ---------------------------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------------------------
let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (playing) applySample(sample + dt * 0.25 * toolpath.samplesPerRev);
  controls.update();
  renderer.render(scene, camera);
  status.textContent = `${config} · ${recipe.mode} · sample ${sample.toFixed(0)}/${toolpath.totalSamples}`;
  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function backdrop(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, '#2b2e33');
  g.addColorStop(0.6, '#1c1e21');
  g.addColorStop(1, '#121315');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

load('sine12', 'ink');
applySample(sample);
setPreset('overview');
requestAnimationFrame(frame);

declare global {
  interface Window {
    __h: unknown;
  }
}
window.__h = {
  load: (name: ConfigName, mode?: 'ink' | 'metal') => load(name, mode),
  preset: setPreset,
  sample: (s: number) => applySample(s),
  rev: (revs: number) => applySample(revs * toolpath.samplesPerRev),
  pause: () => {
    playing = false;
  },
  play: () => {
    playing = true;
  },
  check,
  orbit: (dAz: number, dEl: number, zoom = 1) => {
    const off = camera.position.clone().sub(controls.target);
    const sph = new THREE.Spherical().setFromVector3(off);
    sph.theta += dAz;
    sph.phi = Math.max(0.05, Math.min(Math.PI - 0.05, sph.phi - dEl));
    sph.radius *= zoom;
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(sph));
    controls.update();
  },
  camera: () => ({ p: camera.position.toArray(), t: controls.target.toArray() }),
  look: (p: number[], t: number[]) => {
    camera.position.fromArray(p);
    controls.target.fromArray(t);
    controls.update();
  },
  pose: (o: Partial<import('../src/engine/types').Pose>) => {
    const base = poseAt(prepared, 0, 0);
    model.setPose({ ...base, ...o });
  },
  tip: () => model.getToolTip(new THREE.Vector3()).toArray(),
  edge: () => {
    const cases: Record<string, (r: Recipe) => void> = {
      noRosettes: (r) => {
        r.rosettes = [];
      },
      spiral: (r) => {
        r.slide.spiral = true;
        r.slide.phaseMode = 'linear';
        r.slide.phaseStep = 3;
      },
      bigDisc: (r) => {
        r.machine.workDiameter = 300;
        r.slide.endRadius = 140;
        r.eccentric = { enabled: true, offset: 60, angle: 45, divisions: 3, divisionStep: 0 };
        r.elliptical = { enabled: true, e: 30, angle: 90 };
      },
      tinyDisc: (r) => {
        r.machine.workDiameter = 20;
        r.slide.startRadius = 1;
        r.slide.endRadius = 9;
      },
      lobes96saw: (r) => {
        r.rosettes = [defaultRosette({ id: 'x', lobes: 96, profile: 'saw', amplitude: 0.5 })];
      },
      allDisabled: (r) => {
        r.rosettes[0].enabled = false;
        r.rosettes.push(defaultRosette({ id: 'pp', axis: 'pump', enabled: false }));
      },
      rubber0: (r) => {
        r.machine.rubberRadius = 0;
        r.rosettes[0].profile = 'square';
      },
      rubber12big: (r) => {
        r.machine.rubberRadius = 12;
        r.machine.rosetteRadius = 120;
        r.rosettes = [defaultRosette({ id: 'a', lobes: 6, profile: 'concave', amplitude: 8 }), defaultRosette({ id: 'b', axis: 'pump', lobes: 3, amplitude: 8 })];
      },
    };
    const out: Record<string, string> = {};
    for (const [name, fn] of Object.entries(cases)) {
      try {
        recipe = makeRecipe('sine12');
        fn(recipe);
        prepared = prepare(recipe);
        toolpath = computeToolpath(prepared);
        model.setRecipe(recipe, prepared);
        drawWork(recipe, toolpath);
        const c = check(32);
        out[name] = `ok maxErr=${c.maxErr.toExponential(1)} rock=${JSON.stringify(c.rubberRock)} pump=${JSON.stringify(c.rubberPump)}`;
      } catch (e) {
        out[name] = 'ERROR ' + (e as Error).stack;
      }
    }
    return out;
  },
  disposeTest: () => {
    renderer.render(scene, camera);
    const before = { ...renderer.info.memory };
    const extra = createMachineModel();
    const r = makeRecipe('pump');
    extra.setRecipe(r, prepare(r));
    scene.add(extra.group);
    renderer.render(scene, camera);
    const during = { ...renderer.info.memory };
    scene.remove(extra.group);
    extra.dispose();
    renderer.render(scene, camera);
    const after = { ...renderer.info.memory };
    return { before, during, after };
  },
  timings: () => {
    const t = (fn: () => void) => {
      const t0 = performance.now();
      fn();
      return +(performance.now() - t0).toFixed(1);
    };
    const r = makeRecipe('sine12');
    const out: Record<string, number> = {};
    out.fresh = t(() => model.setRecipe(r, prepare(r)));
    const same = structuredClone(r);
    const pSame = prepare(same);
    out.unchanged = t(() => model.setRecipe(same, pSame));
    const ph = structuredClone(r);
    ph.rosettes[0].phase = 7;
    const pPh = prepare(ph);
    out.phaseOnly = t(() => model.setRecipe(ph, pPh));
    const amp = structuredClone(r);
    amp.rosettes[0].amplitude = 1.7;
    const pAmp = prepare(amp);
    out.amplitude = t(() => model.setRecipe(amp, pAmp));
    const hi = structuredClone(r);
    hi.rosettes[0].lobes = 96;
    const pHi = prepare(hi);
    out.lobes96 = t(() => model.setRecipe(hi, pHi));
    const pose = poseAt(pHi, 3, 1.1);
    out.setPose1000 = t(() => {
      for (let i = 0; i < 1000; i++) model.setPose({ ...pose, spindleAngle: pose.spindleAngle + i * 0.001 });
    });
    load(config, recipe.mode);
    return out;
  },
  ready: true,
};
