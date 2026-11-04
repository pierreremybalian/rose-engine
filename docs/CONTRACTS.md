# Module contracts

Read `docs/PLAN.md` for the design. This file lists who owns what, plus the exports each module must provide.
Several agents work in this repo **at the same time**. Only edit files you own. If you need a change to a contract file, don't make it yourself; describe the change in your final report.

## Contract files (read-only for module agents)
- `src/state/recipe.ts`: Recipe types, `defaultRecipe()`, `defaultRosette()`, `cloneRecipe()`
- `src/state/params.ts`: `PARAMS`, `ROSETTE_PARAMS`, `PALETTES`, `getPath`, `setPath`, `clampParam`
- `src/state/store.ts`: `Store`, `AppState`, `Layout`, `WorkFrame`, `CameraPreset`
- `src/engine/types.ts`: `Toolpath`, `Pass`, `Pose`, `Prepared`, plus coordinate conventions
- `src/render/types.ts`: `IRenderApp`, `IMachineModel`, `PngOptions`, plus the disc UV convention
- `src/export/types.ts`: `SvgOptions`, `GcodeOptions`, `GcodeResult`, defaults
- `src/state/colors.ts`: `passColor(ink, passIndex, totalPasses)`. The ink renderer and the SVG export must both use it.

## Semantics notes
- `eccentric.divisionStep === 0` means evenly spaced: 360° / divisions.
- For spiral recipes, each eccentric division is one open stroke, and `poseAt`'s theta runs from 0 to 2π·slide.passes inside that stroke.
- Eccentric: the work centre sits `offset` mm from the spindle axis (direction `angle`, in the work frame). The work is then turned by the division angle about its own centre.

## Required exports per module

### Engine: `src/engine/*` (owner: engine agent)
```ts
// rosette.ts (profileValue + rosetteRadiusAt already exist, so keep their signatures)
// machine.ts
export function prepare(recipe: Recipe): Prepared;
export function poseAt(prepared: Prepared, pass: number, theta: number): Pose;      // pass = global pass index, theta = radians within the pass
export function toolPoint(prepared: Prepared, pose: Pose): { x: number; y: number; z: number };
export function computeToolpath(prepared: Prepared): Toolpath;
export function poseAtSample(prepared: Prepared, toolpath: Toolpath, sample: number): Pose; // float sample → interpolated pose
// chucks.ts: eccentric / elliptical transforms (internal API, your choice)
// simplify.ts
export function simplifyPolyline(xs: ArrayLike<number>, ys: ArrayLike<number>, start: number, count: number, tolerance: number, closed: boolean): number[]; // returns kept sample indices (absolute)
// index.ts re-exports all of the above
```

### Random / presets / URL: `src/engine/random.ts`, `src/state/url.ts`, `src/export/preset.ts`, `src/presets/*` (owner: random agent)
```ts
export function mulberry32(seed: number): () => number;
export function randomRecipe(seed: number, current: Recipe, locks: string[]): Recipe;
export function mutateRecipe(current: Recipe, seed: number, locks: string[], amount?: number): Recipe;
export const FAMILIES: { id: string; label: string; weight: number }[];
// state/url.ts
export async function encodeRecipe(recipe: Recipe): Promise<string>;           // base64url(deflate-raw(JSON))
export async function decodeRecipe(s: string): Promise<Recipe | null>;
export async function readRecipeFromHash(): Promise<Recipe | null>;            // reads location.hash '#r=...'
export async function writeRecipeToHash(recipe: Recipe): Promise<void>;        // history.replaceState
// export/preset.ts
export function serializePreset(recipe: Recipe): string;                       // pretty JSON with version
export function parsePreset(text: string): Recipe;                             // validates + migrates + fills defaults; throws on garbage
// presets/index.ts
export const PRESETS: { id: string; name: string; recipe: Recipe }[];
```

### Render: `src/render/{strokeMesh,playback,views}.ts`, `src/render/surfaces/*`, `src/render/shaders/*` (owner: render agent)
```ts
export class RenderApp implements IRenderApp { constructor(container: HTMLElement, opts: { machine: IMachineModel; onFrame?: () => void }); }
// playback.ts: a Clock that advances progress by speed (revs/sec × samplesPerRev) and reports to the store
export class Playback { constructor(store: Store, getToolpath: () => Toolpath | null); start(): void; stop(): void; }
```
The machine model is **injected**: render code must NOT import `src/render/machine3d`. `main.ts` passes `createMachineModel()`. Dev harnesses can pass a stub.

### 3D machine: `src/render/machine3d/*` (owner: machine3d agent)
```ts
export function createMachineModel(): IMachineModel;
```

### Export: `src/export/{svg,gcode,png,download}.ts` (owner: export agent)
```ts
export function buildSVG(recipe: Recipe, toolpath: Toolpath, opts: SvgOptions): string;
export function buildGcode(recipe: Recipe, toolpath: Toolpath, opts: GcodeOptions): GcodeResult;
export async function exportPNG(app: IRenderApp, opts: PngOptions): Promise<Blob>;
export function downloadBlob(blob: Blob, filename: string): void;
export function downloadText(text: string, filename: string, mime: string): void;
```

### UI: `src/ui/*`, `src/styles/*` (owner: UI agent)
```ts
export function mountUI(root: HTMLElement, store: Store, deps: UIDeps): { workViewport: HTMLElement; dispose(): void };
// UIDeps (defined in src/ui/types.ts by the UI agent): callbacks for random, mutate, share, preset load/save,
// export SVG/PNG/G-code, plus a getter for the current toolpath (for export stats). UI must not import render/engine internals directly.
```
Styling: **Tailwind v4** (`@tailwindcss/vite`, entry `src/styles/main.css` with `@import "tailwindcss"` and `@theme` tokens) for layout and utilities in markup, plus **SCSS** (`src/styles/**/*.scss`, using `@use`) for component styles that utilities can't express cleanly (range sliders, custom scrollbars, dialogs, keyframes). Tailwind v4 can't process `.scss` files, so keep the Tailwind entry as `.css` and have SCSS read theme tokens through CSS variables (`var(--color-brass)`).

### Integration (`src/main.ts`, `index.html`): done after the module agents finish.

## Dev harness pages
Each agent can run its own page while working: `dev/<area>.html` + `dev/<area>.ts` (Vite serves any html under root).
Use your assigned port: `npx vite --port <PORT> --strictPort`. Kill the server when you're done.
Screenshots: the `playwright` npm package is installed (Node). Write scripts in `dev/` and save images to `dev/screenshots/` (gitignored).

## Checks
- `npx vitest run tests/<your-area>`: run only your own tests.
- `npx tsc --noEmit`: other agents' files may be mid-edit, so only fix errors in files you own.
