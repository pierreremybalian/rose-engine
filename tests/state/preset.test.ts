import { describe, expect, it } from 'vitest';
import { MIGRATIONS, parsePreset, serializePreset } from '../../src/export/preset';
import { RECIPE_VERSION, defaultRecipe } from '../../src/state/recipe';
import { randomRecipe } from '../../src/engine/random';
import { V1_PRESET } from './fixtures';

describe('serializePreset', () => {
  it('writes pretty JSON with a version', () => {
    const text = serializePreset(defaultRecipe());
    expect(text).toContain(`\n  "version": ${RECIPE_VERSION}`);
    expect(JSON.parse(text).version).toBe(RECIPE_VERSION);
  });

  it('round-trips', () => {
    for (let seed = 0; seed < 20; seed++) {
      const r = randomRecipe(seed, { ...defaultRecipe(), mode: seed % 2 ? 'metal' : 'ink' }, []);
      expect(parsePreset(serializePreset(r))).toEqual(r);
    }
  });
});

describe('parsePreset', () => {
  it('fills missing fields from defaults', () => {
    const r = parsePreset(JSON.stringify({ name: 'Mine', slide: { passes: 12 } }));
    const d = defaultRecipe();
    expect(r.name).toBe('Mine');
    expect(r.slide.passes).toBe(12);
    expect(r.slide.endRadius).toBe(d.slide.endRadius);
    expect(r.machine).toEqual(d.machine);
    expect(r.ink).toEqual(d.ink);
    expect(r.rosettes.length).toBe(1);
    expect(r.version).toBe(RECIPE_VERSION);
  });

  it('clamps out-of-range numbers and rounds ints', () => {
    const r = parsePreset(
      JSON.stringify({
        slide: { passes: 1e6, startRadius: -5, alternateEvery: 2.6, amplitudeTaper: 99 },
        machine: { workDiameter: 5, rubberRadius: 50 },
        metal: { baseDepth: 3, lightAngle: -30 },
        rosettes: [{ id: 'a', lobes: 500.4, amplitude: -1, phase: 725 }],
      }),
    );
    expect(r.slide.passes).toBe(300);
    expect(r.slide.startRadius).toBe(0);
    expect(r.slide.alternateEvery).toBe(3);
    expect(r.slide.amplitudeTaper).toBe(3);
    expect(r.machine.workDiameter).toBe(20);
    expect(r.machine.rubberRadius).toBe(12);
    expect(r.metal.baseDepth).toBe(0.4);
    expect(r.metal.lightAngle).toBe(330);
    expect(r.rosettes[0].lobes).toBe(300);
    expect(r.rosettes[0].amplitude).toBe(0);
    expect(r.rosettes[0].phase).toBe(5);
  });

  it('validates enums, colours and types, falling back to defaults', () => {
    const d = defaultRecipe();
    const r = parsePreset(
      JSON.stringify({
        mode: 'plasma',
        slide: { phaseMode: 'zigzag', spiral: 'yes', passes: 'many', phaseCustom: [1, 'x', 2, null] },
        ink: { colorMode: 'rainbow', paper: 'red', palette: ['#abc', 'nope', '#A1B2C3', 7] },
        metal: { material: 'unobtainium', enamelColor: '#12345' },
        rosettes: [{ id: 'a', profile: 'blob', axis: 'sideways', enabled: 1 }],
      }),
    );
    expect(r.mode).toBe(d.mode);
    expect(r.slide.phaseMode).toBe(d.slide.phaseMode);
    expect(r.slide.spiral).toBe(false);
    expect(r.slide.passes).toBe(d.slide.passes);
    expect(r.slide.phaseCustom).toEqual([1, 2]);
    expect(r.ink.colorMode).toBe(d.ink.colorMode);
    expect(r.ink.paper).toBe(d.ink.paper);
    expect(r.ink.palette).toEqual(['#abc', '#a1b2c3']);
    expect(r.metal.material).toBe(d.metal.material);
    expect(r.metal.enamelColor).toBe(d.metal.enamelColor);
    expect(r.rosettes[0].profile).toBe('sine');
    expect(r.rosettes[0].axis).toBe('rock');
    expect(r.rosettes[0].enabled).toBe(true);
  });

  it('caps rosettes at 8 with unique ids', () => {
    const rosettes = Array.from({ length: 12 }, (_, i) => ({ id: i < 6 ? 'dup' : `x${i}`, lobes: 3 + i }));
    rosettes.push({ id: 'bad id!', lobes: 4 } as never);
    const r = parsePreset(JSON.stringify({ rosettes }));
    expect(r.rosettes.length).toBe(8);
    expect(new Set(r.rosettes.map((x) => x.id)).size).toBe(8);
    expect(r.rosettes[0].id).toBe('dup');
    expect(r.rosettes.map((x) => x.lobes)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('drops unknown keys and non-object rosettes', () => {
    const r = parsePreset(JSON.stringify({ evil: '<script>', slide: { passes: 5, bogus: 1 }, rosettes: [null, 3, { id: 'ok' }] }));
    expect('evil' in r).toBe(false);
    expect('bogus' in r.slide).toBe(false);
    expect(r.rosettes.map((x) => x.id)).toEqual(['ok']);
  });

  it('accepts a wrapped { recipe } object', () => {
    const r = parsePreset(JSON.stringify({ recipe: { name: 'Wrapped', slide: { passes: 7 } } }));
    expect(r.name).toBe('Wrapped');
    expect(r.slide.passes).toBe(7);
  });

  it('rejects junk with clear errors', () => {
    expect(() => parsePreset('not json')).toThrow(/not valid JSON/);
    expect(() => parsePreset('')).toThrow(/not valid JSON/);
    expect(() => parsePreset('[1,2,3]')).toThrow(/JSON object/);
    expect(() => parsePreset('null')).toThrow(/JSON object/);
    expect(() => parsePreset('"hello"')).toThrow(/JSON object/);
    expect(() => parsePreset('{}')).toThrow(/not a rose-engine preset/);
    expect(() => parsePreset('{"foo": 1}')).toThrow(/not a rose-engine preset/);
    expect(() => parsePreset('{"slide": 5}')).toThrow(/"slide" must be an object/);
    expect(() => parsePreset('{"rosettes": {"a": 1}}')).toThrow(/"rosettes" must be an array/);
    expect(() => parsePreset(JSON.stringify({ version: RECIPE_VERSION + 1, slide: {} }))).toThrow(/newer/);
  });

  it('runs migrations up to the current version', () => {
    // A missing or old version is treated as v1 and migrated step by step.
    expect(RECIPE_VERSION).toBe(2);
    expect(Object.keys(MIGRATIONS).map(Number)).toEqual([1]);
    const r = parsePreset(JSON.stringify({ version: 0, slide: { passes: 3 } }));
    expect(r.version).toBe(RECIPE_VERSION);
    expect(r.slide.passes).toBe(3);
  });

  it('migrates a v1 preset to v2: same design, Fill to edge off, symmetry free', () => {
    const r = parsePreset(JSON.stringify(V1_PRESET));
    expect(r.version).toBe(2);
    expect(r.machine).toEqual({ ...V1_PRESET.machine, fillEdge: false });
    expect(r.symmetry).toEqual({ order: 0, mirror: false });
    expect(r.slide).toEqual(V1_PRESET.slide);
    expect(r.rosettes).toEqual(V1_PRESET.rosettes);
    expect(r.metal).toEqual(V1_PRESET.metal);
    expect(r.ink).toEqual(V1_PRESET.ink);
  });

  it('the v1 → v2 step fills only what is missing', () => {
    const m = MIGRATIONS[1];
    expect(m({ version: 1, machine: { workDiameter: 40 } })).toEqual({ version: 2, machine: { workDiameter: 40, fillEdge: false }, symmetry: { order: 0, mirror: false } });
    // A version-less hand-written file that already uses v2 fields keeps them.
    const r = parsePreset(JSON.stringify({ machine: { fillEdge: true }, symmetry: { order: 12, mirror: true }, slide: { passes: 4 } }));
    expect(r.machine.fillEdge).toBe(true);
    expect(r.symmetry).toEqual({ order: 12, mirror: true });
    // Garbage sections are still rejected, not papered over.
    expect(() => parsePreset(JSON.stringify({ version: 1, machine: 5 }))).toThrow(/"machine" must be an object/);
  });

  it('clamps and validates the v2 fields', () => {
    const r = parsePreset(JSON.stringify({ machine: { fillEdge: 'yes' }, symmetry: { order: 500.4, mirror: 1 } }));
    expect(r.machine.fillEdge).toBe(false);
    expect(r.symmetry).toEqual({ order: 96, mirror: false });
    expect(parsePreset(JSON.stringify({ symmetry: { order: -3 } })).symmetry.order).toBe(0);
  });
});

