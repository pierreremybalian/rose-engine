// CONTRACT FILE — single param schema. The UI panel, the randomizer and lock toggles are all driven from it.
import type { Mode, Recipe, Rosette } from './recipe';
import { maxUsefulRadius } from '../engine/plate';

export type ParamGroup = 'plate' | 'machine' | 'slide' | 'eccentric' | 'elliptical' | 'ink' | 'metal';
export type ParamType = 'number' | 'int' | 'bool' | 'select' | 'color';

export interface ParamDef {
  /** Dot path into Recipe (e.g. 'slide.passes') or, for ROSETTE_PARAMS, into a Rosette (e.g. 'lobes'). */
  key: string;
  label: string;
  group: ParamGroup;
  type: ParamType;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  /** Shown in Simple view. Advanced view shows everything. */
  simple: boolean;
  /** Only shown in these modes (omit = all modes). */
  modes?: Mode[];
  /** Only shown when this predicate holds (e.g. eccentric params only when enabled). */
  visible?: (r: Recipe) => boolean;
  /** Range used by Random/Mutate for numeric params. Omit = Random leaves it to the pattern family. */
  random?: [number, number];
  help?: string;
  /** Recipe-dependent limits that override min/max/step (e.g. radius limits follow the plate size,
   *  lobe steps follow the symmetry order). Read limits through resolveParam(def, recipe). */
  dynamic?: (r: Recipe) => { min?: number; max?: number; step?: number };
}

const phaseIs = (m: Recipe['slide']['phaseMode']) => (r: Recipe) => r.slide.phaseMode === m;

