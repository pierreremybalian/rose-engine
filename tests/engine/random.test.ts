import { describe, expect, it } from 'vitest';
import { FAMILIES, MIN_INK_CONTRAST, contrastRatio, grooveCoverage, mulberry32, mutateRecipe, passSpacing, randomRecipe } from '../../src/engine/random';
import { PALETTES, PARAMS, ROSETTE_PARAMS, getPath } from '../../src/state/params';
import { defaultRecipe, defaultRosette, type Recipe } from '../../src/state/recipe';
import { computeToolpath, prepare } from '../../src/engine/index';

/** Rosette ids come from newRosetteId (time-based), so compare recipes with ids normalised. */
function stripIds(r: Recipe): Recipe {
  return { ...r, rosettes: r.rosettes.map((x, i) => ({ ...x, id: `#${i}` })) };
}

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
      const r = randomRecipe(seed, seed % 2 ? metal : base, []);
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
          const r = randomRecipe(seed * 7919 + 13, cur, []);
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

  it('cuts full-coverage metal: grooves meet or overlap at fine spacing', () => {
    const metal = { ...defaultRecipe(), mode: 'metal' as const };
    const angles: number[] = [];
    const depths: number[] = [];
    for (let seed = 0; seed < 300; seed++) {
      const r = randomRecipe(seed, metal, []);
      const sp = passSpacing(r);
      expect(sp, `seed ${seed} ${r.name}`).not.toBeNull();
      expect(sp!, `seed ${seed} ${r.name}`).toBeGreaterThan(0.2);
      expect(sp!, `seed ${seed} ${r.name}`).toBeLessThan(1.05);
      const cov = grooveCoverage(r)!;
      expect(cov, `seed ${seed} ${r.name} sp ${sp}`).toBeGreaterThanOrEqual(0.99);
      expect(cov, `seed ${seed} ${r.name} sp ${sp}`).toBeLessThanOrEqual(1.45);
      angles.push(r.metal.toolAngle);
      depths.push(r.metal.baseDepth);
    }
    // Depth and tool angle vary widely while coverage holds.
    expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(35);
    expect(Math.max(...depths) / Math.min(...depths)).toBeGreaterThan(4);
  });

  it('keeps ink pen width and opacity in a readable band', () => {
    for (let seed = 0; seed < 100; seed++) {
      const r = randomRecipe(seed, defaultRecipe(), []);
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
      const r = randomRecipe(seed, base, []);
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
        const r = randomRecipe(seed * 7919 + 13, { ...defaultRecipe(), mode }, []);
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
      const r = randomRecipe(seed, seed % 2 ? base : { ...defaultRecipe(), mode: 'metal' }, []);
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
      const r = randomRecipe(seed, seed % 2 ? base : { ...defaultRecipe(), mode: 'metal' }, []);
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
      const ink = randomRecipe(seed, base, []);
      for (const q of ink.rosettes.filter((x) => x.axis === 'pump')) expect(q.amplitude).toBeGreaterThanOrEqual(0.05);
      const m = randomRecipe(seed, { ...defaultRecipe(), mode: 'metal' }, []);
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
      const r = randomRecipe(seed, metal, []);
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
      const r = randomRecipe(seed, cur, locks);
      for (const k of locks) expect(getPath(r, k), `${k} seed ${seed}`).toEqual(getPath(cur, k));
    }
  });

  it('respects locked chuck switches by adapting the family', () => {
    const cur = defaultRecipe();
    cur.eccentric.enabled = false;
    cur.slide.spiral = false;
    for (let seed = 0; seed < 100; seed++) {
      const r = randomRecipe(seed, cur, ['eccentric.enabled', 'slide.spiral']);
      expect(r.eccentric.enabled).toBe(false);
      expect(r.slide.spiral).toBe(false);
      expect(r.name.startsWith('Rosace')).toBe(false);
    }
    const on = defaultRecipe();
    on.eccentric.enabled = true;
    for (let seed = 0; seed < 50; seed++) {
      const r = randomRecipe(seed, on, ['eccentric.enabled']);
      expect(r.eccentric.enabled).toBe(true);
      expect(r.eccentric.divisions).toBeGreaterThanOrEqual(1);
      expectInRanges(r);
    }
    const linear = defaultRecipe();
    linear.slide.phaseMode = 'linear';
    for (let seed = 0; seed < 50; seed++) {
      expect(randomRecipe(seed, linear, ['slide.phaseMode']).slide.phaseMode).toBe('linear');
    }
  });

  it('honours single-rosette field locks', () => {
    const cur = defaultRecipe();
    cur.rosettes = [defaultRosette({ id: 'keep', lobes: 17, profile: 'flame' }), defaultRosette({ id: 'other', lobes: 5 })];
    for (let seed = 0; seed < 80; seed++) {
      const r = randomRecipe(seed, cur, ['rosettes.keep.lobes', 'rosettes.keep.profile']);
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
      const r = randomRecipe(seed, cur, ['rosettes.pp.axis', 'rosettes.pp.amplitude']);
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
      const r = randomRecipe(seed, cur, ['rosettes']);
      expect(r.rosettes).toEqual(cur.rosettes);
      expectInRanges(r);
    }
  });

  it('keeps locked values when the lock is on a parent path', () => {
    const cur = defaultRecipe();
    cur.elliptical = { enabled: true, e: 9, angle: 45 };
    for (let seed = 0; seed < 30; seed++) {
      expect(randomRecipe(seed, cur, ['elliptical']).elliptical).toEqual(cur.elliptical);
    }
  });
});

