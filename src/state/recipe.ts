// CONTRACT FILE — shared by every module. Change only with care; other code depends on these shapes.
// All lengths are millimetres, all user-facing angles are degrees.

export const RECIPE_VERSION = 4;

export type ProfileKind = 'sine' | 'convex' | 'concave' | 'flame' | 'square' | 'saw' | 'triangle';
/** 'rock' = rosette pushes the headstock sideways (radial modulation of the cut).
 *  'pump' = face rosette pushes the headstock along the spindle axis (depth / pen-width modulation). */
export type RosetteAxis = 'rock' | 'pump';
export type Mode = 'ink' | 'metal';

export interface Rosette {
  id: string;
  enabled: boolean;
  axis: RosetteAxis;
  /** Integer >= 1: number of bumps per revolution. */
  lobes: number;
  /** Peak displacement in mm: displacement = amplitude * profile(u), profile in [-1, 1]. */
  amplitude: number;
  profile: ProfileKind;
  /** Rotation of this rosette relative to the spindle, degrees. */
  phase: number;
  /** Lobe count at the last pass (0 or absent = no morph). Each pass uses lerp(lobes, lobesEnd, f) rounded to a multiple of
   *  gcd(lobes, lobesEnd), so every ring stays closed, the count steps between rings and shared symmetry is kept. */
  lobesEnd?: number;
}

export interface MachineSettings {
  /** Base (mean) radius of the physical rosettes, mm. Used for the rubber envelope and the 3D model. */
  rosetteRadius: number;
  /** Radius of the rubber (roller follower), mm. 0 = knife edge, follows the profile exactly. */
  rubberRadius: number;
  /** Diameter of the workpiece (dial / paper disc), mm. */
  workDiameter: number;
  /** Run the cut out past the plate edge so the whole plate is engraved. The engine then ignores
   *  slide.endRadius and uses effectiveEndRadius() (src/engine/plate.ts); everything is clipped at the plate edge. */
  fillEdge: boolean;
}

export type PhaseMode = 'linear' | 'alternate' | 'custom';

export interface SlideProgram {
  /** Radius of the first pass, mm (distance of tool from spindle axis). */
  startRadius: number;
  /** Radius of the last pass, mm. Step = (end - start) / (passes - 1). */
  endRadius: number;
  /** Integer >= 1. */
  passes: number;
  phaseMode: PhaseMode;
  /** linear: spindle-degrees added per pass (applies to all rosettes). */
  phaseStep: number;
  /** alternate: passes per group; odd-numbered groups get the offset. */
  alternateEvery: number;
  /** alternate: offset as a fraction of ONE LOBE of each rosette (0.5 = half lobe → barleycorn). */
  alternateFraction: number;
  /** custom: spindle-degree offsets cycled per pass. */
  phaseCustom: number[];
  /** Amplitude multiplier reached at the last pass (1 = constant), linear from 1 at pass 0. */
  amplitudeTaper: number;
  /** true = radius ramps continuously; all passes join into one open spiral path. */
  spiral: boolean;
  /** Cut from the end radius back to the start (rim to centre) instead of start to end. Concentric and straight
   *  passes are the same cuts in reverse order; a spiral feeds inward. */
  inward: boolean;
}

export interface EccentricChuck {
  enabled: boolean;
  /** Distance of work centre from spindle axis, mm. */
  offset: number;
  /** Direction of the offset in the work frame, degrees. */
  angle: number;
  /** Integer >= 1: the whole slide program is repeated this many times... */
  divisions: number;
  /** ...rotating the work about its own centre by this many degrees each time. */
  divisionStep: number;
}

export interface EllipticalChuck {
  enabled: boolean;
  /** mm: a circle of radius R becomes an ellipse with semi-axes R+e and R-e. */
  e: number;
  /** Orientation of the major axis, degrees. */
  angle: number;
}

