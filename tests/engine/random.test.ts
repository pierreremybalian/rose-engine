import { describe, expect, it } from 'vitest';
import { FAMILIES, MIN_INK_CONTRAST, contrastRatio, grooveCoverage, maxPassGap, mirrorPhase, mulberry32, mutateRecipe, passSpacing, randomRecipe } from '../../src/engine/random';
import { PALETTES, PARAMS, ROSETTE_PARAMS, getPath } from '../../src/state/params';
import { defaultRecipe, defaultRosette, type Recipe } from '../../src/state/recipe';
import { computeToolpath, prepare } from '../../src/engine/index';
import { chuckReach, effectiveEndRadius, fillEndRadius, plateRadius, rockReach } from '../../src/engine/plate';

/** Plate view-state locks (the UI default): fill and symmetry are kept from the current recipe. */
const VIEW = ['symmetry.order', 'symmetry.mirror', 'machine.fillEdge'];

/** A current recipe with the given mode, plate and view-state. */
function plate(mode: 'ink' | 'metal', dia = 100, fillEdge = false, order = 0, mirror = false): Recipe {
  const r = defaultRecipe();
  r.mode = mode;
  r.machine = { ...r.machine, workDiameter: dia, fillEdge };
  r.symmetry = { order, mirror };
  return r;
}

/** Rosette ids come from newRosetteId (time-based), so compare recipes with ids normalised. */
function stripIds(r: Recipe): Recipe {
  return { ...r, rosettes: r.rosettes.map((x, i) => ({ ...x, id: `#${i}` })) };
}

/** Family id of a generated recipe, from its name ('<family name> No. <seed>'). */
function familyOf(r: Recipe): string | undefined {
  return FAMILIES.find((f) => f.names.some((n) => r.name.startsWith(`${n} No.`)))?.id;
}

const rockSum = (r: Recipe) => r.rosettes.filter((x) => x.enabled && x.axis === 'rock').reduce((a, x) => a + x.amplitude, 0);

function expectInRanges(r: Recipe): void {
  for (const def of PARAMS) {
    if (def.type !== 'number' && def.type !== 'int') continue;
    const v = getPath(r, def.key) as number;
    expect(typeof v, def.key).toBe('number');
    expect(Number.isFinite(v), def.key).toBe(true);
    if (def.min !== undefined) expect(v, def.key).toBeGreaterThanOrEqual(def.min);
    if (def.max !== undefined) expect(v, def.key).toBeLessThanOrEqual(def.max);
    if (def.type === 'int') expect(Number.isInteger(v), def.key).toBe(true);
  }
  expect(r.rosettes.length).toBeLessThanOrEqual(8);
  expect(new Set(r.rosettes.map((x) => x.id)).size).toBe(r.rosettes.length);
  for (const ros of r.rosettes) {
    for (const def of ROSETTE_PARAMS) {
      if (def.type !== 'number' && def.type !== 'int') continue;
      const v = ros[def.key] as number;
      expect(Number.isFinite(v), def.key).toBe(true);
      if (def.min !== undefined) expect(v, def.key).toBeGreaterThanOrEqual(def.min);
      if (def.max !== undefined) expect(v, def.key).toBeLessThanOrEqual(def.max);
      if (def.type === 'int') expect(Number.isInteger(v), def.key).toBe(true);
    }
  }
}