describe('mutateRecipe', () => {
  it('is deterministic and keeps the name, updates the seed', () => {
    const cur = randomRecipe(12, defaultRecipe(), []);
    const a = mutateRecipe(cur, 99, []);
    const b = mutateRecipe(cur, 99, []);
    expect(stripIds(a)).toEqual(stripIds(b));
    expect(a.name).toBe(cur.name);
    expect(a.seed).toBe(99);
    // Existing rosettes keep their ids (Mutate may add one with a fresh id or drop a secondary).
    const curIds = new Set(cur.rosettes.map((r) => r.id));
    expect(a.rosettes.filter((r) => curIds.has(r.id)).length).toBeGreaterThanOrEqual(cur.rosettes.length - 1);
  });

  it('changes something but stays close', () => {
    const cur = defaultRecipe();
    const m = mutateRecipe(cur, 5, []);
    expect(m).not.toEqual(cur);
    expect(Math.abs(m.slide.passes - cur.slide.passes)).toBeLessThan(30);
    expect(Math.abs(m.slide.endRadius - cur.slide.endRadius)).toBeLessThan(25);
  });

  it('respects ranges', () => {
    let r = randomRecipe(3, defaultRecipe(), []);
    for (let i = 0; i < 300; i++) {
      r = mutateRecipe(r, i, [], 0.5);
      expectInRanges(r);
    }
  });

  it('sometimes adds or removes a secondary, never the last rock rosette', () => {
    let added = 0;
    let removed = 0;
    for (let s0 = 1; s0 <= 60; s0++) {
      let r = randomRecipe(s0, defaultRecipe(), []);
      for (let i = 0; i < 8; i++) {
        const before = r.rosettes.filter((x) => x.axis === 'rock').length;
        r = mutateRecipe(r, s0 * 1000 + i, []);
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
      const cur = randomRecipe(s0, defaultRecipe(), []);
      if (mutateRecipe(cur, s0, []).ink.palette.join() !== cur.ink.palette.join()) changed++;
      const locked = mutateRecipe(cur, s0, ['ink.palette', 'rosettes']);
      expect(locked.ink.palette).toEqual(cur.ink.palette);
      expect(locked.rosettes).toEqual(cur.rosettes);
    }
    expect(changed).toBeGreaterThan(15);
  });

  it('keeps metal grooves meeting after mutation', () => {
    for (let s0 = 0; s0 < 30; s0++) {
      let r = randomRecipe(s0, { ...defaultRecipe(), mode: 'metal' }, []);
      for (let i = 0; i < 10; i++) {
        r = mutateRecipe(r, s0 * 100 + i, []);
        const cov = grooveCoverage(r);
        if (cov === null || r.metal.baseDepth >= 0.4) continue;
        expect(cov, `${r.name} step ${i}`).toBeGreaterThanOrEqual(0.99);
        expect(cov, `${r.name} step ${i}`).toBeLessThanOrEqual(1.41);
      }
    }
  });

  it('respects locks', () => {
    const cur = defaultRecipe();
    cur.rosettes = [defaultRosette({ id: 'a', lobes: 12, amplitude: 1.2 }), defaultRosette({ id: 'b', lobes: 24, amplitude: 0.4 })];
    const locks = ['slide.passes', 'slide.endRadius', 'rosettes.a.amplitude', 'rosettes.a.profile', 'rosettes.b'];
    for (let seed = 0; seed < 100; seed++) {
      const m = mutateRecipe(cur, seed, locks, 0.4);
      expect(m.slide.passes).toBe(cur.slide.passes);
      expect(m.slide.endRadius).toBe(cur.slide.endRadius);
      expect(m.rosettes[0].amplitude).toBe(1.2);
      expect(m.rosettes[0].profile).toBe(cur.rosettes[0].profile);
      expect(m.rosettes[1]).toEqual(cur.rosettes[1]);
    }
    for (let seed = 0; seed < 50; seed++) {
      expect(mutateRecipe(cur, seed, ['rosettes'], 0.5).rosettes).toEqual(cur.rosettes);
    }
  });
});
