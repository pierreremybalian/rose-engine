// CONTRACT FILE — plate geometry shared by the engine, params (radius limits), Random, render clipping and exports.
// Pure: no DOM, no engine state. Lengths in mm.
import type { Recipe } from '../state/recipe';

/** Radius of the plate (work disc). */
export function plateRadius(r: Recipe): number {
  return Math.max(1, (r.machine?.workDiameter ?? 100) / 2);
}

/** How far a chuck can put the pattern centre from the plate centre (eccentric offset + elliptical e). */
export function chuckReach(r: Recipe): number {
  const ecc = r.eccentric?.enabled ? Math.abs(r.eccentric.offset) : 0;
  const ell = r.elliptical?.enabled ? Math.abs(r.elliptical.e) : 0;
  return ecc + ell;
}

/** Largest radial swing of the rocking stack: sum of enabled rock amplitudes at the taper peak. */
export function rockReach(r: Recipe): number {
  const sum = (r.rosettes ?? []).filter((x) => x.enabled && x.axis === 'rock').reduce((a, x) => a + Math.abs(x.amplitude), 0);
  return sum * Math.max(1, r.slide?.amplitudeTaper ?? 1);
}

/** Largest slide radius whose cut can still touch the plate (slider max for start/end radius). */
export function maxUsefulRadius(r: Recipe): number {
  return Math.round((plateRadius(r) + chuckReach(r) + rockReach(r)) * 10) / 10;
}

/** Margin past the rim for Fill to edge, mm: the last pass's troughs clear the rim by this much. */
export const FILL_MARGIN = 0.2;

/**
 * End radius that runs the cut fully past the rim (every plate point reached, troughs included).
 * Concentric: the last pass sits at F = plate + chuck reach + rock reach + margin. Spiral: the radius still ramps
 * during the last turn (it starts span / passes lower), so the end goes out until that whole turn clears F:
 * end - (end - start) / passes >= F, i.e. end = (F * passes - start) / (passes - 1).
 */
export function fillEndRadius(r: Recipe): number {
  const F = plateRadius(r) + chuckReach(r) + rockReach(r) + FILL_MARGIN;
  const passes = Math.max(1, Math.round(r.slide?.passes ?? 1));
  if (!r.slide?.spiral || passes < 2) return F;
  const start = Number.isFinite(r.slide.startRadius) ? r.slide.startRadius : 0;
  return Math.max(F, (F * passes - start) / (passes - 1));
}

/** End radius the engine actually uses: fillEndRadius when machine.fillEdge, else slide.endRadius. */
export function effectiveEndRadius(r: Recipe): number {
  if (!r.machine?.fillEdge) return r.slide.endRadius;
  return Math.max(r.slide.startRadius, fillEndRadius(r));
}
