// Orthographic flat work view: camera state plus wheel-zoom-around-cursor, drag pan, pinch and double-click reset.
import * as THREE from 'three';

const FIT_MARGIN = 1.08;

export class WorkView {
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1000);
  /** View centre in the display frame, mm. */
  cx = 0;
  cy = 0;
  /** mm per device pixel. */
  mmPerPx = 0.1;
  /** Viewport size in device pixels. */
  width = 1;
  height = 1;
  /** True until the user pans/zooms: resizes and diameter changes refit. */
  fitted = true;
  private diameter = 100;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; mx: number; my: number } | null = null;
  private readonly listeners: [string, EventListener, AddEventListenerOptions?][] = [];

  constructor(
    private readonly el: HTMLElement,
    private readonly onChange: () => void,
    private readonly onReset: () => void,
  ) {
    this.camera.position.set(0, 0, 100);
    this.listen('wheel', this.onWheel as EventListener, { passive: false });
    this.listen('pointerdown', this.onPointerDown as EventListener);
    this.listen('pointermove', this.onPointerMove as EventListener);
    this.listen('pointerup', this.onPointerUp as EventListener);
    this.listen('pointercancel', this.onPointerUp as EventListener);
    this.listen('dblclick', ((e: MouseEvent) => {
      e.preventDefault();
      this.onReset();
    }) as EventListener);
    el.style.cursor = 'grab';
    el.style.touchAction = 'none';
  }

  get pxPerMm(): number {
    return 1 / this.mmPerPx;
  }

  setViewport(w: number, h: number): void {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    if (this.fitted) this.fitValues();
    this.updateCamera();
  }

  setDiameter(d: number): void {
    this.diameter = d > 0 ? d : 100;
    if (this.fitted) {
      this.fitValues();
      this.updateCamera();
    }
  }

  fit(): void {
    this.fitted = true;
    this.fitValues();
    this.updateCamera();
    this.onChange();
  }

  private fitValues(): void {
    this.cx = 0;
    this.cy = 0;
    this.mmPerPx = (this.diameter * FIT_MARGIN) / Math.min(this.width, this.height);
  }

  updateCamera(): void {
    const hw = (this.width / 2) * this.mmPerPx;
    const hh = (this.height / 2) * this.mmPerPx;
    const c = this.camera;
    c.left = -hw;
    c.right = hw;
    c.top = hh;
    c.bottom = -hh;
    c.position.set(this.cx, this.cy, 100);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
  }

  /** Device px per CSS px of the overlay element. */
  private ratio(): number {
    const cw = this.el.clientWidth;
    return cw > 0 ? this.width / cw : window.devicePixelRatio || 1;
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    const k = this.ratio();
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  }

  private zoomAt(px: number, py: number, factor: number): void {
    const minMm = 2e-5;
    const maxMm = (this.diameter * 4) / Math.min(this.width, this.height);
    const next = THREE.MathUtils.clamp(this.mmPerPx / factor, minMm, maxMm);
    // display-frame point under the cursor stays put
    const wx = this.cx + (px - this.width / 2) * this.mmPerPx;
    const wy = this.cy - (py - this.height / 2) * this.mmPerPx;
    this.mmPerPx = next;
    this.cx = wx - (px - this.width / 2) * next;
    this.cy = wy + (py - this.height / 2) * next;
    this.fitted = false;
    this.updateCamera();
    this.onChange();
  }

  /** Zoom by a factor around the viewport centre (used by tests and the harness). */
  zoom(factor: number, px = this.width / 2, py = this.height / 2): void {
    this.zoomAt(px, py, factor);
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= 100;
    const k = e.ctrlKey ? 0.01 : 0.0015; // ctrl+wheel = trackpad pinch
    const p = this.local(e);
    this.zoomAt(p.x, p.y, Math.exp(-dy * k));
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.el.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this.local(e));
    this.el.style.cursor = 'grabbing';
    if (this.pointers.size === 2) this.pinch = this.pinchState();
  };

  private onPointerMove = (e: PointerEvent): void => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const p = this.local(e);
    if (this.pointers.size === 1) {
      this.cx -= (p.x - prev.x) * this.mmPerPx;
      this.cy += (p.y - prev.y) * this.mmPerPx;
      this.pointers.set(e.pointerId, p);
      this.fitted = false;
      this.updateCamera();
      this.onChange();
      return;
    }
    this.pointers.set(e.pointerId, p);
    const now = this.pinchState();
    if (this.pinch && now) {
      this.cx -= (now.mx - this.pinch.mx) * this.mmPerPx;
      this.cy += (now.my - this.pinch.my) * this.mmPerPx;
      this.zoomAt(now.mx, now.my, now.dist / Math.max(1, this.pinch.dist));
    }
    this.pinch = now;
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
    this.pinch = this.pointers.size === 2 ? this.pinchState() : null;
    if (this.pointers.size === 0) this.el.style.cursor = 'grab';
  };

  private pinchState(): { dist: number; mx: number; my: number } | null {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return null;
    const [a, b] = pts;
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  private listen(type: string, fn: EventListener, opts?: AddEventListenerOptions): void {
    this.el.addEventListener(type, fn, opts);
    this.listeners.push([type, fn, opts]);
  }

  dispose(): void {
    for (const [t, fn, o] of this.listeners) this.el.removeEventListener(t, fn, o);
    this.listeners.length = 0;
  }
}
