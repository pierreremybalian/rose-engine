// RenderApp: one WebGLRenderer, two scissor viewports (3D machine + flat work view), the 4096² disc
// surface for the 3D workpiece, and offscreen PNG export.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { poseAtSample, workPlacement } from '../engine';
import type { Pose, Prepared, Toolpath } from '../engine/types';
import type { Recipe } from '../state/recipe';
import type { CameraPreset, Layout, WorkFrame } from '../state/store';
import type { IMachineModel, IRenderApp, PngOptions } from './types';
import {
  buildStrokeMesh,
  createPassColorTexture,
  fillPassColors,
  indexRange,
  pointAtSample,
  PASS_TEX_WIDTH,
  type StrokeMesh,
} from './strokeMesh';
import {
  createBackgroundMaterial,
  createBackgroundUniforms,
  createInkDiscMaterial,
  createInkStrokeMaterial,
  createInkUniforms,
  srgbHexToVec3,
  SURROUND_SRGB,
  updateInkUniforms,
} from './surfaces/ink';
import {
  applyMetalPreset,
  createGrooveBgMaterial,
  createGrooveMaterial,
  createGrooveUniforms,
  createMetalMaterial,
  createMetalShared,
  envRotationForLight,
  lightDirection,
  updateGrooveUniforms,
  updateMetalShared,
} from './surfaces/metal';
import { blitFrag, blitVert, markerFrag, markerVert } from './shaders/stroke';
import { WorkView } from './workView';
import { createStudioEnvironment } from './surfaces/studio';

const DISC_SIZE = 4096;
const DISC_THROTTLE_MS = 90;
const PNG_TILE = 2048;
const MAX_DPR = 2;
const BG_3D = 0x18191c;
const MARKER_COLOR = new THREE.Vector3(0.93, 0.66, 0.26);

/** Device-pixel rectangle, GL convention (origin bottom-left). */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 0 = clean, 1 = append newly revealed samples, 2 = redraw everything. */
type Dirty = 0 | 1 | 2;

interface Placement {
  rotation: number;
  x: number;
  y: number;
}

interface Tween {
  fromPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toPos: THREE.Vector3;
  toTarget: THREE.Vector3;
  t0: number;
  dur: number;
}

/** A scene whose work-frame content hangs under a placement group (machine frame = rot·work + offset). */
class WorkLayer {
  readonly scene = new THREE.Scene();
  readonly group = new THREE.Group();
  constructor() {
    this.scene.add(this.group);
    this.scene.matrixWorldAutoUpdate = true;
  }
  place(p: Placement): void {
    this.group.rotation.set(0, 0, p.rotation);
    this.group.position.set(p.x, p.y, 0);
  }
}

const IDENTITY: Placement = { rotation: 0, x: 0, y: 0 };

export class RenderApp implements IRenderApp {
  private readonly container: HTMLElement;
  private readonly machine: IMachineModel;
  private readonly onFrame?: () => void;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly machineEl: HTMLDivElement;
  private readonly workEl: HTMLDivElement;
  private readonly resizeObserver: ResizeObserver;
  private raf = 0;
  private disposed = false;

  // layout
  private width = 0;
  private height = 0;
  private dpr = 1;
  private layout: Layout = 'split';
  private frame: WorkFrame = 'work';
  private machineRect: Rect | null = null;
  private workRect: Rect | null = null;

  // data
  private recipe: Recipe | null = null;
  private prepared: Prepared | null = null;
  private toolpath: Toolpath | null = null;
  private stroke: StrokeMesh | null = null;
  private progress = 0;
  private pose: Pose | null = null;
  private placement: Placement = { ...IDENTITY };
  private mode: 'ink' | 'metal' = 'ink';

  // 3D
  private readonly scene3d = new THREE.Scene();
  private readonly camera3d = new THREE.PerspectiveCamera(32, 1, 2, 20000);
  private readonly controls: OrbitControls;
  private readonly keyLight: THREE.DirectionalLight;
  private readonly ground: THREE.Mesh;
  private tween: Tween | null = null;
  private cameraPlaced = false;
  /** Preset the 3D camera rests on (re-framed when the viewport or machine changes); null once the user orbits. */
  private parked: CameraPreset | null = 'overview';

  // shared resources
  private readonly envTex: THREE.Texture;
  private readonly studioTex: THREE.Texture;
  private readonly bigPlane = new THREE.PlaneGeometry(4e4, 4e4);
  private readonly passColors: THREE.DataTexture;
  private passCapacity: number;
  private readonly inkU = createInkUniforms();
  private readonly bgU = createBackgroundUniforms();
  private readonly grooveU = createGrooveUniforms();
  private readonly grooveBgU = { uRadius: { value: 50 }, uBevel: { value: 0.3 } };
  private readonly metalShared = createMetalShared();
  private readonly inkMat: THREE.RawShaderMaterial;
  private readonly bgMat: THREE.RawShaderMaterial;
  private readonly grooveMatMRT: THREE.RawShaderMaterial;
  private readonly grooveMat1: THREE.RawShaderMaterial;
  private readonly grooveBgMRT: THREE.RawShaderMaterial;
  private readonly grooveBg1: THREE.RawShaderMaterial;
  private readonly metalFlatMat: THREE.MeshPhysicalMaterial;
  private readonly metalDiscMat: THREE.MeshPhysicalMaterial;
  private readonly inkDiscMat: THREE.MeshStandardMaterial;