describe('mulberry32', () => {
  it('is deterministic and in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe('randomRecipe', () => {
  const base = defaultRecipe();

  it('is deterministic per seed', () => {
    for (const seed of [0, 1, 7, 4172, 99999, 2 ** 31 + 5]) {
      expect(stripIds(randomRecipe(seed, base, []))).toEqual(stripIds(randomRecipe(seed, base, [])));
    }
  });

  it('does not depend on unlocked fields of the current recipe', () => {
    const other = defaultRecipe();
    other.slide.passes = 200;
    other.eccentric = { enabled: true, offset: 30, angle: 10, divisions: 9, divisionStep: 5 };
    other.rosettes = [defaultRosette({ lobes: 77 }), defaultRosette({ lobes: 5, axis: 'pump' })];
    other.ink.lineWidth = 1.2;
    for (const seed of [3, 11, 123]) {
      expect(stripIds(randomRecipe(seed, other, []))).toEqual(stripIds(randomRecipe(seed, base, [])));
    }
  });

  it('gives different recipes for different seeds', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) seen.add(JSON.stringify(stripIds(randomRecipe(seed, base, []))));
    expect(seen.size).toBe(40);
  });

  it('sets seed, a name, and keeps the mode', () => {
    const r = randomRecipe(4172, base, []);
    expect(r.seed).toBe(4172);
    expect(r.name).toMatch(/No\. 4172$/);
    const metal = { ...defaultRecipe(), mode: 'metal' as const };
    expect(randomRecipe(5, metal, []).mode).toBe('metal');
    expect(randomRecipe(5, base, []).mode).toBe('ink');
  });

  it('keeps every numeric output within ParamDef ranges', () => {
    const metal = { ...defaultRecipe(), mode: 'metal' as const };
    for (let seed = 0; seed < 400; seed++) {
      expectInRanges(randomRecipe(seed, seed % 2 ? metal : base, []));
    }
  });

  it('reaches every family', () => {
    const metal = { ...defaultRecipe(), mode: 'metal' as const };
    const seen = { eccentric: 0, elliptical: 0, spiral: 0, pump: 0, alternate: 0, linear: 0, sunray: 0, basket: 0 };
    for (let seed = 0; seed < 600; seed++) {
      const r = randomRecipe(seed, seed % 2 ? metal : base, VIEW);
      if (r.eccentric.enabled && !r.slide.spiral) seen.eccentric++;
      if (r.elliptical.enabled) seen.elliptical++;
      if (r.slide.spiral) seen.spiral++;
      if (r.rosettes.some((x) => x.axis === 'pump')) seen.pump++;
      if (r.slide.phaseMode === 'alternate') seen.alternate++;
      if (r.slide.phaseMode === 'alternate' && r.slide.alternateEvery > 1 && !r.elliptical.enabled) seen.basket++;
      if (r.slide.phaseMode === 'linear') seen.linear++;
      if (r.rosettes.some((x) => x.lobes >= 36 && x.axis === 'rock')) seen.sunray++;
    }
    for (const [k, n] of Object.entries(seen)) expect(n, k).toBeGreaterThan(15);
    expect(FAMILIES.length).toBeGreaterThanOrEqual(8);
    expect(FAMILIES.every((f) => f.weight > 0 && f.label && f.id)).toBe(true);
  });

  it('keeps every cut within 0.96 × the work radius and fills the dial (real toolpath)', () => {
    const cases: [number, number][] = [[100, 200], [60, 40], [200, 40]];
    for (const [dia, n] of cases) {
      const R = dia / 2;
      for (const mode of ['ink', 'metal'] as const) {
        for (let seed = 1; seed <= n; seed++) {
          const cur = { ...defaultRecipe(), mode };
          cur.machine = { ...cur.machine, workDiameter: dia };
          const r = randomRecipe(seed * 7919 + 13, cur, VIEW);
          const tp = computeToolpath(prepare(r, { maxSamples: 30_000 }));
          let ext = 0;
          for (let i = 0; i < tp.totalSamples; i++) ext = Math.max(ext, Math.hypot(tp.x[i], tp.y[i]));
          expect(ext, `${mode} dia ${dia} seed ${seed} ${r.name}`).toBeLessThanOrEqual(0.96 * R + 1e-6);
          expect(ext, `${mode} dia ${dia} seed ${seed} ${r.name}`).toBeGreaterThan(0.6 * R);
          expect(tp.totalLength).toBeGreaterThan(0);
        }
      }
    }
  });

  it('cuts metal fully: the shallowest groove spans the widest gap between neighbouring cuts', () => {
    const metal = { ...defaultRecipe(), mode: 'metal' as const };
    const angles: number[] = [];
    const depths: number[] = [];
    let capped = 0;
    for (let seed = 0; seed < 300; seed++) {
      const r = randomRecipe(seed, metal, VIEW);
      const sp = passSpacing(r);
      expect(sp, `seed ${seed} ${r.name}`).not.toBeNull();
      expect(sp!, `seed ${seed} ${r.name}`).toBeGreaterThan(0.2);
      expect(sp!, `seed ${seed} ${r.name}`).toBeLessThan(1.05);
      angles.push(r.metal.toolAngle);
      depths.push(r.metal.baseDepth);
      // Only the 0.4 mm depth cap may leave flats, and never on barleycorn.
      if (r.metal.baseDepth >= 0.4 && familyOf(r) !== 'barleycorn') {
        capped++;
        continue;
      }
      const cov = grooveCoverage(r)!;
      expect(cov, `seed ${seed} ${r.name} sp ${sp}`).toBeGreaterThanOrEqual(0.99);
      expect(cov, `seed ${seed} ${r.name} sp ${sp}`).toBeLessThanOrEqual(1.25);
      // Alternate phasing gets broad gravers.
      if (r.slide.phaseMode === 'alternate') expect(r.metal.toolAngle, `seed ${seed} ${r.name}`).toBeGreaterThanOrEqual(125);
    }
    expect(capped, 'recipes at the depth cap').toBeLessThan(15);
    // Depth and tool angle vary widely while coverage holds.
    expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(35);
    expect(Math.max(...depths) / Math.min(...depths)).toBeGreaterThan(4);
  });

  it("sizes barleycorn so each pass's peaks just touch the next pass's troughs (2·ΣA ≈ spacing)", () => {
    let n = 0;
    for (const mode of ['ink', 'metal'] as const) {
      for (let seed = 0; seed < 300; seed++) {
        const r = randomRecipe(seed, { ...defaultRecipe(), mode }, VIEW);
        if (familyOf(r) !== 'barleycorn') continue;
        n++;
        const sp = passSpacing(r)!;
        const ratio = (2 * rockSum(r)) / sp;
        expect(ratio, `${mode} seed ${seed} ${r.name}`).toBeGreaterThanOrEqual(0.85);
        expect(ratio, `${mode} seed ${seed} ${r.name}`).toBeLessThanOrEqual(1.25);
        // Anti-phased passes that just touch: the widest gap is about two spacings, never more.
        const gap = maxPassGap(r)!;
        expect(gap / sp, `${mode} seed ${seed} ${r.name}`).toBeLessThanOrEqual(2.01);
        // Companions stay quiet so they don't break the grain grid.
        const [p, ...secs] = r.rosettes.filter((x) => x.enabled && x.axis === 'rock');
        for (const q of secs) expect(q.amplitude, `${mode} seed ${seed}`).toBeLessThanOrEqual(0.3 * p.amplitude + 0.002);
      }
    }
    expect(n).toBeGreaterThan(60);
  });

  it('keeps ink pen width and opacity in a readable band', () => {
    for (let seed = 0; seed < 100; seed++) {
      const r = randomRecipe(seed, defaultRecipe(), VIEW);
      expect(r.ink.lineWidth).toBeGreaterThanOrEqual(0.08);
      expect(r.ink.lineWidth).toBeLessThanOrEqual(0.5);
      expect(r.ink.opacity).toBeGreaterThanOrEqual(0.72);
    }
  });

  it('generates varied, readable ink colour (palettes, papers, colour modes)', () => {
    const N = 200;
    let generated = 0;
    let fromPalettes = 0;
    let darkPaper = 0;
    const modes = { single: 0, cycle: 0, gradient: 0 };
    const sizes = new Set<number>();
    for (let seed = 1; seed <= N; seed++) {
      const r = randomRecipe(seed, base, VIEW);
      expect(r.ink.palette.length).toBeGreaterThanOrEqual(1);
      expect(r.ink.palette.length).toBeLessThanOrEqual(6);
      for (const c of [...r.ink.palette, r.ink.paper]) expect(c).toMatch(/^#[0-9a-f]{6}$/);
      for (const c of r.ink.palette) expect(contrastRatio(c, r.ink.paper), `seed ${seed} ${c} on ${r.ink.paper}`).toBeGreaterThanOrEqual(MIN_INK_CONTRAST);
      if (PALETTES.some((p) => p.paper === r.ink.paper)) fromPalettes++;
      else generated++;
      if (contrastRatio(r.ink.paper, '#000000') < 3) darkPaper++;
      modes[r.ink.colorMode]++;
      sizes.add(r.ink.palette.length);
      if (r.ink.palette.length === 1) expect(r.ink.colorMode).toBe('single');
    }
    expect(generated / N).toBeGreaterThan(0.6);
    expect(fromPalettes / N).toBeGreaterThan(0.1);
    expect(darkPaper / N).toBeGreaterThan(0.08);
    expect(modes.single / N).toBeLessThan(0.25);
    expect(modes.cycle / N).toBeGreaterThan(0.25);
    expect(modes.gradient / N).toBeGreaterThan(0.25);
    for (const n of [2, 3, 4, 5, 6]) expect(sizes.has(n), `palette size ${n}`).toBe(true);
  });

  it('builds compound rosette stacks and pumps about half the time, in both modes', () => {
    const N = 200;
    for (const mode of ['ink', 'metal'] as const) {
      const counts = [0, 0, 0, 0, 0];
      let pump = 0;
      for (let seed = 1; seed <= N; seed++) {
        const r = randomRecipe(seed * 7919 + 13, { ...defaultRecipe(), mode }, VIEW);
        const rock = r.rosettes.filter((x) => x.enabled && x.axis === 'rock');
        counts[Math.min(4, rock.length)]++;
        expect(rock.length, `${mode} seed ${seed}`).toBeGreaterThanOrEqual(1);
        if (r.rosettes.some((x) => x.enabled && x.axis === 'pump')) pump++;
      }
      expect(counts[1] / N, `${mode} single-rosette share`).toBeLessThan(0.25);
      expect(counts[2] / N, `${mode} two-rosette share`).toBeGreaterThan(0.3);
      expect((counts[3] + counts[4]) / N, `${mode} 3–4 rosette share`).toBeGreaterThan(0.28);
      expect(pump / N, `${mode} pump share`).toBeGreaterThan(0.38);
      expect(pump / N, `${mode} pump share`).toBeLessThan(0.65);
    }
  });

  it('relates secondaries to the primary: other profile, 20–70 % amplitude, related lobes, own phase', () => {
    let coprime = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const r = randomRecipe(seed, seed % 2 ? base : { ...defaultRecipe(), mode: 'metal' }, VIEW);
      const [p, ...secs] = r.rosettes.filter((x) => x.enabled && x.axis === 'rock');
      for (const q of secs) {
        expect(q.profile, `seed ${seed}`).not.toBe(p.profile);
        expect(q.amplitude, `seed ${seed}`).toBeLessThanOrEqual(0.7 * p.amplitude + 0.002);
        expect(q.lobes).not.toBe(p.lobes);
        const related = q.lobes % p.lobes === 0 || p.lobes % q.lobes === 0;
        if (!related) coprime++;
      }
    }
    // Near-coprime beat partners appear, but as the minority.
    expect(coprime).toBeGreaterThan(5);
  });

  it('keeps the summed rock amplitude within the spacing rule (no blobs)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = randomRecipe(seed, seed % 2 ? base : { ...defaultRecipe(), mode: 'metal' }, VIEW);
      const sp = passSpacing(r);
      if (!sp || r.eccentric.enabled) continue;
      const sum = r.rosettes.filter((x) => x.enabled && x.axis === 'rock').reduce((a, x) => a + x.amplitude, 0);
      const group = r.slide.phaseMode === 'alternate' ? r.slide.alternateEvery : 1;
      expect(sum / sp / group, `seed ${seed} ${r.name}`).toBeLessThanOrEqual(5.6);
    }
  });

  it('makes pump modulation visible: ink headstock travel, metal depth swing vs the shallowest cut', () => {
    let metalPumps = 0;
    let strong = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const ink = randomRecipe(seed, base, VIEW);
      for (const q of ink.rosettes.filter((x) => x.axis === 'pump')) expect(q.amplitude).toBeGreaterThanOrEqual(0.05);
      const m = randomRecipe(seed, { ...defaultRecipe(), mode: 'metal' }, VIEW);
      const pumps = m.rosettes.filter((x) => x.enabled && x.axis === 'pump');
      if (!pumps.length) continue;
      metalPumps++;
      const reach = pumps.reduce((a, x) => a + x.amplitude, 0) * Math.max(1, m.slide.amplitudeTaper);
      const shallow = m.metal.baseDepth - reach;
      expect(shallow).toBeGreaterThan(0);
      if (reach / shallow >= 0.4) strong++;
    }
    expect(strong / metalPumps).toBeGreaterThan(0.8);
  });

  it('uses translucent enamel sometimes in metal mode', () => {
    const metal = { ...defaultRecipe(), mode: 'metal' as const };
    let enamel = 0;
    for (let seed = 0; seed < 200; seed++) {
      const r = randomRecipe(seed, metal, VIEW);
      if (!r.metal.enamel) continue;
      enamel++;
      expect(r.metal.enamelOpacity).toBeGreaterThanOrEqual(0.3);
      expect(r.metal.enamelOpacity).toBeLessThanOrEqual(0.55);
      expect(r.metal.enamelColor).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(enamel).toBeGreaterThan(30);
    expect(enamel).toBeLessThan(100);
  });

  it('gives fresh rosette ids to generated rosettes', () => {
    const r = randomRecipe(9, base, []);
    expect(r.rosettes.length).toBeGreaterThan(0);
    for (const ros of r.rosettes) expect(ros.id).not.toBe('r0');
  });

  it('honours recipe path locks', () => {
    const cur = defaultRecipe();
    cur.slide.passes = 77;
    cur.slide.startRadius = 13.3;
    cur.ink.paper = '#123456';
    cur.machine.rubberRadius = 4.4;
    const locks = ['slide.passes', 'slide.startRadius', 'ink.paper', 'machine.rubberRadius', 'name'];
    for (let seed = 0; seed < 60; seed++) {
      const r = randomRecipe(seed, cur, [...locks, ...VIEW]);
      for (const k of locks) expect(getPath(r, k), `${k} seed ${seed}`).toEqual(getPath(cur, k));
    }
  });

  it('respects locked chuck switches by adapting the family', () => {
    const cur = defaultRecipe();
    cur.eccentric.enabled = false;
    cur.slide.spiral = false;
    for (let seed = 0; seed < 100; seed++) {
      const r = randomRecipe(seed, cur, ['eccentric.enabled', 'slide.spiral', ...VIEW]);
      expect(r.eccentric.enabled).toBe(false);
      expect(r.slide.spiral).toBe(false);
      expect(r.name.startsWith('Rosace')).toBe(false);
    }
    const on = defaultRecipe();
    on.eccentric.enabled = true;
    for (let seed = 0; seed < 50; seed++) {
      const r = randomRecipe(seed, on, ['eccentric.enabled', ...VIEW]);
      expect(r.eccentric.enabled).toBe(true);
      expect(r.eccentric.divisions).toBeGreaterThanOrEqual(1);
      expectInRanges(r);
    }
    const linear = defaultRecipe();
    linear.slide.phaseMode = 'linear';
    for (let seed = 0; seed < 50; seed++) {
      expect(randomRecipe(seed, linear, ['slide.phaseMode', ...VIEW]).slide.phaseMode).toBe('linear');
    }
  });

  it('honours single-rosette field locks', () => {
    const cur = defaultRecipe();
    cur.rosettes = [defaultRosette({ id: 'keep', lobes: 17, profile: 'flame' }), defaultRosette({ id: 'other', lobes: 5 })];
    for (let seed = 0; seed < 80; seed++) {
      const r = randomRecipe(seed, cur, ['rosettes.keep.lobes', 'rosettes.keep.profile', ...VIEW]);
      const kept = r.rosettes.find((x) => x.id === 'keep');
      expect(kept, `seed ${seed}`).toBeDefined();
      expect(kept!.lobes).toBe(17);
      expect(kept!.profile).toBe('flame');
      expect(r.rosettes.some((x) => x.id === 'other')).toBe(false);
      expectInRanges(r);
    }
  });

  it('honours a locked pump rosette axis', () => {
    const cur = defaultRecipe();
    cur.rosettes = [defaultRosette({ id: 'pp', axis: 'pump', amplitude: 0.1, lobes: 6 })];
    for (let seed = 0; seed < 40; seed++) {
      const r = randomRecipe(seed, cur, ['rosettes.pp.axis', 'rosettes.pp.amplitude', ...VIEW]);
      const kept = r.rosettes.find((x) => x.id === 'pp')!;
      expect(kept.axis).toBe('pump');
      expect(kept.amplitude).toBe(0.1);
      expect(r.rosettes.some((x) => x.axis === 'rock')).toBe(true);
    }
  });

  it('honours the whole-stack rosettes lock', () => {
    const cur = defaultRecipe();
    cur.rosettes = [defaultRosette({ id: 'a', lobes: 9, amplitude: 2.5 }), defaultRosette({ id: 'b', lobes: 27, amplitude: 0.3, profile: 'concave' })];
    for (let seed = 0; seed < 80; seed++) {
      const r = randomRecipe(seed, cur, ['rosettes', ...VIEW]);
      expect(r.rosettes).toEqual(cur.rosettes);
      expectInRanges(r);
    }
  });

  it('keeps locked values when the lock is on a parent path', () => {
    const cur = defaultRecipe();
    cur.elliptical = { enabled: true, e: 9, angle: 45 };
    for (let seed = 0; seed < 30; seed++) {
      expect(randomRecipe(seed, cur, ['elliptical', ...VIEW]).elliptical).toEqual(cur.elliptical);
    }
  });
});

