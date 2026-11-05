// Rescale a recipe to a new plate size (the Plate size control scales the whole design with the plate).
import type { Recipe } from './recipe';
import { PARAMS, ROSETTE_PARAMS, clampParam, getPath, resolveParam, setPath } from './params';
import type { ParamDef } from './params';

const PARAM_BY_KEY = new Map<string, ParamDef>(PARAMS.map((p) => [p.key, p]));
const AMPLITUDE = ROSETTE_PARAMS.find((p) => p.key === 'amplitude')!;

/** Recipe dot-paths scaled by k, in order: the radius limits (maxUsefulRadius) read the plate, chucks and
 *  amplitudes, so those are scaled first and the slide radii last. */
const SCALED_PATHS = ['eccentric.offset', 'elliptical.e', 'metal.baseDepth', 'ink.lineWidth', 'slide.startRadius', 'slide.endRadius'];

/** Drop float noise (1.5 * 0.1 = 0.15000000000000002) so scaled values stay readable in the UI and JSON. */
const tidy = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Same design at k × the size: plate diameter, radii, rock/pump amplitudes, chuck offsets, cut depth and pen width
 * scale by k (clamped to their param ranges). Machine physics (rosette radius, rubber) does not. Returns a new recipe.
 *
 * The plate is clamped to its 20–300 mm range first; if that clamps, everything scales by the ratio the plate
 * actually moved so the design stays in proportion with it. Lobes, passes, phases, angles and colours are untouched.
 */
export function scaleRecipe(r: Recipe, k: number): Recipe {
  const out = structuredClone(r);
  if (!Number.isFinite(k) || k <= 0) return out;

  const plateDef = PARAM_BY_KEY.get('machine.workDiameter')!;
  const d0 = r.machine.workDiameter;
  const d1 = tidy(clampParam(resolveParam(plateDef, out), d0 * k));
  out.machine.workDiameter = d1;
  const kk = d0 > 0 ? d1 / d0 : k;

  for (const ro of out.rosettes) {
    ro.amplitude = tidy(clampParam(resolveParam(AMPLITUDE, out), ro.amplitude * kk));
  }
  for (const key of SCALED_PATHS) {
    const def = PARAM_BY_KEY.get(key);
    const v = getPath(out, key);
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const scaled = v * kk;
    setPath(out, key, tidy(def ? clampParam(resolveParam(def, out), scaled) : scaled));
  }
  return out;
}
