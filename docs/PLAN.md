# Rose Engine Web Demo — Plan

## Context
Greenfield project in `/Users/pierre/Code/rose-engine` (empty). Goal: a browser demo of a rose engine lathe where the user sets up rosettes (cams) and machine values, then watches a 3D model of the machine trace the pattern while a flat work view shows the result. It needs a Random button, an **Ink** mode (colored pen on paper) and a **Metal** mode (engraved guilloché look), and exports to SVG, PNG, G-code and preset JSON/share URL.

Decisions made: Vite + TypeScript with no UI framework. Controls follow the real machine, with a Simple/Advanced toggle. A full 3D machine is built in Three.js. All four export formats.

## Architecture (one idea per layer)

1. **Engine (pure TS, no DOM).** Turns a recipe into a toolpath. This is the single source of truth: the drawing, the 3D animation and every export read from it.
2. **Stroke mesh.** One GPU ribbon geometry built from the toolpath. Each vertex holds position, cross-section `t∈[-1,1]`, tangent, width, depth, color and sequence index. Playback is a `uProgress` uniform, and the fragment shader discards anything past it, so nothing gets rebuilt during animation.
3. **Surfaces.** The same stroke mesh drawn with one of two materials:
   - *Ink*: colored strokes with alpha blending on a paper background. Pump modulates line width.
   - *Metal*: a groove pass writes normal (rgb) and height (a) into a render target. The depth test keeps the deepest cut, which matches how real engraving removes material. Lighting comes from `MeshPhysicalMaterial` (metalness 1, `normalMap`, anisotropy, RoomEnvironment PMREM). An optional translucent **enamel** layer is added via `onBeforeCompile` and darkens where the grooves are deeper.
4. **Views.** A single Three.js renderer with two scissor viewports:
   - *Machine (3D)*, using a perspective camera and OrbitControls.
   - *Work (flat)*, using an orthographic camera. It re-renders the strokes at screen resolution, so zooming stays sharp.

   The 3D workpiece disc samples a fixed 4096² render target of the same surface. Layout toggle: split / 3D only / work only.

## Machine model (`src/engine`)
- **Rosette**: `{lobes, amplitude mm, profile, phase°, axis: 'rock'|'pump'}`. Profiles: sine, convex, concave/cusp, flame, square, saw.
- **Rubber radius**: a roller follower that rounds off sharp profiles. Precompute a 4096-entry displacement table per rosette using the envelope max of `ρ(φ)cos(φ−θ)+√(r²−ρ²sin²(φ−θ))`.
- **Cutter/slide program**: start and end radius, number of passes, radial step, and a phase program per pass:
  - linear drift
  - alternate half-lobe every k passes (barleycorn/basket weave)
  - custom list
- Plus amplitude taper and spiral feed per rev.
- **Chucks**:
  - Eccentric: offset, angle, and divisions with a rotation step.
  - Elliptical: `x=(R+e)cosθ, y=(R−e)sinθ`.
- `poseAt(recipe, pass, θ)` returns spindle angle, rock offset, pump offset, slide radius and chuck state.
- `toolPoint(pose)` returns work-frame `(x, y, depth)`.
- Sampling covers the toolpath. The same `poseAt` drives the 3D animation, so the model and the drawing can't drift apart.
- Samples per rev = `clamp(maxLobes×48, 1024, 8192)`, auto-reduced to cap total samples at about 1.5M. Everything runs on the main thread, debounced to rAF. Move it to a worker only if profiling shows a need.

## 3D machine (`src/render/machine3d`)
- Procedural parts with no external assets: bed, rocking headstock on a pivot, spindle, and rosette stack.
- Rocking rosettes are `ExtrudeGeometry` built from the real profile function, so the cam you pick is the cam you see. Pumping rosettes are a face-cam BufferGeometry.
- Also: rubber on a stalk, slide rest with cross-slide, and a tool holder that swaps between pen (ink) and V-cutter (metal).
- Workpiece disc on the spindle nose that rotates with the spindle. This is authentic: the work turns and the tool stays still.
- PBR brass and steel, soft shadows.
- Camera presets: overview, rosette close-up, tool close-up.
- Work view toggle: *work frame* (pattern stays still, pen moves) or *machine frame* (work rotates).

## UI (`src/ui`)
- **Param schema** (`src/state/params.ts`): each param is defined once with key, label, unit, min/max/step, `simple: bool` and a random range. The panel, the randomizer and URL encoding are all generated from it.
- Left panel:
  - Rosette stack editor (add/remove, live profile thumbnail)
  - Slide program
  - Chucks
  - Mode (Ink | Metal) with mode-specific settings: palette, per-pass color cycle/gradient, paper color, line width / material (silver, gold, rose gold, brass, steel, blued), V-tool angle, light angle (drag on view), enamel color and opacity