describe('mutateRecipe', () => {
  it('is deterministic and keeps the name, updates the seed', () => {
    const cur = randomRecipe(12, defaultRecipe(), VIEW);
    const a = mutateRecipe(cur, 99, VIEW);
    const b = mutateRecipe(cur, 99, VIEW);
    expect(stripIds(a)).toEqual(stripIds(b));
    expect(a.name).toBe(cur.name);
    expect(a.seed).toBe(99);
    // Existing rosettes keep their ids (Mutate may add one with a fresh id or drop a secondary).
    const curIds = new Set(cur.rosettes.map((r) => r.id));
    expect(a.rosettes.filter((r) => curIds.has(r.id)).length).toBeGreaterThanOrEqual(cur.rosettes.length - 1);
  });

  it('changes something but stays close', () => {
    const cur = defaultRecipe();
    const m = mutateRecipe(cur, 5, VIEW);
    expect(m).not.toEqual(cur);
    expect(Math.abs(m.slide.passes - cur.slide.passes)).toBeLessThan(30);
    expect(Math.abs(m.slide.endRadius - cur.slide.endRadius)).toBeLessThan(25);
  });

  it('respects ranges', () => {
    let r = randomRecipe(3, defaultRecipe(), VIEW);
    for (let i = 0; i < 300; i++) {
      r = mutateRecipe(r, i, VIEW, 0.5);
      expectInRanges(r);
    }
  });

  it('sometimes adds or removes a secondary, never the last rock rosette', () => {
    let added = 0;
    let removed = 0;
    for (let s0 = 1; s0 <= 60; s0++) {
      let r = randomRecipe(s0, defaultRecipe(), VIEW);
      for (let i = 0; i < 8; i++) {
        const before = r.rosettes.filter((x) => x.axis === 'rock').length;
        r = mutateRecipe(r, s0 * 1000 + i, VIEW);
        const after = r.rosettes.filter((x) => x.axis === 'rock').length;
        if (after > before) added++;
        if (after < before) removed++;
        expect(after).toBeGreaterThanOrEqual(1);
        expect(r.rosettes.length).toBeLessThanOrEqual(8);
      }
    }
    expect(added).toBeGreaterThan(10);
    expect(removed).toBeGreaterThan(10);
  });

  it('nudges palette hue unless the palette is locked', () => {
    let changed = 0;
    for (let s0 = 1; s0 <= 40; s0++) {
      const cur = randomRecipe(s0, defaultRecipe(), VIEW);
      if (mutateRecipe(cur, s0, VIEW).ink.palette.join() !== cur.ink.palette.join()) changed++;
      const locked = mutateRecipe(cur, s0, ['ink.palette', 'rosettes', ...VIEW]);
      expect(locked.ink.palette).toEqual(cur.ink.palette);
      expect(locked.rosettes).toEqual(cur.rosettes);
    }
    expect(changed).toBeGreaterThan(15);
  });

  it('keeps metal fully cut after mutation', () => {
    for (let s0 = 0; s0 < 30; s0++) {
      let r = randomRecipe(s0, { ...defaultRecipe(), mode: 'metal' }, VIEW);
      for (let i = 0; i < 10; i++) {
        r = mutateRecipe(r, s0 * 100 + i, VIEW);
        const cov = grooveCoverage(r);
        if (cov === null || r.metal.baseDepth >= 0.4) continue;
        expect(cov, `${r.name} step ${i}`).toBeGreaterThanOrEqual(0.99);
        expect(cov, `${r.name} step ${i}`).toBeLessThanOrEqual(1.21);
      }
    }
  });

  it('respects locks', () => {
    const cur = defaultRecipe();
    cur.rosettes = [defaultRosette({ id: 'a', lobes: 12, amplitude: 1.2 }), defaultRosette({ id: 'b', lobes: 24, amplitude: 0.4 })];
    const locks = ['slide.passes', 'slide.endRadius', 'rosettes.a.amplitude', 'rosettes.a.profile', 'rosettes.b'];
    for (let seed = 0; seed < 100; seed++) {
      const m = mutateRecipe(cur, seed, [...locks, ...VIEW], 0.4);
      expect(m.slide.passes).toBe(cur.slide.passes);
      expect(m.slide.endRadius).toBe(cur.slide.endRadius);
      expect(m.rosettes[0].amplitude).toBe(1.2);
      expect(m.rosettes[0].profile).toBe(cur.rosettes[0].profile);
      expect(m.rosettes[1]).toEqual(cur.rosettes[1]);
    }
    for (let seed = 0; seed < 50; seed++) {
      expect(mutateRecipe(cur, seed, ['rosettes', ...VIEW], 0.5).rosettes).toEqual(cur.rosettes);
    }
  });
});