/**
 * Straight-line engine. When enabled it replaces the rose engine's spindle: every pass is a straight line across the
 * plate instead of a ring. The rosettes become pattern bars (lobes = bumps across the plate diameter) and the slide
 * program steps the line sideways, from -end to +end radius (start radius is not used). The eccentric and elliptical
 * chucks are not used. Crossings repeat the whole program at evenly spaced (or crossAngle-spaced) line angles:
 * 1 = parallel lines (pinstripe, straight waves), 2 at 90° = a square grid (Clous de Paris, tapisserie).
 */
export interface StraightLine {
  enabled: boolean;
  /** Direction of the first set of lines, degrees (0 = horizontal, along 3–9). */
  angle: number;
  /** Integer >= 1: number of line sets. */
  crossings: number;
  /** Angle between successive sets, degrees. 0 = evenly spaced (180° / crossings). */
  crossAngle: number;
}

/**
 * Shape mask: a polar curve r(θ) = radius + amplitude·profile(lobes·(θ − angle)/2π) on the plate (work frame, centred).
 * Inside it (soft edge `edge` mm wide) the cut goes `depth` mm deeper and every rosette is turned `phase` lobes on.
 * A depth mask reveals a pattern only inside the shape; a half-lobe phase flips the facets so the shape only shows
 * when the light or the dial moves.
 */
export interface Mask {
  enabled: boolean;
  /** Mean radius of the shape, mm. */
  radius: number;
  /** Integer >= 1: points of the shape (a star with lobes = 5). */
  lobes: number;
  /** mm: how far the points stand out from the mean radius (0 = circle). */
  amplitude: number;
  profile: ProfileKind;
  /** Direction of the first point, degrees (90 = 12 o'clock). */
  angle: number;
  /** Width of the soft edge, mm. */
  edge: number;
  /** Extra cut depth inside, mm (negative = shallower). */
  depth: number;
  /** Extra phase inside, in lobes of each rosette (0.5 = half a lobe: facets flipped). */
  phase: number;
}

/**
 * An extra cut on the same plate, made after the base cut (the recipe's own rosettes / slide / chucks). Plate, ink,
 * metal finish, tool angle and symmetry are shared. Overlapping cuts resolve as real metal does: the deepest wins.
 */
export interface Layer {
  /** Unique across the recipe. */
  id: string;
  enabled: boolean;
  rosettes: Rosette[];
  slide: SlideProgram;
  straight: StraightLine;
  eccentric: EccentricChuck;
  elliptical: EllipticalChuck;
  /** Nominal cut depth of this cut, mm (the base cut uses metal.baseDepth). */
  depth: number;
  mask: Mask;
}

/** Pattern symmetry constraint. Enforced by enforceSymmetry() (src/engine/symmetry.ts) on UI edits and Random/Mutate. */
export interface Symmetry {
  /** 0 = free (readout only). N >= 2 = N-fold rotational symmetry: lobe counts are multiples of N; eccentric
   *  divisions are evenly spaced and divide N on centred work, or are a multiple of N when the work is off-centre. */
  order: number;
  /** Mirror symmetry about the 12-6 axis: symmetric profiles, peaks on 12 o'clock (phase ≡ 270 mod 360/lobes),
   *  no twisting phase drift. */
  mirror: boolean;
}

export type ColorMode = 'single' | 'cycle' | 'gradient';

export interface InkSettings {
  /** CSS hex colours. */
  palette: string[];
  colorMode: ColorMode;
  paper: string;
  /** Nominal pen width, mm. */
  lineWidth: number;
  /** 0..1 */
  opacity: number;
}

export type MetalKind = 'silver' | 'gold' | 'rose' | 'brass' | 'steel' | 'blued';

