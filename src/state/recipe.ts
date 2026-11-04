// CONTRACT FILE — shared by every module. Change only with care; other code depends on these shapes.
// All lengths are millimetres, all user-facing angles are degrees.

export const RECIPE_VERSION = 1;

export type ProfileKind = 'sine' | 'convex' | 'concave' | 'flame' | 'square' | 'saw';
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
}

export interface MachineSettings {
  /** Base (mean) radius of the physical rosettes, mm. Used for the rubber envelope and the 3D model. */
  rosetteRadius: number;
  /** Radius of the rubber (roller follower), mm. 0 = knife edge, follows the profile exactly. */
  rubberRadius: number;
  /** Diameter of the workpiece (dial / paper disc), mm. */
  workDiameter: number;
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
  ink: InkSettings;
  metal: MetalSettings;
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
    mode: 'ink',
    machine: { rosetteRadius: 60, rubberRadius: 2, workDiameter: 100 },
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
    },
    eccentric: { enabled: false, offset: 0, angle: 0, divisions: 1, divisionStep: 0 },
    elliptical: { enabled: false, e: 0, angle: 0 },
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
  };
}

export function cloneRecipe(r: Recipe): Recipe {
  return structuredClone(r);
}