describe('maxPassGap', () => {
  /** 61 concentric passes from 10 to 40 mm (spacing 0.5), one 24-lobe sine rosette. */
  function band(amplitude: number, slide: Partial<Recipe['slide']> = {}): Recipe {
    const r = defaultRecipe();
    r.rosettes = [defaultRosette({ lobes: 24, amplitude, phase: 37 })];
    r.slide = { ...r.slide, startRadius: 10, endRadius: 40, passes: 61, amplitudeTaper: 1, ...slide };
    return r;
  }

  it('is about two spacings for anti-phased passes that just touch (barleycorn, 2A = s)', () => {
    const r = band(0.25, { phaseMode: 'alternate', alternateEvery: 1, alternateFraction: 0.5 });
    expect(passSpacing(r)).toBeCloseTo(0.5, 9);
    const g = maxPassGap(r)!;
    expect(g).toBeGreaterThan(0.95);
    expect(g).toBeLessThan(1.05);
  });

  it('is the spacing when every pass is the same curve (linear, no drift)', () => {
    const g = maxPassGap(band(0.8, { phaseMode: 'linear', phaseStep: 0 }))!;
    expect(g).toBeCloseTo(0.5, 6);
  });

  it('is the spacing with a zero-amplitude rosette', () => {
    expect(maxPassGap(band(0, { phaseMode: 'alternate', alternateFraction: 0.5 }))).toBeCloseTo(0.5, 9);
  });

  it('finds the nearest cut even when it is several passes away (stays far below s + 2ΣA)', () => {
    // Anti-phased, 2A = 3s: centrelines cross, so the widest gap is capped at two spacings.
    const g = maxPassGap(band(0.75, { phaseMode: 'alternate', alternateFraction: 0.5 }))!;
    expect(g).toBeGreaterThan(0.95);
    expect(g).toBeLessThan(1.05);
  });

  it('grows with the amplitude taper, handles spirals and returns null without a spacing', () => {
    const flat = maxPassGap(band(0.1, { phaseMode: 'alternate', alternateFraction: 0.5 }))!;
    const tapered = maxPassGap(band(0.1, { phaseMode: 'alternate', alternateFraction: 0.5, amplitudeTaper: 2 }))!;
    expect(flat).toBeCloseTo(0.7, 2);
    expect(tapered).toBeCloseTo(0.9, 2);
    const sp = band(0.25, { phaseMode: 'linear', phaseStep: 0, spiral: true, passes: 60 });
    expect(maxPassGap(sp)).toBeCloseTo(0.5, 6);
    expect(maxPassGap(band(0.25, { passes: 1 }))).toBeNull();
  });

  it('is fast enough to call once per Random / Mutate', () => {
    const metal = { ...defaultRecipe(), mode: 'metal' as const };
    const recipes = Array.from({ length: 200 }, (_, i) => randomRecipe(i, metal, VIEW));
    const t0 = performance.now();
    for (const r of recipes) maxPassGap(r);
    expect((performance.now() - t0) / recipes.length).toBeLessThan(15);
  });
});

