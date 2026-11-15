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
  /** View state: the cut the panel edits. 0 = the base cut, i + 1 = recipe.layers[i]. Not in undo history. */
  editCut: number;
}

/** Recipe groups that belong to a cut (base cut at the top level, extra cuts under layers.<i>). */
export const CUT_GROUPS: ReadonlySet<string> = new Set(['rosettes', 'slide', 'straight', 'eccentric', 'elliptical', 'mask']);

/** Recipe path of `key` ('slide.passes', 'rosettes', ...) in cut `cut`. Keys outside CUT_GROUPS are shared by every cut. */
export function cutPath(key: string, cut: number): string {
  if (cut <= 0 || !CUT_GROUPS.has(key.split('.', 1)[0])) return key;
  return `layers.${cut - 1}.${key}`;
}

/** Recipe path of a cut's depth: metal.baseDepth for the base cut, layers.<i>.depth for the others. */
export function cutDepthPath(cut: number): string {
  return cut <= 0 ? 'metal.baseDepth' : `layers.${cut - 1}.depth`;
}

/** A valid editCut for `r`: cuts that no longer exist fall back to the base cut. */
export function clampEditCut(r: Recipe, cut: number): number {
  const n = Math.round(cut);
  return n >= 1 && n <= (r.layers?.length ?? 0) ? n : 0;
}

/**
 * The cut to keep editing when the recipe changes from `prev` to `next`: the same layer (by id) wherever it moved,
 * or the base cut when it is gone (deleted, or a different recipe loaded).
 */
export function remapEditCut(prev: Recipe, next: Recipe, cut: number): number {
  if (cut <= 0) return 0;
  const id = prev.layers?.[cut - 1]?.id;
  if (id === undefined) return clampEditCut(next, cut);
  const i = (next.layers ?? []).findIndex((l) => l.id === id);
  return i < 0 ? 0 : i + 1;
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
      editCut: 0,
      ...initial,
    };
    this.state.editCut = clampEditCut(this.state.recipe, this.state.editCut);
  }

  get(): AppState {
    return this.state;
  }

  /** Shallow-merge a patch into state. Use setRecipe for recipe edits so they enter undo history. */
  set(patch: Partial<AppState>): void {
    const prev = this.state;
    const next = { ...prev, ...patch };
    next.editCut = patch.recipe && patch.recipe !== prev.recipe && patch.editCut === undefined ? remapEditCut(prev.recipe, next.recipe, prev.editCut) : clampEditCut(next.recipe, next.editCut);
    this.state = next;
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
    this.state = this.withRecipe(prev, recipe);
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
    this.state = this.withRecipe(prev, r);
    this.emit(prev);
  }
  redo(): void {
    const r = this.future.pop();
    if (!r) return;
    this.past.push(this.state.recipe);
    this.coalescing = false;
    const prev = this.state;
    this.state = this.withRecipe(prev, r);
    this.emit(prev);
  }

  private withRecipe(prev: AppState, recipe: Recipe): AppState {
    return { ...prev, recipe, editCut: remapEditCut(prev.recipe, recipe, prev.editCut), playback: { ...prev.playback, progress: 0 } };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(prev: AppState): void {
    for (const l of this.listeners) l(this.state, prev);
  }
}
