// Versioned preset JSON: save, and load untrusted input (validate, migrate, fill defaults, clamp).
import { RECIPE_VERSION, defaultRecipe, defaultRosette, newRosetteId } from '../state/recipe';
import type { Recipe, Rosette } from '../state/recipe';
import { PARAMS, ROSETTE_PARAMS, clampParam } from '../state/params';
import type { ParamDef } from '../state/params';

const MAX_ROSETTES = 8;
const MAX_PALETTE = 8;
const MAX_CUSTOM_PHASES = 64;
const MAX_NAME = 80;

const SECTIONS = ['machine', 'slide', 'eccentric', 'elliptical', 'ink', 'metal'] as const;
const TOP_KEYS = new Set<string>(['version', 'name', 'seed', 'mode', 'rosettes', ...SECTIONS]);

const ENUMS: Record<string, readonly string[]> = {
  mode: ['ink', 'metal'],
  'slide.phaseMode': ['linear', 'alternate', 'custom'],
  'ink.colorMode': ['single', 'cycle', 'gradient'],
  'metal.material': ['silver', 'gold', 'rose', 'brass', 'steel', 'blued'],
  'rosette.profile': ['sine', 'convex', 'concave', 'flame', 'square', 'saw'],
  'rosette.axis': ['rock', 'pump'],
};

const COLOR_PATHS = new Set(['ink.paper', 'metal.enamelColor']);
const PARAM_BY_KEY = new Map<string, ParamDef>(PARAMS.map((p) => [p.key, p]));
const ROSETTE_PARAM_BY_KEY = new Map<string, Pick<ParamDef, 'type' | 'min' | 'max'>>(ROSETTE_PARAMS.map((p) => [p.key, p]));
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
/** Angles wrap into range instead of clamping (-30° is 330°, not 0°). */
const WRAP: Record<string, number> = { 'eccentric.angle': 360, 'elliptical.angle': 180, 'metal.lightAngle': 360, 'rosette.phase': 360 };
const ID = /^[A-Za-z0-9_-]{1,40}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Migrations from version N to N + 1, applied in order up to RECIPE_VERSION.
 * Add an entry here whenever RECIPE_VERSION is bumped, e.g. `1: (o) => ({ ...o, newField: ..., version: 2 })`.
 */
export const MIGRATIONS: Record<number, (o: Obj) => Obj> = {};

export function migratePreset(o: Obj): Obj {
  let v = typeof o.version === 'number' && Number.isFinite(o.version) ? Math.floor(o.version) : 1;
  if (v < 1) v = 1;
  if (v > RECIPE_VERSION) {
    throw new Error(`Preset version ${v} is newer than this app supports (version ${RECIPE_VERSION}).`);
  }
  let cur: Obj = { ...o, version: v };
  while (v < RECIPE_VERSION) {
    const m = MIGRATIONS[v];
    if (!m) throw new Error(`No migration from preset version ${v}.`);
    cur = m(cur);
    v += 1;
    cur.version = v;
  }
  return cur;
}

export function serializePreset(recipe: Recipe): string {
  return JSON.stringify({ ...recipe, version: RECIPE_VERSION }, null, 2);
}