describe('plate view-state (fill to edge, symmetry)', () => {
  it('keeps fill and symmetry from the current recipe when locked, with the RNG sequence of a free run', () => {
    for (const [fill, order, mirror] of [[false, 0, false], [true, 0, false], [false, 12, true], [true, 8, false], [true, 24, true]] as const) {
      for (const mode of ['ink', 'metal'] as const) {
        const cur = plate(mode, 32, fill, order, mirror);
        for (let seed = 0; seed < 20; seed++) {
          const r = randomRecipe(seed, cur, VIEW);
          expect(r.machine.fillEdge).toBe(fill);
          expect(r.symmetry).toEqual({ order, mirror });
          expect(r.machine.workDiameter).toBe(32);
        }
      }
    }
    // Locked view-state draws nothing: the whole sequence (the name is drawn last) matches the pre-view-state
    // generator for these seeds.
    const names = {
      ink: ['Rose Window No. 7919', 'Cartouche No. 5838', 'Nautilus No. 3757', 'Grain d’Orge No. 1676', 'Moiré No. 9595', 'Panier No. 7514', 'Radiance No. 5433', 'Sunburst No. 3352', 'Rose Window No. 1271', 'Flinqué Flame No. 9190', 'Tide No. 7109', 'Oval No. 5028'],
      metal: ['Rose Window No. 7919', 'Spiral No. 5838', 'Shimmer No. 3757', 'Grain d’Orge No. 1676', 'Moiré Wave No. 9595', 'Tide No. 7514', 'Bloom No. 5433', 'Rose Window No. 3352', 'Cartouche No. 1271', 'Flame No. 9190', 'Moiré Wave No. 7109', 'Nautilus No. 5028'],
    };
    for (const mode of ['ink', 'metal'] as const) {
      const got = Array.from({ length: 12 }, (_, i) => randomRecipe((i + 1) * 7919, plate(mode), VIEW).name);
      expect(got).toEqual(names[mode]);
    }
  });

  it('draws fill and symmetry when unlocked, and the families honour the draw', () => {
    const N = 400;
    const orders = new Map<number, number>();
    let fill = 0;
    let mirror = 0;
    let sym = 0;
    for (let seed = 0; seed < N; seed++) {
      const cur = plate(seed % 2 ? 'metal' : 'ink', 32, true, 12, true);
      const r = randomRecipe(seed, cur, []);
      expectInRanges(r);
      expect(r.machine.workDiameter, 'plate size is never randomized').toBe(32);
      const o = r.symmetry.order;
      orders.set(o, (orders.get(o) ?? 0) + 1);
      if (r.machine.fillEdge) fill++;
      if (o >= 2) {
        sym++;
        if (r.symmetry.mirror) mirror++;
        for (const x of r.rosettes.filter((q) => q.enabled)) expect(x.lobes % o, `seed ${seed} ${r.name} order ${o}`).toBe(0);
      } else {
        expect(r.symmetry.mirror).toBe(false);
      }
      if (r.machine.fillEdge) expect(r.slide.endRadius, `seed ${seed} ${r.name}`).toBeCloseTo(16, 6);
    }
    expect([...orders.keys()].sort((a, b) => a - b)).toEqual([0, 6, 8, 12, 24]);
    expect(orders.get(0)! / N).toBeGreaterThan(0.28);
    expect(orders.get(0)! / N).toBeLessThan(0.47);
    expect(orders.get(12)! / N).toBeGreaterThan(orders.get(8)! / N);
    expect(fill / N).toBeGreaterThan(0.27);
    expect(fill / N).toBeLessThan(0.43);
    expect(mirror / sym).toBeGreaterThan(0.3);
    expect(mirror / sym).toBeLessThan(0.5);
  });

  it('Mutate never changes fill, symmetry or the plate size, locked or not', () => {
    for (const locks of [[], VIEW]) {
      for (let s0 = 0; s0 < 20; s0++) {
        let r = randomRecipe(s0, plate(s0 % 2 ? 'metal' : 'ink', 40, true, 8, s0 % 3 === 0), VIEW);
        for (let i = 0; i < 6; i++) {
          r = mutateRecipe(r, s0 * 100 + i, locks, 0.4);
          expect(r.machine.fillEdge).toBe(true);
          expect(r.symmetry).toEqual({ order: 8, mirror: s0 % 3 === 0 });
          expect(r.machine.workDiameter).toBe(40);
        }
      }
    }
  });
});

