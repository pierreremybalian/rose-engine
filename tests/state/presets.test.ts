import { describe, expect, it } from 'vitest';
import { PRESETS } from '../../src/presets';
import { parsePreset, parsePresetObject, serializePreset } from '../../src/export/preset';
import { PARAMS, getPath } from '../../src/state/params';
import { grooveCoverage } from '../../src/engine/random';

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
  }

  it('has 10–12 presets with unique ids and names', () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(10);
    expect(PRESETS.length).toBeLessThanOrEqual(12);
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
        // Full-coverage engraving: the shallowest groove is 1.0–1.4 × the pass spacing wide.
        const cov = grooveCoverage(p.recipe)!;
        expect(cov).toBeGreaterThanOrEqual(1);
        expect(cov).toBeLessThanOrEqual(1.4);
      }
    });
  }
});