  // layers (each owns meshes that share the stroke geometry)
  private readonly inkLayer = new WorkLayer();
  private readonly grooveLayer = new WorkLayer();
  private readonly litLayer = new WorkLayer();
  private readonly inkStrokeMesh: THREE.Mesh;
  private readonly grooveStrokeMesh: THREE.Mesh;
  private readonly inkBgMesh: THREE.Mesh;
  private readonly grooveBgMesh: THREE.Mesh;
  private readonly litBgMesh: THREE.Mesh;
  private readonly metalDisc: THREE.Mesh;
  private readonly litLight: THREE.DirectionalLight;
  private readonly litFill: THREE.DirectionalLight;
  private readonly overlayScene = new THREE.Scene();
  private readonly marker: THREE.Mesh;
  private readonly markerU = {
    uCenter: { value: new THREE.Vector2() },
    uSizeMm: { value: 1 },
    uSizePx: { value: 20 },
    uColor: { value: MARKER_COLOR.clone() },
  };
  private readonly blitScene = new THREE.Scene();
  private readonly blitU = { uTex: { value: null as THREE.Texture | null } };
  private readonly blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // flat view
  private readonly work: WorkView;
  private inkRT: THREE.WebGLRenderTarget | null = null;
  private grooveRT: THREE.WebGLRenderTarget | null = null;
  private workDirty: Dirty = 2;
  private workCacheProgress = 0;

  // 3D disc surface
  private readonly discRT: THREE.WebGLRenderTarget;
  private readonly discCam: THREE.OrthographicCamera;
  private discDirty: Dirty = 2;
  private discProgress = 0;
  private discLast = 0;

  private needsRender = true;
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpP = { x: 0, y: 0 };