describe('fill to edge', () => {
  it('solves passes over the effective end and leaves the slide end at the plate radius (no fitToWork shrink)', () => {
    for (const dia of [100, 32]) {
      for (const mode of ['ink', 'metal'] as const) {
        for (let seed = 0; seed < 150; seed++) {
          const r = randomRecipe(seed, plate(mode, dia, true), VIEW);
          const R = plateRadius(r);
          expectInRanges(r);
          expect(r.slide.endRadius, `${mode} ${dia} seed ${seed} ${r.name}`).toBeCloseTo(R, 6);
          const E = effectiveEndRadius(r);
          expect(E).toBeCloseTo(fillEndRadius(r), 9);
          expect(E).toBeGreaterThanOrEqual(R + chuckReach(r) + rockReach(r));
          const span = Math.abs(E - r.slide.startRadius);
          const divs = r.slide.spiral && r.eccentric.enabled ? r.eccentric.divisions : 1;
          const sp = r.slide.spiral ? span / r.slide.passes / divs : span / (r.slide.passes - 1);
          expect(passSpacing(r)!, `${mode} ${dia} seed ${seed}`).toBeCloseTo(sp, 9);
          // Spacing stays at watch-dial / dial scale over the longer span.
          expect(passSpacing(r)! / (R / 50), `${mode} ${dia} seed ${seed} ${r.name}`).toBeLessThan(r.eccentric.enabled && !r.slide.spiral ? 6.5 : 3.6);
        }
      }
    }
  });

  it('keeps metal coverage and the barleycorn 2·ΣA ≈ spacing rule over the real span', () => {
    let capped = 0;
    let barley = 0;
    for (const dia of [100, 32]) {
      for (const mode of ['ink', 'metal'] as const) {
        for (let seed = 0; seed < 200; seed++) {
          const r = randomRecipe(seed, plate(mode, dia, true), VIEW);
          const sp = passSpacing(r)!;
          if (mode === 'metal') {
            if (!(r.eccentric.enabled && !r.slide.spiral)) {
              expect(sp, `${dia} seed ${seed} ${r.name}`).toBeGreaterThan(dia === 100 ? 0.2 : 0.1);
              expect(sp, `${dia} seed ${seed} ${r.name}`).toBeLessThan(1.05);
            }
            if (r.metal.baseDepth >= 0.4 && familyOf(r) !== 'barleycorn') {
              capped++;
            } else {
              const cov = grooveCoverage(r)!;
              expect(cov, `${dia} seed ${seed} ${r.name}`).toBeGreaterThanOrEqual(0.99);
              expect(cov, `${dia} seed ${seed} ${r.name}`).toBeLessThanOrEqual(1.25);
            }
          }
          if (familyOf(r) === 'barleycorn') {
            barley++;
            const ratio = (2 * rockSum(r)) / sp;
            expect(ratio, `${mode} ${dia} seed ${seed} ${r.name}`).toBeGreaterThanOrEqual(0.85);
            expect(ratio, `${mode} ${dia} seed ${seed} ${r.name}`).toBeLessThanOrEqual(1.25);
            expect(maxPassGap(r)! / sp, `${mode} ${dia} seed ${seed}`).toBeLessThanOrEqual(2.01);
          }
        }
      }
    }
    expect(capped).toBeLessThan(20);
    expect(barley).toBeGreaterThan(80);
  });

  it('runs the cut off the rim (real toolpath), chuck families included', () => {
    const seen = new Set<string>();
    for (const mode of ['ink', 'metal'] as const) {
      for (let seed = 1; seed <= 40; seed++) {
        const r = randomRecipe(seed * 7919 + 13, plate(mode, 100, true), VIEW);
        const tp = computeToolpath(prepare(r, { maxSamples: 30_000 }));
        let ext = 0;
        for (let i = 0; i < tp.totalSamples; i++) ext = Math.max(ext, Math.hypot(tp.x[i], tp.y[i]));
        expect(ext, `${mode} seed ${seed} ${r.name}`).toBeGreaterThan(plateRadius(r));
        seen.add(familyOf(r) ?? '?');
      }
    }
    expect(seen.has('rosace') && seen.has('cartouche')).toBe(true);
  });

  it('measures passSpacing / maxPassGap / grooveCoverage over the effective end', () => {
    const r = defaultRecipe();
    r.rosettes = [defaultRosette({ lobes: 24, amplitude: 0.25 })];
    r.slide = { ...r.slide, startRadius: 10, endRadius: 30, passes: 41, phaseMode: 'linear', phaseStep: 0, amplitudeTaper: 1 };
    expect(passSpacing(r)).toBeCloseTo(0.5, 9);
    r.machine = { ...r.machine, fillEdge: true };
    const E = 50 + 0.25 + 0.2;
    expect(passSpacing(r)).toBeCloseTo((E - 10) / 40, 9);
    expect(maxPassGap(r)).toBeCloseTo((E - 10) / 40, 6);
    expect(grooveCoverage(r)).toBeGreaterThan(0);
  });

  it('keeps metal fully cut after mutation with fill on', () => {
    for (let s0 = 0; s0 < 20; s0++) {
      let r = randomRecipe(s0, plate('metal', 100, true), VIEW);
      for (let i = 0; i < 6; i++) {
        r = mutateRecipe(r, s0 * 100 + i, VIEW);
        const cov = grooveCoverage(r);
        if (cov === null || r.metal.baseDepth >= 0.4) continue;
        expect(cov, `${r.name} step ${i}`).toBeGreaterThanOrEqual(0.99);
        expect(cov, `${r.name} step ${i}`).toBeLessThanOrEqual(1.21);
      }
    }
  });
});