export const PARAMS: ParamDef[] = [
  // Machine
  // Plate
  { key: 'machine.workDiameter', label: 'Plate size', group: 'plate', type: 'number', unit: 'mm', min: 20, max: 300, step: 1, simple: true, help: 'Diameter of the dial or paper disc. Watch dials are about 28–42 mm.' },
  { key: 'machine.fillEdge', label: 'Fill to edge', group: 'plate', type: 'bool', simple: true, help: 'Run the cut out past the rim so the whole plate is engraved.' },
  { key: 'symmetry.order', label: 'Symmetry', group: 'plate', type: 'int', min: 0, max: 96, step: 1, simple: true, help: '0 = free. N keeps the pattern N-fold symmetric: lobe counts snap to multiples of N.' },
  { key: 'symmetry.mirror', label: 'Mirror', group: 'plate', type: 'bool', simple: true, visible: (r) => r.symmetry.order >= 2, help: 'Mirror-symmetric about 12–6: symmetric profiles, peaks on 12 o’clock, no twist.' },

  // Machine
  { key: 'machine.rosetteRadius', label: 'Rosette radius', group: 'machine', type: 'number', unit: 'mm', min: 30, max: 120, step: 1, simple: false, help: 'Mean radius of the cams. Matters for how the rubber rides sharp profiles.' },
  { key: 'machine.rubberRadius', label: 'Rubber radius', group: 'machine', type: 'number', unit: 'mm', min: 0, max: 12, step: 0.1, simple: false, random: [0, 6], help: 'Bigger rubbers round off sharp rosette points.' },

  // Slide (cutter) program
  { key: 'slide.passes', label: 'Passes', group: 'slide', type: 'int', min: 1, max: 300, step: 1, simple: true, random: [12, 120] },
  { key: 'slide.startRadius', label: 'Start radius', group: 'slide', type: 'number', unit: 'mm', min: 0, max: 150, step: 0.1, simple: true, random: [0, 20], dynamic: (r) => ({ max: maxUsefulRadius(r) }) },
  { key: 'slide.endRadius', label: 'End radius', group: 'slide', type: 'number', unit: 'mm', min: 0.5, max: 150, step: 0.1, simple: true, random: [25, 48], visible: (r) => !r.machine.fillEdge, dynamic: (r) => ({ max: maxUsefulRadius(r) }) },
  {
    key: 'slide.phaseMode', label: 'Phasing', group: 'slide', type: 'select', simple: true,
    options: [
      { value: 'linear', label: 'Drift (linear)' },
      { value: 'alternate', label: 'Alternate (barleycorn / weave)' },
      { value: 'custom', label: 'Custom sequence' },
    ],
  },
  { key: 'slide.phaseStep', label: 'Phase per pass', group: 'slide', type: 'number', unit: '°', min: -30, max: 30, step: 0.1, simple: true, visible: phaseIs('linear'), random: [-6, 6] },
  { key: 'slide.alternateEvery', label: 'Alternate every', group: 'slide', type: 'int', unit: 'passes', min: 1, max: 20, step: 1, simple: true, visible: phaseIs('alternate'), random: [1, 6] },
  { key: 'slide.alternateFraction', label: 'Offset', group: 'slide', type: 'number', unit: 'lobe', min: 0, max: 1, step: 0.01, simple: false, visible: phaseIs('alternate'), random: [0.25, 0.75] },
  { key: 'slide.amplitudeTaper', label: 'Amplitude taper', group: 'slide', type: 'number', unit: '×', min: 0, max: 3, step: 0.01, simple: false, random: [0.3, 1.8] },
  { key: 'slide.spiral', label: 'Spiral (continuous feed)', group: 'slide', type: 'bool', simple: false },

  // Eccentric chuck
  { key: 'eccentric.enabled', label: 'Eccentric chuck', group: 'eccentric', type: 'bool', simple: false },
  { key: 'eccentric.offset', label: 'Offset', group: 'eccentric', type: 'number', unit: 'mm', min: 0, max: 60, step: 0.1, simple: false, visible: (r) => r.eccentric.enabled, random: [3, 25] },
  { key: 'eccentric.angle', label: 'Offset angle', group: 'eccentric', type: 'number', unit: '°', min: 0, max: 360, step: 1, simple: false, visible: (r) => r.eccentric.enabled },
  { key: 'eccentric.divisions', label: 'Divisions', group: 'eccentric', type: 'int', min: 1, max: 36, step: 1, simple: false, visible: (r) => r.eccentric.enabled, random: [3, 16] },
  { key: 'eccentric.divisionStep', label: 'Division step', group: 'eccentric', type: 'number', unit: '°', min: 0, max: 180, step: 0.5, simple: false, visible: (r) => r.eccentric.enabled, help: '0 = evenly spaced (360° / divisions).' },

  // Elliptical chuck
  { key: 'elliptical.enabled', label: 'Elliptical chuck', group: 'elliptical', type: 'bool', simple: false },
  { key: 'elliptical.e', label: 'Ellipticity', group: 'elliptical', type: 'number', unit: 'mm', min: 0, max: 30, step: 0.1, simple: false, visible: (r) => r.elliptical.enabled, random: [2, 15] },
  { key: 'elliptical.angle', label: 'Major axis angle', group: 'elliptical', type: 'number', unit: '°', min: 0, max: 180, step: 1, simple: false, visible: (r) => r.elliptical.enabled },

  // Ink
  {
    key: 'ink.colorMode', label: 'Colour', group: 'ink', type: 'select', simple: true, modes: ['ink'],
    options: [
      { value: 'single', label: 'Single' },
      { value: 'cycle', label: 'Cycle palette per pass' },
      { value: 'gradient', label: 'Gradient across passes' },
    ],
  },
  { key: 'ink.paper', label: 'Paper', group: 'ink', type: 'color', simple: true, modes: ['ink'] },
  { key: 'ink.lineWidth', label: 'Pen width', group: 'ink', type: 'number', unit: 'mm', min: 0.05, max: 1.5, step: 0.01, simple: true, modes: ['ink'], random: [0.12, 0.5] },
  { key: 'ink.opacity', label: 'Ink opacity', group: 'ink', type: 'number', min: 0.1, max: 1, step: 0.01, simple: false, modes: ['ink'], random: [0.6, 1] },

  // Metal
  {
    key: 'metal.material', label: 'Metal', group: 'metal', type: 'select', simple: true, modes: ['metal'],
    options: [
      { value: 'silver', label: 'Silver' },
      { value: 'gold', label: 'Yellow gold' },
      { value: 'rose', label: 'Rose gold' },
      { value: 'brass', label: 'Brass' },
      { value: 'steel', label: 'Steel' },
      { value: 'blued', label: 'Blued steel' },
    ],
  },
  { key: 'metal.toolAngle', label: 'V-tool angle', group: 'metal', type: 'number', unit: '°', min: 90, max: 150, step: 1, simple: false, modes: ['metal'] },
  { key: 'metal.baseDepth', label: 'Cut depth', group: 'metal', type: 'number', unit: 'mm', min: 0.01, max: 0.4, step: 0.005, simple: false, modes: ['metal'], random: [0.04, 0.15] },
  { key: 'metal.lightAngle', label: 'Light angle', group: 'metal', type: 'number', unit: '°', min: 0, max: 360, step: 1, simple: true, modes: ['metal'] },
  { key: 'metal.lightElevation', label: 'Light height', group: 'metal', type: 'number', unit: '°', min: 5, max: 85, step: 1, simple: false, modes: ['metal'] },
  { key: 'metal.enamel', label: 'Enamel', group: 'metal', type: 'bool', simple: true, modes: ['metal'] },
  { key: 'metal.enamelColor', label: 'Enamel colour', group: 'metal', type: 'color', simple: true, modes: ['metal'], visible: (r) => r.metal.enamel },
  { key: 'metal.enamelOpacity', label: 'Enamel opacity', group: 'metal', type: 'number', min: 0, max: 1, step: 0.01, simple: false, modes: ['metal'], visible: (r) => r.metal.enamel },
];