- Bottom transport bar: play/pause, speed (1×–200×, Instant), scrub, pass counter.
- Top bar: Random, Mutate, Undo/Redo, Presets, Share, Export.
- Use the `frontend-design` skill when building the panel. Direction: an engraver's-workshop look with a dark panel and brass accents.

## Random (`src/engine/random.ts`)
- Seeded mulberry32. The seed shows in the UI and is stored in the URL.
- Weighted **pattern families**, each with ranges tuned to look good: barleycorn, basket weave, moiré wave, flame, eccentric rosace, elliptical, spiral.
- A lock toggle on each param keeps that value through Random.
- **Mutate** applies a small Gaussian nudge to unlocked params.
- Random history is reachable through undo/redo.

## Export (`src/export`)
- **SVG** (`svg.ts`):
  - mm units, with the viewBox centered on the work
  - one Inkscape layer per color (ink) or per pass group (metal), compatible with AxiDraw
  - Ramer–Douglas–Peucker simplification (default 0.01 mm)
  - recipe JSON embedded in `<metadata>`
- **PNG** (`png.ts`): render the current surface (lit metal or ink) into a render target at the chosen px size or mm+DPI, then `readPixels` → `toBlob`. Cap size at `MAX_RENDERBUFFER_SIZE`. Ink can have a transparent background.
- **G-code** (`gcode.ts`): `G21 G90`, with origin at center or bottom-left.
  - Two profiles:
    - *Pen plotter*: configurable pen up/down commands (servo `M3 S…` or Z)
    - *CNC engrave*: Z = base depth + pump modulation, plus safe Z and plunge/feed rates
  - Each closed loop starts at the point nearest the previous end.
  - Header/footer templates.
  - Shows stats: path length and estimated time.
- **Preset/share** (`preset.ts`, `state/url.ts`):
  - versioned JSON save/load
  - share URL in the hash: `CompressionStream('deflate-raw')` → base64url, no server
  - built-in presets in `src/presets/*.json`

## File layout
```
index.html  package.json  vite.config.ts (base: './')  tsconfig.json
src/main.ts
src/state/{recipe,params,store,url}.ts          # store = tiny observable + undo/redo
src/engine/{rosette,machine,chucks,simplify,random}.ts
src/render/{strokeMesh,playback,views}.ts
src/render/surfaces/{ink,metal}.ts  src/render/shaders/*.glsl
src/render/machine3d/{scene,parts,animate}.ts
src/export/{svg,png,gcode,preset}.ts
src/ui/{panel,transport,topbar,exportDialog}.ts  src/ui/controls/*.ts
src/presets/*.json
tests/engine/*.test.ts  tests/export/*.test.ts
```
Dependencies are `three` and `vitest` (dev) only.

## Milestones
1. **Core**: scaffold, engine, stroke mesh, flat Ink view (static), Simple panel → patterns visible.
2. **Playback and full machine**: progressive reveal, pen marker, transport, Advanced controls (pump, chucks, rubber, phase programs), presets.
3. **Random and sharing**: families, locks, seed, Mutate, undo/redo, URL share, JSON presets.
4. **Metal mode**: groove G-buffer, PBR, draggable light, enamel.
5. **3D machine**: procedural model, `poseAt` sync, split layout, camera presets.
6. **Exports**: SVG, PNG, G-code, export dialog with previews and stats.
7. **Polish**: responsive layout, keyboard-operable controls, performance pass, `npm run build` static deploy (works in a subfolder or iframe).

Later, not in v1: straight-line engine mode, custom rosette profile spline editor.

## Verification
- **Unit tests (vitest)**:
  - an n-lobe rosette gives n-fold symmetry
  - a phase shift of 360°/n is the identity
  - eccentric offset 0 and elliptical e=0 reduce to a circle
  - rubber radius 0 equals the raw profile
  - closed passes close
  - the same seed gives the same recipe
  - URL encode/decode round-trips
  - SVG path count equals pass count, and G-code XY stays within the work radius
- **Browser check** via the `webapp-testing` skill (Playwright) against `npm run dev`:
  - screenshot each mode and layout
  - run playback to the end
  - press Random 5× and confirm distinct, non-empty patterns
  - trigger each export and validate the files: SVG parses, PNG has the requested size, G-code has the right line count and bounds
- **Manual**: open the exported SVG in Inkscape and check layers and mm size. Load the G-code in an online G-code previewer and confirm it matches the on-screen pattern.
