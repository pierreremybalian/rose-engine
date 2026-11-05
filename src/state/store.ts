// CONTRACT FILE — tiny observable app store with undo/redo for recipe changes.
import { cloneRecipe, defaultRecipe, type Recipe } from './recipe';

export type Layout = 'split' | 'machine' | 'work';
export type WorkFrame = 'work' | 'machine';
export type UiMode = 'simple' | 'advanced';
export type CameraPreset = 'overview' | 'rosette' | 'tool';

/** Plate tilt in the flat work view, degrees: x turns the plate about the screen's horizontal axis, y about its vertical axis. */
export interface Tilt {
  x: number;
  y: number;
}

export interface PlaybackState {
  playing: boolean;
  /** Spindle revolutions per second (1 = real-ish speed). 0 = instant. */
  speed: number;
  /** Number of toolpath samples revealed, 0..toolpath.totalSamples. Float allowed. */
  progress: number;
}

export interface AppState {
  recipe: Recipe;
  /** Param keys locked against Random/Mutate. Recipe paths ('slide.passes') or 'rosettes.<id>.<key>' or 'rosettes' (whole stack). */
  locks: string[];
  layout: Layout;
  frame: WorkFrame;
  uiMode: UiMode;
  camera: CameraPreset;
  playback: PlaybackState;
  /** View state (not in the recipe, history or share URL): the plate held at an angle in the work view. */
  tilt: Tilt;
  /** Slow automatic rocking of the tilted plate so the light plays across the cuts. */
  shimmer: boolean;
}

type Listener = (state: AppState, prev: AppState) => void;

const HISTORY_LIMIT = 100;

export class Store {
  private state: AppState;
  private listeners = new Set<Listener>();
  private past: Recipe[] = [];
  private future: Recipe[] = [];

  constructor(initial?: Partial<AppState>) {
    this.state = {
      recipe: defaultRecipe(),
      locks: [],
      layout: 'split',
      frame: 'work',
      uiMode: 'simple',
      camera: 'overview',
      playback: { playing: false, speed: 1, progress: 0 },
      tilt: { x: 0, y: 0 },
      shimmer: false,
      ...initial,
    };
  }

  get(): AppState {
    return this.state;
  }

  /** Shallow-merge a patch into state. Use setRecipe for recipe edits so they enter undo history. */
  set(patch: Partial<AppState>): void {
    const prev = this.state;
    this.state = { ...prev, ...patch };
    this.emit(prev);
  }

  /**
   * Replace the recipe. `history: true` (default) pushes the old recipe onto the undo stack.
   * Pass `coalesce: true` while a slider is being dragged so one drag = one undo step
   * (the first call of a drag pushes history; following calls with coalesce don't).
   */
  setRecipe(next: Recipe | ((draft: Recipe) => void), opts: { history?: boolean; coalesce?: boolean } = {}): void {
    const prev = this.state;
    let recipe: Recipe;
    if (typeof next === 'function') {
      recipe = cloneRecipe(prev.recipe);
      next(recipe);
    } else {
      recipe = next;
    }
    const history = opts.history ?? true;
    if (history && !(opts.coalesce && this.coalescing)) {
      this.past.push(prev.recipe);
      if (this.past.length > HISTORY_LIMIT) this.past.shift();
      this.future = [];
    }
    this.coalescing = !!opts.coalesce;
    this.state = { ...prev, recipe, playback: { ...prev.playback, progress: 0 } };
    this.emit(prev);
  }
  private coalescing = false;

  /** Call when a drag ends so the next edit starts a new undo step. */
  endCoalesce(): void {
    this.coalescing = false;
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }
  canRedo(): boolean {
    return this.future.length > 0;
  }
  undo(): void {
    const r = this.past.pop();
    if (!r) return;
    this.future.push(this.state.recipe);
    this.coalescing = false;
    const prev = this.state;
    this.state = { ...prev, recipe: r, playback: { ...prev.playback, progress: 0 } };
    this.emit(prev);
  }
  redo(): void {
    const r = this.future.pop();
    if (!r) return;
    this.past.push(this.state.recipe);
    this.coalescing = false;
    const prev = this.state;
    this.state = { ...prev, recipe: r, playback: { ...prev.playback, progress: 0 } };
    this.emit(prev);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(prev: AppState): void {
    for (const l of this.listeners) l(this.state, prev);
  }
}
