import { describe, expect, it } from 'vitest';
import { PRESETS } from '../../src/presets';
import { parsePreset, parsePresetObject, serializePreset } from '../../src/export/preset';
import { PARAMS, getPath } from '../../src/state/params';
import { grooveCoverage, passSpacing } from '../../src/engine/random';
import { effectiveEndRadius, plateRadius } from '../../src/engine/plate';
import { analyzeSymmetry, enforceSymmetry } from '../../src/engine/symmetry';
import { RECIPE_VERSION } from '../../src/state/recipe';

const RAW = import.meta.glob<{ default: unknown }>('../../src/presets/*.json', { eager: true });

describe('built-in presets', () => {
  it('every JSON file is listed in PRESETS', () => {
    const files = Object.keys(RAW).map((f) => f.replace(/^.*\/(.+)\.json$/, '$1')).sort();
    expect(PRESETS.map((p) => p.id).sort()).toEqual(files);
  });

  for (const [file, mod] of Object.entries(RAW)) {
    it(`${file} is already valid (parsing changes nothing)`, () => {
      expect(parsePresetObject(mod.default)).toEqual(mod.default);
    });
    it(`${file} is a current-version file with the plate and symmetry fields`, () => {
      const o = mod.default as { version: number; machine: Record<string, unknown>; symmetry: unknown };
      expect(o.version).toBe(RECIPE_VERSION);
      expect(typeof o.machine.fillEdge).toBe('boolean');
      expect(o.symmetry).toEqual({ order: expect.any(Number), mirror: expect.any(Boolean) });
    });
  }

  for (const p of PRESETS) {
    it(`${p.id} already satisfies its own symmetry setting (enforcing changes nothing)`, () => {
      expect(enforceSymmetry(p.recipe)).toBe(p.recipe);
      const a = analyzeSymmetry(p.recipe);
      const { order, mirror } = p.recipe.symmetry;
      if (order >= 2) expect(a.order % order).toBe(0);
      if (mirror) expect(a).toMatchObject({ mirror: true, axis: 90 });
    });
  }

  it('Fine Barleycorn: centre to past the rim, 0.25 mm spacing, 2A = spacing, fully cut with a 120° graver', () => {
    const r = PRESETS.find((p) => p.id === 'fine-barleycorn')!.recipe;
    expect(r.slide.startRadius).toBe(0);
    expect(r.machine.fillEdge).toBe(true);
    expect(r.machine.rubberRadius).toBe(0.15);
    expect(r.rosettes).toHaveLength(1);
    expect(r.rosettes[0]).toMatchObject({ lobes: 216, profile: 'triangle', axis: 'rock', enabled: true });
    expect(r.slide).toMatchObject({ phaseMode: 'alternate', alternateEvery: 1, alternateFraction: 0.5, spiral: false });
    expect(r.metal.toolAngle).toBe(120);
    const end = effectiveEndRadius(r);
    expect(end).toBeGreaterThan(plateRadius(r));
    const spacing = (end - r.slide.startRadius) / (r.slide.passes - 1);
    expect(spacing).toBeGreaterThan(0.24);
    expect(spacing).toBeLessThan(0.26);
    const sumA = r.rosettes[0].amplitude;
    expect((2 * sumA) / spacing).toBeGreaterThan(0.97);
    expect((2 * sumA) / spacing).toBeLessThan(1.03);
    // slide.endRadius (shown when Fill is switched off) sits at the effective end, so passSpacing agrees.
    expect(Math.abs(r.slide.endRadius - end)).toBeLessThan(0.05);
    const width = 2 * r.metal.baseDepth * Math.tan(((r.metal.toolAngle / 2) * Math.PI) / 180);
    const ratio = width / (spacing + 2 * sumA);
    expect(ratio).toBeGreaterThanOrEqual(1.05);
    expect(ratio).toBeLessThanOrEqual(1.2);
    console.log(`Fine Barleycorn: effective end ${end.toFixed(3)} mm, ${r.slide.passes} passes, spacing ${spacing.toFixed(4)} mm, 2A/spacing ${((2 * sumA) / spacing).toFixed(3)}, width ${width.toFixed(3)} mm = ${ratio.toFixed(3)} × (spacing + 2A), grooveCoverage ${grooveCoverage(r)!.toFixed(3)}`);
  });

  it('has 10–15 presets with unique ids and names', () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(10);
    expect(PRESETS.length).toBeLessThanOrEqual(15);
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    expect(new Set(PRESETS.map((p) => p.name)).size).toBe(PRESETS.length);
  });

  it('mixes ink and metal and covers the main machine features', () => {
    const r = PRESETS.map((p) => p.recipe);
    expect(r.some((x) => x.mode === 'ink')).toBe(true);
    expect(r.some((x) => x.mode === 'metal')).toBe(true);
    expect(r.some((x) => x.eccentric.enabled)).toBe(true);
    expect(r.some((x) => x.elliptical.enabled)).toBe(true);
    expect(r.some((x) => x.slide.spiral)).toBe(true);
    expect(r.some((x) => x.slide.phaseMode === 'alternate' && x.slide.alternateEvery > 1)).toBe(true);
    expect(r.some((x) => x.mode === 'metal' && x.metal.enamel && x.rosettes.some((ro) => ro.axis === 'pump'))).toBe(true);
    expect(r.some((x) => x.mode === 'ink' && x.ink.palette.length > 1 && x.ink.colorMode !== 'single')).toBe(true);
  });

  for (const p of PRESETS) {
    it(`${p.id} round-trips and stays in range`, () => {
      expect(parsePreset(serializePreset(p.recipe))).toEqual(p.recipe);
      for (const def of PARAMS) {
        if (def.type !== 'number' && def.type !== 'int') continue;
        const v = getPath(p.recipe, def.key) as number;
        if (def.min !== undefined) expect(v, def.key).toBeGreaterThanOrEqual(def.min);
        if (def.max !== undefined) expect(v, def.key).toBeLessThanOrEqual(def.max);
      }
      expect(p.recipe.rosettes.length).toBeGreaterThan(0);
      // Enamel stays translucent so the engraving shows through.
      expect(p.recipe.metal.enamelOpacity).toBeLessThanOrEqual(0.55);
      if (p.recipe.mode === 'metal') {
        // Fully cut: the shallowest groove is 1.0–1.4 × the widest gap between neighbouring cut centrelines.
        const cov = grooveCoverage(p.recipe)!;
        expect(cov).toBeGreaterThanOrEqual(1);
        expect(cov).toBeLessThanOrEqual(1.4);
      }
    });
  }

  // Barleycorn: anti-phased passes whose peaks just touch the next pass's troughs (2A ≈ spacing), so the
  // uncut areas read as diamonds / grains; much more and the centrelines cross into loops.
  const barleycornStyle = PRESETS.filter(({ recipe: r }) =>
    r.slide.phaseMode === 'alternate' && r.slide.alternateFraction === 0.5 && r.slide.alternateEvery === 1 && !r.eccentric.enabled && !r.slide.spiral,
  );

  it('includes barleycorn-style presets, among them a watch-dial-scale one past the old 96-lobe limit', () => {
    expect(barleycornStyle.map((p) => p.id)).toEqual(expect.arrayContaining(['barleycorn', 'enamel-dial', 'cartouche', 'grain-d-orge', 'fine-barleycorn']));
    expect(PRESETS.some((p) => p.recipe.rosettes.some((ro) => ro.lobes > 96))).toBe(true);
  });

  for (const p of barleycornStyle) {
    it(`${p.id}: barleycorn amplitude, 2·ΣA / spacing in [0.85, 1.25]`, () => {
      const r = p.recipe;
      const sumA = r.rosettes.filter((ro) => ro.enabled && ro.axis === 'rock').reduce((a, ro) => a + Math.abs(ro.amplitude), 0);
      const ratio = (2 * sumA * Math.max(1, r.slide.amplitudeTaper)) / passSpacing(r)!;
      expect(ratio).toBeGreaterThanOrEqual(0.85);
      expect(ratio).toBeLessThanOrEqual(1.25);
    });
  }
});
