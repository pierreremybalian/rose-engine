// Callbacks the UI needs from the rest of the app. Integration (src/main.ts) implements these;
// the UI never imports render/engine/export code directly.
import type { GcodeOptions, GcodeResult, SvgOptions } from '../export/types';
import type { PngOptions } from '../render/types';
import type { CameraPreset } from '../state/store';

export type MaybePromise<T> = T | Promise<T>;

/** Cheap summary of the current toolpath. Polled by the transport bar, so return a cached object. */
export interface ToolpathInfo {
  totalSamples: number;
  /** Total number of passes (all eccentric divisions). */
  passes: number;
  /** Sample index at which each pass starts, ascending (length = passes). */
  passStarts: ArrayLike<number>;
}

export interface PresetEntry {
  id: string;
  name: string;
}

export interface UIDeps {
  /** New random recipe (reads store.locks), pushed through store.setRecipe so it is undoable. */
  random(): MaybePromise<void>;
  /** Small nudge of unlocked params. */
  mutate(): MaybePromise<void>;
  /** Write the share URL and copy it to the clipboard. The UI shows "Link copied" on success. */
  share(): MaybePromise<void>;
  presets: PresetEntry[];
  loadPreset(id: string): MaybePromise<void>;
  getToolpathInfo(): ToolpathInfo | null;
  exportSVG(opts: SvgOptions): MaybePromise<void>;
  exportPNG(opts: PngOptions): MaybePromise<void>;
  /** Stats for the G-code that `exportGcode(opts)` would write. Called debounced while options change. */
  previewGcode(opts: GcodeOptions): MaybePromise<GcodeResult['stats'] | null>;
  exportGcode(opts: GcodeOptions): MaybePromise<void>;
  /** Download the current recipe as preset JSON. */
  savePreset(): MaybePromise<void>;
  /** Load preset JSON text (throw on invalid input; the UI shows the message). */
  loadPresetText(text: string): MaybePromise<void>;
  /** Re-frame the 3D camera on a preset: pressing the already-selected camera button after orbiting away. */
  resetCamera?(preset: CameraPreset): void;
}

export interface MountedUI {
  /** Empty element for the WebGL canvas. Fills the central viewport. */
  workViewport: HTMLElement;
  dispose(): void;
}