/** Parse untrusted preset text. Throws a readable Error on non-JSON or a shape that isn't a recipe. */
export function parsePreset(text: string): Recipe {
  if (typeof text !== 'string') throw new Error('Preset must be JSON text.');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Preset is not valid JSON: ${(e as Error).message}`);
  }
  return parsePresetObject(data);
}

/** Same as parsePreset, for an already-parsed value. Accepts a bare recipe or `{ recipe: {...} }`. */
export function parsePresetObject(data: unknown): Recipe {
  if (!isObj(data)) throw new Error('Preset must be a JSON object describing a recipe.');
  if (isObj(data.recipe) && !('rosettes' in data) && !('slide' in data)) data = data.recipe;
  const raw = data as Obj;
  const known = Object.keys(raw).filter((k) => TOP_KEYS.has(k) && k !== 'version' && k !== 'name');
  if (!known.length) throw new Error('This JSON is not a rose-engine preset (no recipe fields found).');

  const o = migratePreset(raw);
  const out = defaultRecipe();

  for (const sec of SECTIONS) {
    const v = o[sec];
    if (v === undefined) continue;
    if (!isObj(v)) throw new Error(`Preset field "${sec}" must be an object.`);
  }
  if (o.rosettes !== undefined && !Array.isArray(o.rosettes)) throw new Error('Preset field "rosettes" must be an array.');

  out.version = RECIPE_VERSION;
  if (typeof o.name === 'string') out.name = o.name.trim().slice(0, MAX_NAME) || out.name;
  if (typeof o.seed === 'number' && Number.isFinite(o.seed)) out.seed = Math.abs(Math.floor(o.seed)) >>> 0;
  out.mode = pickEnum('mode', o.mode, out.mode);

  const target = out as unknown as Obj;
  for (const sec of SECTIONS) {
    const src = (o[sec] ?? {}) as Obj;
    const dst = target[sec] as Obj;
    for (const key of Object.keys(dst)) {
      if (!(key in src)) continue;
      dst[key] = sanitizeField(`${sec}.${key}`, src[key], dst[key]);
    }
  }

  if (Array.isArray(o.rosettes)) out.rosettes = sanitizeRosettes(o.rosettes);
  return out;
}

function pickEnum<T extends string>(path: string, v: unknown, fallback: T): T {
  return typeof v === 'string' && ENUMS[path].includes(v) ? (v as T) : fallback;
}

function num(def: Pick<ParamDef, 'type' | 'min' | 'max'> | undefined, v: unknown, fallback: number, period?: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  let x = v;
  if (period && (x < 0 || x > period)) x = ((x % period) + period) % period;
  return def ? clampParam(def, x) : x;
}

function color(v: unknown, fallback: string): string {
  return typeof v === 'string' && HEX.test(v.trim()) ? v.trim().toLowerCase() : fallback;
}

/** Validate one leaf against the type of its default. Invalid leaves fall back to the default. */
function sanitizeField(path: string, v: unknown, fallback: unknown): unknown {
  if (path in ENUMS) return pickEnum(path, v, fallback as string);
  if (COLOR_PATHS.has(path)) return color(v, fallback as string);
  if (path === 'ink.palette') {
    if (!Array.isArray(v)) return fallback;
    const pal = v.filter((c): c is string => typeof c === 'string' && HEX.test(c.trim())).map((c) => c.trim().toLowerCase()).slice(0, MAX_PALETTE);
    return pal.length ? pal : fallback;
  }
  if (path === 'slide.phaseCustom') {
    if (!Array.isArray(v)) return fallback;
    const list = v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).map((x) => Math.max(-360, Math.min(360, x))).slice(0, MAX_CUSTOM_PHASES);
    return list.length ? list : fallback;
  }
  if (typeof fallback === 'number') return num(PARAM_BY_KEY.get(path), v, fallback, WRAP[path]);
  if (typeof fallback === 'boolean') return typeof v === 'boolean' ? v : fallback;
  if (typeof fallback === 'string') return typeof v === 'string' ? v.slice(0, MAX_NAME) : fallback;
  return fallback;
}

function sanitizeRosettes(list: unknown[]): Rosette[] {
  const seen = new Set<string>();
  const out: Rosette[] = [];
  for (const item of list) {
    if (out.length >= MAX_ROSETTES) break;
    if (!isObj(item)) continue;
    const base = defaultRosette();
    let id = typeof item.id === 'string' && ID.test(item.id) ? item.id : '';
    while (!id || seen.has(id)) id = newRosetteId();
    seen.add(id);
    out.push({
      id,
      enabled: typeof item.enabled === 'boolean' ? item.enabled : base.enabled,
      axis: pickEnum('rosette.axis', item.axis, base.axis),
      lobes: num(ROSETTE_PARAM_BY_KEY.get('lobes'), item.lobes, base.lobes),
      amplitude: num(ROSETTE_PARAM_BY_KEY.get('amplitude'), item.amplitude, base.amplitude),
      profile: pickEnum('rosette.profile', item.profile, base.profile),
      phase: num(ROSETTE_PARAM_BY_KEY.get('phase'), item.phase, base.phase, WRAP['rosette.phase']),
    });
  }
  return out;
}