describe('symmetry', () => {
  /** Summed rock (or pump) displacement at work angle psi (degrees), pass phase 0 (machine.ts u convention). */
  function stack(r: Recipe, axis: 'rock' | 'pump', psi: number): number {
    let v = 0;
    for (const x of r.rosettes) {
      if (!x.enabled || x.axis !== axis) continue;
      const u = (x.lobes * psi) / 360 + (x.phase * x.lobes) / 360;
      v += x.amplitude * profileAt(x.profile, u);
    }
    return v;
  }
  function profileAt(kind: Recipe['rosettes'][number]['profile'], u: number): number {
    u -= Math.floor(u);
    switch (kind) {
      case 'sine':
        return Math.cos(2 * Math.PI * u);
      case 'triangle':
        return 1 - 4 * Math.abs(u - Math.round(u));
      case 'square':
        return Math.tanh(4 * Math.cos(2 * Math.PI * u)) / Math.tanh(4);
      case 'convex': {
        const t = 2 * Math.abs(u - Math.round(u));
        return 2 * Math.sqrt(Math.max(0, 1 - t * t)) - 1;
      }
      case 'concave': {
        const t = 2 * Math.abs(u - Math.round(u));
        return 1 - 2 * Math.sqrt(Math.max(0, t * (2 - t)));
      }
      default:
        return NaN; // asymmetric profiles never appear under mirror
    }
  }

  it('order 12: every enabled lobe count is a multiple of 12, divisions are 12 and evenly spaced (300 seeds)', () => {
    for (const mode of ['ink', 'metal'] as const) {
      for (const fill of [false, true]) {
        let spirals = 0;
        for (let seed = 0; seed < 300; seed++) {
          const r = randomRecipe(seed, plate(mode, 100, fill, 12), VIEW);
          expectInRanges(r);
          for (const x of r.rosettes.filter((q) => q.enabled)) expect(x.lobes % 12, `${mode} fill ${fill} seed ${seed} ${r.name} ${x.axis}`).toBe(0);
          expect(r.elliptical.enabled, 'an ellipse is only 2-fold').toBe(false);
          if (r.eccentric.enabled) {
            expect(12 % r.eccentric.divisions).toBe(0);
            expect(r.eccentric.divisions).toBe(12);
            expect(r.eccentric.divisionStep).toBe(0);
          }
          if (r.slide.spiral) {
            spirals++;
            expect(r.eccentric.enabled && r.eccentric.divisions === 12, `${seed} ${r.name}`).toBe(true);
          }
        }
        expect(spirals).toBeGreaterThan(5);
      }
    }
  });

  it('other orders: lobes on multiples of 6, 8, 24 (secondaries and pumps too, no coprime partners)', () => {
    for (const order of [6, 8, 24]) {
      for (let seed = 0; seed < 120; seed++) {
        const r = randomRecipe(seed, plate(seed % 2 ? 'metal' : 'ink', seed % 3 ? 100 : 32, seed % 4 === 0, order), VIEW);
        expectInRanges(r);
        for (const x of r.rosettes.filter((q) => q.enabled)) expect(x.lobes % order, `order ${order} seed ${seed} ${r.name}`).toBe(0);
      }
    }
  });

  it('mirror: symmetric profiles, no linear twist, half-lobe alternation, stack symmetric about 12–6', () => {
    for (const mode of ['ink', 'metal'] as const) {
      for (let seed = 0; seed < 300; seed++) {
        const r = randomRecipe(seed, plate(mode, 100, seed % 3 === 0, 12, true), VIEW);
        const tag = `${mode} seed ${seed} ${r.name}`;
        for (const x of r.rosettes.filter((q) => q.enabled)) expect(['flame', 'saw'], tag).not.toContain(x.profile);
        expect(r.slide.spiral, tag).toBe(false);
        if (r.slide.phaseMode === 'linear') expect(r.slide.phaseStep, tag).toBe(0);
        if (r.slide.phaseMode === 'alternate') expect([0, 0.5, 1], tag).toContain(r.slide.alternateFraction);
        if (r.eccentric.enabled) expect([90, 270], tag).toContain(r.eccentric.angle);
        for (const axis of ['rock', 'pump'] as const) {
          for (const d of [3.7, 11.3, 29, 61]) expect(stack(r, axis, 90 + d), `${tag} ${axis} ±${d}°`).toBeCloseTo(stack(r, axis, 90 - d), 6);
        }
      }
    }
    for (const L of [3, 6, 7, 12, 18, 30, 42, 96]) {
      const u = L / 4 + (mirrorPhase(L) * L) / 360;
      expect(Math.abs(u - Math.round(u)), `peak on 12 o'clock for ${L} lobes`).toBeLessThan(1e-3);
    }
  });

  it('order without mirror: linear drift twists the whole program by whole 360°/N steps (at least one)', () => {
    let drifting = 0;
    for (let seed = 0; seed < 300; seed++) {
      const r = randomRecipe(seed, plate('ink', 100, seed % 2 === 0, 8), VIEW);
      if (r.slide.phaseMode !== 'linear' || r.slide.phaseStep === 0) continue;
      drifting++;
      const turns = r.slide.spiral ? r.slide.passes : r.slide.passes - 1;
      const steps = (r.slide.phaseStep * turns) / (360 / 8);
      expect(Math.abs(steps - Math.round(steps)), `seed ${seed} ${r.name}`).toBeLessThan(1e-6);
      expect(Math.abs(Math.round(steps))).toBeGreaterThanOrEqual(1);
      expect(Math.abs(r.slide.phaseStep)).toBeLessThanOrEqual(30);
    }
    expect(drifting).toBeGreaterThan(60);
  });

  it('is deterministic with symmetry and fill, and keeps metal coverage', () => {
    for (let seed = 0; seed < 150; seed++) {
      const cur = plate('metal', seed % 2 ? 100 : 32, seed % 3 === 0, seed % 2 ? 12 : 24, seed % 4 === 0);
      const a = randomRecipe(seed, cur, VIEW);
      expect(stripIds(a)).toEqual(stripIds(randomRecipe(seed, cur, VIEW)));
      if (a.metal.baseDepth >= 0.4) continue;
      const cov = grooveCoverage(a)!;
      expect(cov, `seed ${seed} ${a.name}`).toBeGreaterThanOrEqual(0.99);
      expect(cov, `seed ${seed} ${a.name}`).toBeLessThanOrEqual(1.25);
    }
  });

  it('Mutate keeps lobes on multiples of N and the mirror rules', () => {
    for (let s0 = 0; s0 < 40; s0++) {
      const mirror = s0 % 2 === 0;
      let r = randomRecipe(s0, plate(s0 % 3 ? 'ink' : 'metal', 100, false, 12, mirror), VIEW);
      for (let i = 0; i < 8; i++) {
        r = mutateRecipe(r, s0 * 1000 + i, [], 0.5);
        const tag = `${r.name} step ${i}`;
        expectInRanges(r);
        for (const x of r.rosettes.filter((q) => q.enabled)) expect(x.lobes % 12, tag).toBe(0);
        if (r.eccentric.enabled) expect(r.eccentric.divisions, tag).toBe(12);
        if (mirror) {
          for (const x of r.rosettes.filter((q) => q.enabled)) expect(['flame', 'saw'], tag).not.toContain(x.profile);
          if (r.slide.phaseMode === 'linear') expect(r.slide.phaseStep, tag).toBe(0);
        }
      }
    }
  });
});