/** Per-rosette params; keys are relative to a Rosette. Lock keys use `rosettes.<id>.<key>`. */
export const ROSETTE_PARAMS: (Omit<ParamDef, 'group'> & { key: keyof Rosette })[] = [
  {
    key: 'axis', label: 'Axis', type: 'select', simple: false,
    options: [
      { value: 'rock', label: 'Rocking (radial)' },
      { value: 'pump', label: 'Pumping (depth)' },
    ],
  },
  {
    key: 'profile', label: 'Profile', type: 'select', simple: true,
    options: [
      { value: 'sine', label: 'Wave' },
      { value: 'convex', label: 'Convex (round bumps)' },
      { value: 'concave', label: 'Concave (points)' },
      { value: 'flame', label: 'Flame' },
      { value: 'square', label: 'Square' },
      { value: 'saw', label: 'Saw' },
      { value: 'triangle', label: 'Triangle (zigzag)' },
    ],
  },
  {
    key: 'lobes', label: 'Lobes', type: 'int', min: 1, max: 300, step: 1, simple: true, random: [3, 48],
    dynamic: (r) => (r.symmetry.order >= 2 ? { min: r.symmetry.order, step: r.symmetry.order, max: Math.floor(300 / r.symmetry.order) * r.symmetry.order } : {}),
  },
  { key: 'amplitude', label: 'Amplitude', type: 'number', unit: 'mm', min: 0, max: 8, step: 0.05, simple: true, random: [0.3, 3] },
  { key: 'phase', label: 'Phase', type: 'number', unit: '°', min: 0, max: 360, step: 0.5, simple: false, random: [0, 360] },
];

export const PALETTES: { name: string; colors: string[]; paper: string }[] = [
  { name: 'Banknote', colors: ['#1d2a5c', '#2f6b4f', '#7a2a3a'], paper: '#f4efe4' },
  { name: 'Iris', colors: ['#3a2d7a', '#6a4fb3', '#9a74cf'], paper: '#f7f5fb' },
  { name: 'Ember', colors: ['#7a1f1f', '#d1542a', '#f0b04a'], paper: '#fbf6ec' },
  { name: 'Lagoon', colors: ['#0d4f5c', '#1f8a8a', '#3fa896'], paper: '#f1f7f5' },
  { name: 'Ink only', colors: ['#16161a'], paper: '#f6f3ec' },
  { name: 'Night', colors: ['#e8d8a8', '#c9a45c', '#8fb8de'], paper: '#11131a' },
];

// ---------- dot-path helpers ----------

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}

/** Mutates obj. Caller is responsible for cloning first. */
export function setPath(obj: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  let o = obj as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]] as Record<string, unknown>;
  o[keys[keys.length - 1]] = value;
}

/** A param's limits for this recipe: static min/max/step overridden by `dynamic`. */
export function resolveParam<D extends Pick<ParamDef, 'min' | 'max' | 'step' | 'dynamic'>>(def: D, r: Recipe): D {
  if (!def.dynamic) return def;
  const d = def.dynamic(r);
  return { ...def, ...Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined && Number.isFinite(v))) };
}

export function clampParam(def: Pick<ParamDef, 'type' | 'min' | 'max'>, v: number): number {
  let x = v;
  if (def.min !== undefined) x = Math.max(def.min, x);
  if (def.max !== undefined) x = Math.min(def.max, x);
  if (def.type === 'int') x = Math.round(x);
  return x;
}