export interface MetalSettings {
  material: MetalKind;
  /** Included angle of the V cutter, degrees (90..150). Groove width = 2 * depth * tan(angle/2). */
  toolAngle: number;
  /** Nominal cut depth, mm; pump displacement is added to this. */
  baseDepth: number;
  /** Light azimuth, degrees. */
  lightAngle: number;
  /** Light elevation, degrees above the work plane. */
  lightElevation: number;
  enamel: boolean;
  enamelColor: string;
  /** 0..1 */
  enamelOpacity: number;
}

export interface Recipe {
  version: number;
  name: string;
  /** Seed that produced this recipe via Random (0 if hand-made). */
  seed: number;
  mode: Mode;
  machine: MachineSettings;
  rosettes: Rosette[];
  slide: SlideProgram;
  eccentric: EccentricChuck;
  elliptical: EllipticalChuck;
  straight: StraightLine;
  /** Shape mask of the base cut. */
  mask: Mask;
  ink: InkSettings;
  metal: MetalSettings;
  symmetry: Symmetry;
  /** Extra cuts, in cutting order after the base cut. */
  layers: Layer[];
}

export function defaultMask(): Mask {
  return { enabled: false, radius: 15, lobes: 5, amplitude: 6, profile: 'triangle', angle: 90, edge: 0.5, depth: 0, phase: 0 };
}

let idCounter = 0;
export function newRosetteId(): string {
  idCounter += 1;
  return `r${Date.now().toString(36)}${idCounter}`;
}

export function defaultRosette(partial: Partial<Rosette> = {}): Rosette {
  return {
    id: newRosetteId(),
    enabled: true,
    axis: 'rock',
    lobes: 12,
    amplitude: 1.2,
    profile: 'sine',
    phase: 0,
    ...partial,
  };
}

/** A classic barleycorn: 12-lobe sine rosette, half-lobe phase alternation every pass. */
export function defaultRecipe(): Recipe {
  return {
    version: RECIPE_VERSION,
    name: 'Barleycorn',
    seed: 0,
    mode: 'metal',
    machine: { rosetteRadius: 60, rubberRadius: 2, workDiameter: 100, fillEdge: false },
    rosettes: [defaultRosette({ id: 'r0' })],
    slide: {
      startRadius: 0,
      endRadius: 46,
      passes: 48,
      phaseMode: 'alternate',
      phaseStep: 0,
      alternateEvery: 1,
      alternateFraction: 0.5,
      phaseCustom: [0, 7.5],
      amplitudeTaper: 1,
      spiral: false,
      inward: false,
    },
    eccentric: { enabled: false, offset: 0, angle: 0, divisions: 1, divisionStep: 0 },
    elliptical: { enabled: false, e: 0, angle: 0 },
    straight: { enabled: false, angle: 0, crossings: 1, crossAngle: 0 },
    ink: {
      palette: ['#1d2a5c', '#b0303a', '#2f6b4f'],
      colorMode: 'single',
      paper: '#f4efe4',
      lineWidth: 0.25,
      opacity: 0.9,
    },
    metal: {
      material: 'silver',
      toolAngle: 120,
      baseDepth: 0.08,
      lightAngle: 35,
      lightElevation: 40,
      enamel: false,
      enamelColor: '#1b3fa0',
      enamelOpacity: 0.6,
    },
    symmetry: { order: 0, mirror: false },
    mask: defaultMask(),
    layers: [],
  };
}

export function newLayerId(): string {
  idCounter += 1;
  return `l${Date.now().toString(36)}${idCounter}`;
}

/** A new cut copied from the base cut of `r` (fresh ids), cut at `depth`. */
export function layerFromBase(r: Recipe, depth: number): Layer {
  return {
    id: newLayerId(),
    enabled: true,
    rosettes: r.rosettes.map((x) => ({ ...x, id: newRosetteId() })),
    slide: structuredClone(r.slide),
    straight: { ...r.straight },
    eccentric: { ...r.eccentric },
    elliptical: { ...r.elliptical },
    depth,
    mask: { ...r.mask },
  };
}

export function cloneRecipe(r: Recipe): Recipe {
  return structuredClone(r);
}