describe('plate size', () => {
  it('32 mm metal dial: watch-dial fine (spacing 0.12–0.31 mm, grain aspect 1.5–4.6, lobes ≤ 300)', () => {
    let barley = 0;
    for (let seed = 0; seed < 300; seed++) {
      const r = randomRecipe(seed, plate('metal', 32), VIEW);
      for (const x of r.rosettes) expect(x.lobes, `seed ${seed} ${r.name}`).toBeLessThanOrEqual(300);
      if (familyOf(r) !== 'barleycorn') continue;
      barley++;
      const sp = passSpacing(r)!;
      expect(sp, `seed ${seed}`).toBeGreaterThan(0.12);
      expect(sp, `seed ${seed}`).toBeLessThan(0.31);
      const L = r.rosettes[0].lobes;
      const aspect = (2 * Math.PI * 0.6 * (16 - 0.64)) / L / (2 * sp);
      expect(aspect, `seed ${seed} L ${L} sp ${sp}`).toBeGreaterThan(1.5);
      expect(aspect, `seed ${seed} L ${L} sp ${sp}`).toBeLessThan(4.6);
    }
    expect(barley).toBeGreaterThan(40);
  });

  it('gives metal cartouche and pumped alternates barleycorn grains, not slivers', () => {
    let n = 0;
    for (let seed = 0; seed < 400; seed++) {
      const r = randomRecipe(seed, plate('metal'), VIEW);
      const fam = familyOf(r);
      if ((fam !== 'cartouche' && fam !== 'pumped') || r.slide.phaseMode !== 'alternate') continue;
      n++;
      const L = r.rosettes[0].lobes;
      const sp = passSpacing(r)!;
      const aspect = (2 * Math.PI * 0.6 * 48) / L / (2 * sp);
      expect(aspect, `seed ${seed} ${r.name} L ${L}`).toBeLessThan(4.6);
    }
    expect(n).toBeGreaterThan(10);
  });
});