  constructor(container: HTMLElement, opts: { machine: IMachineModel; onFrame?: () => void }) {
    this.container = container;
    this.machine = opts.machine;
    this.onFrame = opts.onFrame;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(1); // we size the drawing buffer in device pixels ourselves
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.autoClear = false;
    this.renderer = renderer;
    this.canvas = renderer.domElement;
    Object.assign(this.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' });

    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.appendChild(this.canvas);
    this.machineEl = this.makeOverlay('rose-machine-view');
    this.workEl = this.makeOverlay('rose-work-view');

    // environment
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    // shared materials
    this.passCapacity = PASS_TEX_WIDTH;
    this.passColors = createPassColorTexture(this.passCapacity);
    this.inkU.uPassColors.value = this.passColors;
    this.inkMat = createInkStrokeMaterial(this.inkU);
    this.bgMat = createBackgroundMaterial(this.bgU);
    this.grooveMatMRT = createGrooveMaterial(this.grooveU, true);
    this.grooveMat1 = createGrooveMaterial(this.grooveU, false);
    this.grooveBgMRT = createGrooveBgMaterial(this.grooveBgU, true);
    this.grooveBg1 = createGrooveBgMaterial(this.grooveBgU, false);
    this.metalFlatMat = createMetalMaterial('flat', this.metalShared);
    this.studioTex = createStudioEnvironment(renderer);
    this.metalFlatMat.envMap = this.studioTex;
    this.metalDiscMat = createMetalMaterial('disc', this.metalShared);

    // 3D disc surface target
    const maxTex = renderer.capabilities.maxTextureSize;
    const discSize = Math.min(DISC_SIZE, maxTex);
    this.discRT = new THREE.WebGLRenderTarget(discSize, discSize, {
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      anisotropy: renderer.capabilities.getMaxAnisotropy(),
    });
    this.discCam = new THREE.OrthographicCamera(-50, 50, 50, -50, 1, 1000);
    this.discCam.position.set(0, 0, 100);
    this.metalDiscMat.normalMap = this.discRT.texture;
    this.inkDiscMat = createInkDiscMaterial(this.discRT.texture);

    // layers
    const mk = (g: THREE.BufferGeometry, m: THREE.Material, order: number) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.frustumCulled = false;
      mesh.renderOrder = order;
      return mesh;
    };
    const empty = new THREE.BufferGeometry();
    this.inkBgMesh = mk(this.bigPlane, this.bgMat, -1);
    this.inkStrokeMesh = mk(empty, this.inkMat, 0);
    this.inkStrokeMesh.visible = false;
    this.inkLayer.group.add(this.inkBgMesh, this.inkStrokeMesh);

    this.grooveBgMesh = mk(this.bigPlane, this.grooveBgMRT, -1);
    this.grooveStrokeMesh = mk(empty, this.grooveMatMRT, 0);
    this.grooveStrokeMesh.visible = false;
    this.grooveLayer.group.add(this.grooveBgMesh, this.grooveStrokeMesh);

    this.litBgMesh = mk(this.bigPlane, this.bgMat, -1);
    this.metalDisc = mk(new THREE.CircleGeometry(50, 720), this.metalFlatMat, 0);
    this.litLayer.group.add(this.litBgMesh, this.metalDisc);
    this.litLight = new THREE.DirectionalLight(0xffffff, 0.6);
    this.litFill = new THREE.DirectionalLight(0xdfe8ff, 0.12);
    this.litLayer.scene.add(this.litLight, this.litFill);

    this.marker = mk(
      new THREE.PlaneGeometry(2, 2),
      new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: markerVert,
        fragmentShader: markerFrag,
        uniforms: this.markerU,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      }),
      10,
    );
    this.marker.visible = false;
    this.overlayScene.add(this.marker);

    this.blitScene.add(
      mk(
        new THREE.PlaneGeometry(2, 2),
        new THREE.RawShaderMaterial({
          glslVersion: THREE.GLSL3,
          vertexShader: blitVert,
          fragmentShader: blitFrag,
          uniforms: this.blitU,
          depthTest: false,
          depthWrite: false,
        }),
        0,
      ),
    );

    // 3D scene
    const s3 = this.scene3d;
    s3.environment = this.envTex;
    s3.environmentIntensity = 0.85;
    s3.add(new THREE.HemisphereLight(0xe8eef8, 0x2b2620, 0.45));
    this.keyLight = new THREE.DirectionalLight(0xfff4e6, 2.4);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.bias = -0.0004;
    this.keyLight.shadow.normalBias = 0.6;
    this.keyLight.shadow.radius = 4;
    s3.add(this.keyLight, this.keyLight.target);
    const rim = new THREE.DirectionalLight(0xc8d8ff, 0.7);
    rim.position.set(-600, 300, -500);
    s3.add(rim);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.32 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    s3.add(this.ground);
    s3.add(this.machine.group);
    // The machine model brings its own shadow-casting key light; keep ours as fill only so shadows aren't doubled.
    if (this.machine.group.getObjectByName('machineKeyLight')) this.keyLight.castShadow = false;
    this.machine.setWorkMaterial(this.inkDiscMat);

    this.camera3d.position.set(300, 220, 420);
    this.controls = new OrbitControls(this.camera3d, this.machineEl);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.addEventListener('change', () => (this.needsRender = true));
    this.controls.addEventListener('start', () => {
      this.tween = null;
      this.parked = null;
    });
    this.applyCameraPreset('overview', false);

    this.work = new WorkView(
      this.workEl,
      () => this.invalidateWork(2),
      () => this.resetWorkView(),
    );

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.raf = requestAnimationFrame(this.loop);
  }

  // ───────────────────────────── public API ─────────────────────────────

  setRecipe(recipe: Recipe, prepared: Prepared, toolpath: Toolpath): void {
    const prev = this.recipe;
    this.recipe = recipe;
    this.prepared = prepared;
    const tpChanged = toolpath !== this.toolpath;
    if (tpChanged) {
      this.toolpath = toolpath;
      const old = this.stroke?.geometry;
      this.stroke = buildStrokeMesh(toolpath);
      for (const m of [this.inkStrokeMesh, this.grooveStrokeMesh]) {
        m.geometry = this.stroke.geometry;
        m.visible = toolpath.totalSamples > 0;
      }
      old?.dispose();
    }
    const passCount = toolpath.passes.length;
    if (passCount > this.passCapacity) {
      this.passCapacity = Math.ceil(passCount / PASS_TEX_WIDTH) * PASS_TEX_WIDTH;
      const h = Math.ceil(this.passCapacity / PASS_TEX_WIDTH);
      this.passColors.image = { data: new Uint8Array(PASS_TEX_WIDTH * h * 4), width: PASS_TEX_WIDTH, height: h } as never;
      this.passColors.dispose();
    }
    fillPassColors(this.passColors, recipe.ink, passCount);

    // surfaces
    updateInkUniforms(this.inkU, recipe.ink, toolpath);
    srgbHexToVec3(recipe.ink.paper, this.bgU.uPaper.value);
    updateGrooveUniforms(this.grooveU, recipe.metal, toolpath);
    updateMetalShared(this.metalShared, recipe.metal);
    applyMetalPreset(this.metalFlatMat, recipe.metal, 'flat');
    applyMetalPreset(this.metalDiscMat, recipe.metal, 'disc');
    const L = lightDirection(recipe.metal.lightAngle, recipe.metal.lightElevation, this.tmpV);
    this.litLight.position.copy(L).multiplyScalar(1000);
    this.litFill.position.set(-L.x, -L.y, Math.max(0.6, L.z)).multiplyScalar(1000);
    envRotationForLight(L, this.metalFlatMat.envMapRotation);
    this.metalShared.uLightXY.value.set(L.x, L.y).normalize();

    const D = recipe.machine.workDiameter;
    const R = D / 2;
    this.bgU.uRadius.value = R;
    this.grooveBgU.uRadius.value = R;
    this.grooveBgU.uBevel.value = Math.min(0.6, R * 0.006);
    if (!prev || prev.machine.workDiameter !== D) {
      this.metalDisc.geometry.dispose();
      this.metalDisc.geometry = new THREE.CircleGeometry(R, 720);
    }
    this.discCam.left = -R;
    this.discCam.right = R;
    this.discCam.top = R;
    this.discCam.bottom = -R;
    this.discCam.updateProjectionMatrix();
    this.work.setDiameter(D);

    const mode = recipe.mode === 'metal' ? 'metal' : 'ink';
    if (mode !== this.mode || !prev) {
      this.mode = mode;
      this.machine.setWorkMaterial(mode === 'metal' ? this.metalDiscMat : this.inkDiscMat);
    }

    this.machine.setRecipe(recipe, prepared);
    this.updateGroundAndLights();
    // The machine can change size (work diameter, rosette stack): keep a parked camera framing it.
    if (!this.cameraPlaced) this.applyCameraPreset('overview', false);
    else if (this.parked) this.applyCameraPreset(this.parked, true);

    this.progress = Math.min(this.progress, toolpath.totalSamples);
    this.updatePose();
    this.invalidateWork(2);
    this.discDirty = 2;
    this.needsRender = true;
  }

  setProgress(samples: number): void {
    const total = this.toolpath?.totalSamples ?? 0;
    const s = Math.max(0, Math.min(total, Number.isFinite(samples) ? samples : 0));
    if (s === this.progress) return;
    const back = s < this.progress;
    this.progress = s;
    this.updatePose();
    this.invalidateWork(back || this.frame === 'machine' ? 2 : 1);
    if (back) this.discDirty = 2;
    else if (this.discDirty === 0) this.discDirty = 1;
    this.needsRender = true;
  }

  setLayout(layout: Layout): void {
    if (layout === this.layout) return;
    this.layout = layout;
    this.computeLayout();
  }

  setFrame(frame: WorkFrame): void {
    if (frame === this.frame) return;
    this.frame = frame;
    this.updatePose();
    this.invalidateWork(2);
  }

  setCameraPreset(preset: CameraPreset): void {
    this.applyCameraPreset(preset, true);
  }

  resetWorkView(): void {
    this.work.fit();
  }

  async renderPNG(opts: PngOptions): Promise<Blob> {
    if (!this.recipe || !this.toolpath) throw new Error('renderPNG: no recipe');
    const gl = this.renderer.getContext();
    const cap = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, this.renderer.capabilities.maxTextureSize);
    let W = Math.max(1, Math.round(opts.width));
    let H = Math.max(1, Math.round(opts.height));
    if (W > cap || H > cap) {
      const k = cap / Math.max(W, H);
      W = Math.max(1, Math.floor(W * k));
      H = Math.max(1, Math.floor(H * k));
    }
    const metal = this.mode === 'metal';
    const transparent = !!opts.transparent;
    const D = this.recipe.machine.workDiameter;
    const mmPerPx = D / Math.min(W, H);
    const cam = new THREE.OrthographicCamera((-W / 2) * mmPerPx, (W / 2) * mmPerPx, (H / 2) * mmPerPx, (-H / 2) * mmPerPx, 1, 1000);
    cam.position.set(0, 0, 100);
    cam.updateMatrixWorld();
    const tile = Math.min(PNG_TILE, cap);
    const samples = 4;
    const colorRT = new THREE.WebGLRenderTarget(tile, tile, { type: THREE.UnsignedByteType, samples, depthBuffer: false });
    const grooveRT = metal
      ? new THREE.WebGLRenderTarget(tile, tile, { type: THREE.UnsignedByteType, count: 2, samples, depthBuffer: true })
      : null;
    const out = new Uint8ClampedArray(W * H * 4);
    const buf = new Uint8Array(tile * tile * 4);
    const total = this.toolpath.totalSamples;
    const savedNormal = this.metalFlatMat.normalMap;
    const savedAniso = this.metalFlatMat.anisotropyMap;
    try {
      for (let ty = 0; ty < H; ty += tile) {
        for (let tx = 0; tx < W; tx += tile) {
          const tw = Math.min(tile, W - tx);
          const th = Math.min(tile, H - ty);
          cam.setViewOffset(W, H, tx, ty, tw, th);
          cam.updateProjectionMatrix();
          colorRT.setSize(tw, th);
          if (metal && grooveRT) {
            grooveRT.setSize(tw, th);
            this.drawGroove(grooveRT, cam, 1 / mmPerPx, IDENTITY, total + 1);
            this.metalFlatMat.normalMap = grooveRT.textures[0];
            this.metalFlatMat.anisotropyMap = grooveRT.textures[1];
            this.drawLit(colorRT, cam, IDENTITY, { shadow: 0, transparent, surround: SURROUND_SRGB });
          } else {
            this.drawInk(colorRT, cam, 1 / mmPerPx, IDENTITY, -1, total + 1, {
              clear: true,
              bg: !transparent,
              shadow: 0,
              paperEverywhere: true,
            });
          }
          this.renderer.readRenderTargetPixels(colorRT, 0, 0, tw, th, buf);
          // GL rows are bottom-up; the PNG is top-down.
          for (let r = 0; r < th; r++) {
            const src = r * tw * 4;
            const dst = ((ty + th - 1 - r) * W + tx) * 4;
            out.set(buf.subarray(src, src + tw * 4), dst);
          }
        }
      }
    } finally {
      this.metalFlatMat.normalMap = savedNormal;
      this.metalFlatMat.anisotropyMap = savedAniso;
      colorRT.dispose();
      grooveRT?.dispose();
      this.renderer.setRenderTarget(null);
      this.needsRender = true;
    }
    if (transparent) {
      // premultiplied → straight alpha
      for (let i = 0; i < out.length; i += 4) {
        const a = out[i + 3];
        if (a > 0 && a < 255) {
          const k = 255 / a;
          out[i] = out[i] * k;
          out[i + 1] = out[i + 1] * k;
          out[i + 2] = out[i + 2] * k;
        }
      }
    } else {
      for (let i = 3; i < out.length; i += 4) out[i] = 255;
    }
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('renderPNG: no 2D context');
    ctx.putImageData(new ImageData(out, W, H), 0, 0);
    return new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('renderPNG: toBlob failed'))), 'image/png'),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.work.dispose();
    this.scene3d.remove(this.machine.group);
    this.stroke?.geometry.dispose();
    this.inkRT?.dispose();
    this.grooveRT?.dispose();
    this.discRT.dispose();
    this.passColors.dispose();
    this.envTex.dispose();
    this.studioTex.dispose();
    this.bigPlane.dispose();
    for (const m of [
      this.inkMat, this.bgMat, this.grooveMatMRT, this.grooveMat1, this.grooveBg1, this.grooveBgMRT,
      this.metalFlatMat, this.metalDiscMat, this.inkDiscMat, this.marker.material as THREE.Material,
    ]) m.dispose();
    this.metalDisc.geometry.dispose();
    this.renderer.dispose();
    this.canvas.remove();
    this.machineEl.remove();
    this.workEl.remove();
  }

  // ─────────────────────────── harness / debug ───────────────────────────

  /** For dev tools: the work view camera controller (zoom/pan programmatically). */
  get workView(): WorkView {
    return this.work;
  }

  /** For dev tools: GPU info. */
  get gl(): THREE.WebGLRenderer {
    return this.renderer;
  }

  // ───────────────────────────── internals ─────────────────────────────

  private makeOverlay(cls: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = cls;
    Object.assign(el.style, { position: 'absolute', left: '0', top: '0', width: '0', height: '0', touchAction: 'none' });
    this.container.appendChild(el);
    return el;
  }

  private invalidateWork(level: Dirty): void {
    if (level > this.workDirty) this.workDirty = level;
    this.needsRender = true;
  }

  private updatePose(): void {
    const tp = this.toolpath;
    const prep = this.prepared;
    if (!tp || !prep || tp.totalSamples <= 0) {
      this.placement = { ...IDENTITY };
      return;
    }
    try {
      this.pose = poseAtSample(prep, tp, this.progress);
      this.machine.setPose(this.pose);
      this.placement = this.frame === 'machine' ? workPlacement(prep, this.pose) : { ...IDENTITY };
    } catch (err) {
      console.error('[render] pose failed', err);
      this.placement = { ...IDENTITY };
    }
  }

  private resize(): void {
    const cw = this.container.clientWidth;
    const ch = this.container.clientHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const w = Math.max(1, Math.round(cw * this.dpr));
    const h = Math.max(1, Math.round(ch * this.dpr));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.computeLayout();
  }

  private computeLayout(): void {
    const W = this.width;
    const H = this.height;
    let m: Rect | null = null;
    let wk: Rect | null = null;
    if (this.layout === 'machine') m = { x: 0, y: 0, w: W, h: H };
    else if (this.layout === 'work') wk = { x: 0, y: 0, w: W, h: H };
    else if (W >= H) {
      const half = Math.round(W / 2);
      m = { x: 0, y: 0, w: half, h: H };
      wk = { x: half, y: 0, w: W - half, h: H };
    } else {
      const half = Math.round(H / 2);
      wk = { x: 0, y: 0, w: W, h: half };
      m = { x: 0, y: half, w: W, h: H - half };
    }
    this.machineRect = m;
    this.workRect = wk;
    this.placeOverlay(this.machineEl, m);
    this.placeOverlay(this.workEl, wk);
    if (m && this.camera3d.aspect !== m.w / m.h) {
      this.camera3d.aspect = m.w / m.h;
      this.camera3d.updateProjectionMatrix();
      if (this.parked) this.applyCameraPreset(this.parked, !!this.tween);
    }
    if (wk) {
      this.work.setViewport(wk.w, wk.h);
      this.ensureWorkTargets(wk.w, wk.h);
    }
    this.invalidateWork(2);
    if (this.discDirty === 0 && this.discProgress !== this.progress) this.discDirty = 1;
  }

  private placeOverlay(el: HTMLElement, r: Rect | null): void {
    if (!r) {
      el.style.display = 'none';
      return;
    }
    const k = this.dpr;
    Object.assign(el.style, {
      display: 'block',
      left: `${r.x / k}px`,
      top: `${(this.height - r.y - r.h) / k}px`,
      width: `${r.w / k}px`,
      height: `${r.h / k}px`,
    });
  }

  private ensureWorkTargets(w: number, h: number): void {
    if (!this.inkRT) {
      this.inkRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: false });
      this.grooveRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, count: 2, samples: 4, depthBuffer: true });
      this.metalFlatMat.normalMap = this.grooveRT.textures[0];
      this.metalFlatMat.anisotropyMap = this.grooveRT.textures[1];
      this.metalFlatMat.needsUpdate = true;
    } else {
      this.inkRT.setSize(w, h);
      this.grooveRT!.setSize(w, h);
    }
  }

  private applyCameraPreset(preset: CameraPreset, animate: boolean): void {
    let p: { position: THREE.Vector3; target: THREE.Vector3 };
    try {
      p = this.machine.getCameraPreset(preset);
    } catch {
      return;
    }
    if (!p || !p.position || !p.target) return;
    p = this.framePreset(preset, p);
    this.parked = preset;
    if (this.recipe) this.cameraPlaced = true;
    const end = this.tween ? this.tween.toPos : this.camera3d.position;
    const endTarget = this.tween ? this.tween.toTarget : this.controls.target;
    const tol = 0.005 * p.position.distanceTo(p.target);
    if (end.distanceTo(p.position) < tol && endTarget.distanceTo(p.target) < tol) return; // already there
    if (!animate) {
      this.tween = null;
      this.camera3d.position.copy(p.position);
      this.controls.target.copy(p.target);
      this.controls.update();
      this.needsRender = true;
      return;
    }
    this.tween = {
      fromPos: this.camera3d.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPos: p.position.clone(),
      toTarget: p.target.clone(),
      t0: performance.now(),
      dur: 900,
    };
    this.needsRender = true;
  }

  /**
   * Fit a machine preset to the 3D viewport's actual aspect, keeping the preset's view direction.
   * Overview: the whole machine's bounding box fills the view with a margin, centred.
   * Close-ups are authored for a landscape view: on a portrait viewport, back off so the subject's width still fits.
   */
  private framePreset(
    preset: CameraPreset,
    p: { position: THREE.Vector3; target: THREE.Vector3 },
  ): { position: THREE.Vector3; target: THREE.Vector3 } {
    const cam = this.camera3d;
    const tanV = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    const tanH = tanV * cam.aspect;
    const back = p.position.clone().sub(p.target);
    const dist = back.length();
    if (!(dist > 0) || !(tanH > 0)) return p;
    back.divideScalar(dist);
    if (preset !== 'overview') {
      const k = Math.max(1, 1.25 / cam.aspect);
      return { position: p.target.clone().addScaledVector(back, dist * k), target: p.target.clone() };
    }
    const right = new THREE.Vector3(0, 1, 0).cross(back);
    if (right.lengthSq() < 1e-8) return p;
    right.normalize();
    const up = back.clone().cross(right);
    // Corners of every visible part's own box (much tighter than the machine's overall box),
    // in view axes relative to the machine centre: (right, up, toward camera).
    const group = this.machine.group;
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) return p;
    const center = box.getCenter(new THREE.Vector3());
    const pts: [number, number, number][] = [];
    const c = new THREE.Vector3();
    group.traverseVisible((o) => {
      const g = (o as THREE.Mesh).isMesh ? (o as THREE.Mesh).geometry : null;
      if (!g) return;
      if (!g.boundingBox) g.computeBoundingBox();
      const b = g.boundingBox!;
      if (b.isEmpty()) return;
      for (let i = 0; i < 8; i++) {
        c.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(o.matrixWorld).sub(center);
        pts.push([c.dot(right), c.dot(up), c.dot(back)]);
      }
    });
    if (!pts.length) return p;
    const pad = 1.05;
    let ox = 0;
    let oy = 0;
    const fitDistance = () => {
      let d = 0;
      for (const [x, y, z] of pts) d = Math.max(d, z + (pad * Math.abs(x - ox)) / tanH, z + (pad * Math.abs(y - oy)) / tanV);
      return d;
    };
    // Distance that fits every corner, then re-centre the projected box; a few rounds converge.
    for (let it = 0; it < 4; it++) {
      const d = fitDistance();
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const [x, y, z] of pts) {
        const depth = d - z;
        const nx = (x - ox) / (depth * tanH);
        const ny = (y - oy) / (depth * tanV);
        x0 = Math.min(x0, nx);
        x1 = Math.max(x1, nx);
        y0 = Math.min(y0, ny);
        y1 = Math.max(y1, ny);
      }
      ox += ((x0 + x1) / 2) * d * tanH;
      oy += ((y0 + y1) / 2) * d * tanV;
    }
    const target = center.addScaledVector(right, ox).addScaledVector(up, oy);
    return { position: target.clone().addScaledVector(back, fitDistance()), target };
  }

  private updateGroundAndLights(): void {
    const box = new THREE.Box3().setFromObject(this.machine.group);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const r = Math.max(size.x, size.y, size.z) * 0.75 + 50;
    this.ground.position.set(center.x, box.min.y - 0.5, center.z);
    this.ground.scale.set(r * 8, r * 8, 1);
    const k = this.keyLight;
    k.position.set(center.x + r * 0.9, center.y + r * 1.6, center.z + r * 1.1);
    k.target.position.copy(center);
    const sc = k.shadow.camera;
    sc.left = -r;
    sc.right = r;
    sc.top = r;
    sc.bottom = -r;
    sc.near = 1;
    sc.far = r * 6;
    sc.updateProjectionMatrix();
    this.camera3d.far = Math.max(20000, r * 30);
    this.camera3d.updateProjectionMatrix();
  }

  private loop = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (this.tween) {
      const t = this.tween;
      const k = Math.min(1, (now - t.t0) / t.dur);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.camera3d.position.lerpVectors(t.fromPos, t.toPos, e);
      this.controls.target.lerpVectors(t.fromTarget, t.toTarget, e);
      if (k >= 1) this.tween = null;
      this.needsRender = true;
    }
    if (this.machineRect && this.controls.update()) this.needsRender = true;
    if (this.machineRect && this.discDirty && now - this.discLast >= DISC_THROTTLE_MS) {
      this.updateDisc();
      this.discLast = now;
      this.needsRender = true;
    }
    if (this.needsRender) {
      this.needsRender = false;
      this.renderFrame();
    }
    this.onFrame?.();
  };

  /** Bring the 3D disc surface up to the current progress (incrementally when only new samples appeared). */
  private updateDisc(): void {
    const tp = this.toolpath;
    if (!tp || !this.recipe) return;
    const full = this.discDirty === 2 || this.progress < this.discProgress;
    const from = full ? -1 : this.discProgress;
    const pxPerMm = this.discRT.width / this.recipe.machine.workDiameter;
    if (this.mode === 'ink') {
      this.drawInk(this.discRT, this.discCam, pxPerMm, IDENTITY, from, this.progress, { clear: full, bg: full, shadow: 0, paperEverywhere: true });
    } else {
      this.drawGrooveInto(this.discRT, this.discCam, pxPerMm, IDENTITY, from, this.progress, full, false);
    }
    this.discProgress = this.progress;
    this.discDirty = 0;
  }

  private renderFrame(): void {
    const r = this.renderer;
    if (this.workRect && this.workDirty) this.updateWorkCache();

    r.setRenderTarget(null);
    r.setScissorTest(true);
    const m = this.machineRect;
    if (m) {
      r.setViewport(m.x, m.y, m.w, m.h);
      r.setScissor(m.x, m.y, m.w, m.h);
      r.setClearColor(BG_3D, 1);
      r.clear(true, true, true);
      r.render(this.scene3d, this.camera3d);
    }
    const w = this.workRect;
    if (w) {
      r.setViewport(w.x, w.y, w.w, w.h);
      r.setScissor(w.x, w.y, w.w, w.h);
      r.setClearColor(0x000000, 1);
      r.clear(true, true, true);
      if (this.mode === 'ink') {
        this.blitU.uTex.value = this.inkRT!.texture;
        r.render(this.blitScene, this.blitCam);
      } else {
        this.drawLit(null, this.work.camera, this.placement, { shadow: 1, transparent: false, surround: SURROUND_SRGB });
      }
      this.drawMarker();
    }
    r.setScissorTest(false);
  }

  private updateWorkCache(): void {
    const tp = this.toolpath;
    const cam = this.work.camera;
    const pxPerMm = this.work.pxPerMm;
    if (this.mode === 'ink') {
      const full = this.workDirty === 2 || !tp || this.progress < this.workCacheProgress;
      const from = full ? -1 : this.workCacheProgress;
      this.drawInk(this.inkRT!, cam, pxPerMm, this.placement, from, this.progress, { clear: full, bg: full, shadow: 1, paperEverywhere: false });
    } else {
      this.drawGroove(this.grooveRT!, cam, pxPerMm, this.placement, this.progress);
    }
    this.workCacheProgress = this.progress;
    this.workDirty = 0;
  }

  private setRange(from: number, to: number): void {
    if (!this.stroke) return;
    const rg = indexRange(this.stroke, from, to);
    this.stroke.geometry.setDrawRange(rg.start, rg.count);
  }

  private drawInk(
    target: THREE.WebGLRenderTarget | null,
    cam: THREE.Camera,
    pxPerMm: number,
    placement: Placement,
    from: number,
    to: number,
    o: { clear: boolean; bg: boolean; shadow: number; paperEverywhere: boolean },
  ): void {
    const r = this.renderer;
    this.inkLayer.place(placement);
    this.inkU.uPxPerMm.value = pxPerMm;
    this.inkU.uProgress.value = to;
    this.inkU.uProgressMin.value = from;
    this.inkU.uMinPx.value = 1;
    this.bgU.uPaperOn.value = 1;
    this.bgU.uShadow.value = o.shadow;
    this.bgU.uAlpha.value = 1;
    this.bgU.uCenter.value.set(placement.x, placement.y);
    if (o.paperEverywhere) this.bgU.uSurround.value.copy(this.bgU.uPaper.value);
    else this.bgU.uSurround.value.set(...SURROUND_SRGB);
    this.inkBgMesh.visible = o.bg;
    this.setRange(from, to);
    r.setRenderTarget(target);
    if (o.clear) {
      r.setClearColor(0x000000, 0);
      r.clear(true, true, true);
    }
    r.render(this.inkLayer.scene, cam);
    this.bgU.uSurround.value.set(...SURROUND_SRGB);
  }

  private drawGroove(target: THREE.WebGLRenderTarget, cam: THREE.Camera, pxPerMm: number, placement: Placement, to: number): void {
    this.drawGrooveInto(target, cam, pxPerMm, placement, -1, to, true, true);
  }

  private drawGrooveInto(
    target: THREE.WebGLRenderTarget,
    cam: THREE.Camera,
    pxPerMm: number,
    placement: Placement,
    from: number,
    to: number,
    full: boolean,
    mrt: boolean,
  ): void {
    const r = this.renderer;
    this.grooveLayer.place(placement);
    this.grooveU.uPxPerMm.value = pxPerMm;
    this.grooveU.uProgress.value = to;
    this.grooveU.uProgressMin.value = from;
    this.grooveStrokeMesh.material = mrt ? this.grooveMatMRT : this.grooveMat1;
    this.grooveBgMesh.material = mrt ? this.grooveBgMRT : this.grooveBg1;
    this.grooveBgMesh.visible = full;
    this.setRange(from, to);
    r.setRenderTarget(target);
    if (full) {
      r.setClearColor(0x8080ff, 0);
      r.clear(true, true, true);
    }
    r.render(this.grooveLayer.scene, cam);
  }

  private drawLit(
    target: THREE.WebGLRenderTarget | null,
    cam: THREE.OrthographicCamera,
    placement: Placement,
    o: { shadow: number; transparent: boolean; surround: [number, number, number] },
  ): void {
    const r = this.renderer;
    this.litLayer.place(placement);
    this.bgU.uPaperOn.value = 0;
    this.bgU.uShadow.value = o.shadow;
    this.bgU.uAlpha.value = 1;
    this.bgU.uCenter.value.set(placement.x, placement.y);
    this.bgU.uSurround.value.set(...o.surround);
    this.litBgMesh.visible = !o.transparent;
    // virtual eye above the work centre (view space) gives the flat view a natural sheen gradient
    const D = this.recipe?.machine.workDiameter ?? 100;
    cam.updateMatrixWorld();
    this.metalShared.uVirtualEye.value.set(placement.x, placement.y, 2.4 * D).applyMatrix4(cam.matrixWorldInverse);
    const dc = this.tmpV.set(placement.x, placement.y, 0).applyMatrix4(cam.matrixWorldInverse);
    this.metalShared.uDial.value.set(dc.x, dc.y, D / 2);
    r.setRenderTarget(target);
    if (target) {
      r.setClearColor(0x000000, 0);
      r.clear(true, true, true);
    }
    r.render(this.litLayer.scene, cam);
  }

  private drawMarker(): void {
    const tp = this.toolpath;
    const show = !!tp && !!this.stroke && tp.totalSamples > 0 && this.progress < tp.totalSamples;
    this.marker.visible = show;
    if (!show || !tp || !this.stroke) return;
    if (!pointAtSample(tp, this.stroke.passStart, this.progress, this.tmpP)) return;
    const p = this.placement;
    const c = Math.cos(p.rotation);
    const s = Math.sin(p.rotation);
    const x = c * this.tmpP.x - s * this.tmpP.y + p.x;
    const y = s * this.tmpP.x + c * this.tmpP.y + p.y;
    this.markerU.uCenter.value.set(x, y);
    this.markerU.uSizePx.value = 20;
    this.markerU.uSizeMm.value = 20 * this.dpr * this.work.mmPerPx;
    this.renderer.render(this.overlayScene, this.work.camera);
  }
}
