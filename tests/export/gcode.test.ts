import { describe, expect, it } from 'vitest';
import { buildGcode, fmtG, PEN_MOVE_SECONDS, RAPID_RATE } from '../../src/export/gcode';
import { DEFAULT_GCODE_OPTIONS, type GcodeOptions } from '../../src/export/types';
import type { Toolpath } from '../../src/engine/types';
import { makeToolpath, recipeWith, ringsToolpath, spiralToolpath } from './fixtures';

const pen: GcodeOptions = { ...DEFAULT_GCODE_OPTIONS, tolerance: 0 };
const cncOpts: GcodeOptions = { ...DEFAULT_GCODE_OPTIONS, profile: 'cnc', tolerance: 0 };

interface Move {
  g: 0 | 1;
  x?: number;
  y?: number;
  z?: number;
  f?: number;
}

function parse(text: string): { lines: string[]; moves: Move[] } {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const moves: Move[] = [];
  for (const raw of lines) {
    const line = raw.replace(/;.*$/, '').trim();
    const m = /^G([01])\b(.*)$/.exec(line);
    if (!m) continue;
    const mv: Move = { g: Number(m[1]) as 0 | 1 };
    for (const w of m[2].matchAll(/([XYZF])(-?\d+(?:\.\d+)?)/g)) {
      (mv as unknown as Record<string, number>)[w[1].toLowerCase()] = Number(w[2]);
    }
    moves.push(mv);
  }
  return { lines, moves };
}

/** Split G-code into strokes: [G0 start, ...G1 XY points] between pen-down and pen-up (pen profile). */
function penStrokes(text: string, opts: GcodeOptions): [number, number][][] {
  const strokes: [number, number][][] = [];
  let cur: [number, number][] | null = null;
  let pos: [number, number] = [0, 0];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === opts.penDown) cur = [pos];
    else if (line === opts.penUp) {
      if (cur) strokes.push(cur);
      cur = null;
    } else {
      const m = /^G([01]) X(\S+) Y(\S+)/.exec(line);
      if (!m) continue;
      pos = [Number(m[2]), Number(m[3])];
      if (cur && m[1] === '1') cur.push(pos);
    }
  }
  return strokes;
}

function samplesOf(tp: Toolpath, p: number): [number, number][] {
  const pass = tp.passes[p];
  const out: [number, number][] = [];
  for (let i = pass.start; i < pass.start + pass.count; i++) out.push([tp.x[i], tp.y[i]]);
  return out;
}

describe('fmtG', () => {
  it('writes fixed 3 decimals without exponents or negative zero', () => {
    expect(fmtG(1)).toBe('1.000');
    expect(fmtG(-12.34567)).toBe('-12.346');
    expect(fmtG(-0.0004)).toBe('0.000');
    expect(fmtG(-0)).toBe('0.000');
    expect(fmtG(1e-9)).toBe('0.000');
    expect(fmtG(3e-7)).toBe('0.000');
    expect(fmtG(NaN)).toBe('0.000');
    expect(fmtG(123456.7891)).toBe('123456.789');
  });
});

describe('buildGcode', () => {
  const recipe = recipeWith(() => {});
  const ecc = ringsToolpath({ passes: 6, samples: 360, r0: 10, r1: 40, divisions: 4, offset: 8, startAngle: 0.7 });

  it('starts with mm + absolute, the header and a comment block with name, seed and stats', () => {
    const r = recipeWith((x) => {
      x.name = 'Barleycorn (é)';
      x.seed = 4172;
    });
    const { text, stats } = buildGcode(r, ecc, pen);
    const lines = text.split('\n');
    expect(lines[0]).toBe('G21 ; mm');
    expect(lines[1]).toBe('G90 ; absolute');
    expect(count(text, /^G21\b/gm)).toBe(1);
    expect(text).toContain('; name: Barleycorn e');
    expect(text).toContain('; seed: 4172');
    expect(text).toContain(`; lines: ${stats.lines}`);
    expect(text).toMatch(/; draw length: \d+\.\d{3} mm/);
    expect(text).toMatch(/; estimated time: \d+m \d+s/);
    expect(/[^\x00-\x7f]/.test(text)).toBe(false);
    expect(text.endsWith('G0 X0 Y0\nM2\n')).toBe(true);

    const custom = buildGcode(r, ecc, { ...pen, header: '%\nM5' }).text.split('\n');
    expect(custom.slice(0, 4)).toEqual(['%', 'M5', 'G21 ; mm', 'G90 ; absolute']);
  });

  it("'center': every X/Y lies within work radius + eccentric offset", () => {
    const { text, stats } = buildGcode(recipe, ecc, pen);
    const limit = recipe.machine.workDiameter / 2 + 8;
    const xy = parse(text).moves.filter((m) => m.x !== undefined);
    expect(xy.length).toBeGreaterThan(1000);
    for (const m of xy) expect(Math.hypot(m.x!, m.y!)).toBeLessThanOrEqual(limit + 1e-3);
    expect(stats.bounds.minX).toBeLessThan(0);
    expect(stats.bounds.maxX).toBeLessThanOrEqual(limit);
  });

  it("'corner': every X/Y is >= 0 and the min corner sits at X0 Y0", () => {
    const { text, stats } = buildGcode(recipe, ecc, { ...pen, origin: 'corner' });
    const xy = parse(text).moves.filter((m) => m.x !== undefined);
    for (const m of xy) {
      expect(m.x!).toBeGreaterThanOrEqual(0);
      expect(m.y!).toBeGreaterThanOrEqual(0);
    }
    expect(Math.min(...xy.map((m) => m.x!))).toBe(0);
    expect(Math.min(...xy.map((m) => m.y!))).toBe(0);
    expect(stats.bounds.minX).toBeCloseTo(0, 6);
    expect(stats.bounds.minY).toBeCloseTo(0, 6);
  });

  it('pen profile: one pen-down per stroke, one pen-up per stroke plus the initial safety lift', () => {
    const { text } = buildGcode(recipe, ecc, pen);
    const strokes = ecc.passes.length;
    expect(count(text, /^M3 S90$/gm)).toBe(strokes);
    expect(count(text, /^M3 S30$/gm)).toBe(strokes + 1);
    expect(count(text, /^G0 X/gm)).toBe(strokes + 1); // + footer's G0 X0 Y0
    // Each stroke: G0 to start, pen down, G1 ... F<feed>, pen up.
    const lines = text.split('\n');
    const firstDown = lines.indexOf('M3 S90');
    expect(lines[firstDown - 1]).toMatch(/^G0 X\S+ Y\S+$/);
    expect(lines[firstDown + 1]).toMatch(/^G1 X\S+ Y\S+ F1500$/);
    expect(lines[firstDown - 2]).toBe('M3 S30');
  });

  it('closed loops start at the sample nearest the previous end and close back to their own start', () => {
    const { text } = buildGcode(recipe, ecc, pen);
    const strokes = penStrokes(text, pen);
    expect(strokes.length).toBe(ecc.passes.length);
    let prev: [number, number] = [0, 0];
    strokes.forEach((s, p) => {
      const samples = samplesOf(ecc, p);
      const nearest = Math.min(...samples.map(([x, y]) => Math.hypot(x - prev[0], y - prev[1])));
      const start = s[0];
      expect(Math.hypot(start[0] - prev[0], start[1] - prev[1])).toBeCloseTo(nearest, 2);
      const end = s[s.length - 1];
      expect(end).toEqual(start);
      expect(s.length).toBe(samples.length + 1);
      prev = end;
    });
  });

  it('open strokes keep their own start and direction', () => {
    const sp = spiralToolpath(3, 90, 5, 30, 2);
    const strokes = penStrokes(buildGcode(recipe, sp, pen).text, pen);
    expect(strokes.length).toBe(2);
    strokes.forEach((s, p) => {
      const samples = samplesOf(sp, p);
      expect(s[0][0]).toBeCloseTo(samples[0][0], 3);
      expect(s[0][1]).toBeCloseTo(samples[0][1], 3);
      const last = samples[samples.length - 1];
      expect(s[s.length - 1][0]).toBeCloseTo(last[0], 3);
      expect(s[s.length - 1][1]).toBeCloseTo(last[1], 3);
    });
  });

  it('CNC: safe Z, XY rapid, plunge at plungeRate, cut Z in [-(depth bound), 0], retract', () => {
    const r = recipeWith((x) => (x.metal.baseDepth = 0.08));
    const pumped = ringsToolpath({ passes: 4, samples: 720, pump: 0.05, pumpLobes: 24 });
    const opts: GcodeOptions = { ...cncOpts, depthScale: 1.5, safeZ: 2, tolerance: 0.005 };
    const { text } = buildGcode(r, pumped, opts);
    const { moves } = parse(text);
    const bound = opts.depthScale * (0.08 + pumped.zMax);
    const cutZ = moves.filter((m) => m.g === 1 && m.z !== undefined).map((m) => m.z!);
    expect(cutZ.length).toBeGreaterThan(100);
    for (const z of cutZ) {
      expect(z).toBeLessThanOrEqual(0);
      expect(z).toBeGreaterThanOrEqual(-bound - 1e-3);
    }
    // XY simplification must not flatten the pump: emitted depths still span the modulation.
    expect(Math.min(...cutZ)).toBeCloseTo(-bound, 2);
    expect(Math.max(...cutZ)).toBeCloseTo(-opts.depthScale * (0.08 + pumped.zMin), 2);
    for (const m of moves.filter((mv) => mv.g === 0 && mv.z !== undefined)) expect(m.z).toBe(2);
    const lines = text.split('\n');
    const plunges = lines.filter((l) => /^G1 Z\S+ F100$/.test(l));
    expect(plunges.length).toBe(4);
    const i = lines.indexOf(plunges[0]);
    expect(lines[i - 1]).toMatch(/^G0 X\S+ Y\S+$/);
    expect(lines[i - 2]).toBe('G0 Z2.000');
    expect(lines[i + 1]).toMatch(/^G1 X\S+ Y\S+ Z\S+ F1500$/);
    expect(count(text, /^G0 Z2\.000$/gm)).toBe(5);
    expect(text).not.toContain('M3 S');
  });

  it('CNC in ink mode still uses metal.baseDepth; negative depth clamps to 0', () => {
    const r = recipeWith((x) => {
      x.mode = 'ink';
      x.metal.baseDepth = 0.02;
    });
    const deep = ringsToolpath({ passes: 2, samples: 90, pump: 0.05, pumpLobes: 6 });
    const cutZ = parse(buildGcode(r, deep, cncOpts).text)
      .moves.filter((m) => m.g === 1 && m.z !== undefined)
      .map((m) => m.z!);
    expect(Math.max(...cutZ)).toBe(0);
    expect(Math.min(...cutZ)).toBeCloseTo(-0.07, 3);
  });

  it('never prints NaN, exponents or -0.000', () => {
    const t = makeToolpath([
      { points: [[1e-9, -1e-9], [-3e-7, 2], [5, 5]], closed: false },
      { points: [[0, -0.0004], [10, 0], [10, 10], [NaN, 3]], closed: true },
    ]);
    for (const profile of ['pen', 'cnc'] as const) {
      for (const origin of ['center', 'corner'] as const) {
        const { text } = buildGcode(recipe, t, { ...pen, profile, origin });
        expect(text).not.toMatch(/NaN|Infinity|e-|e\+|-0\.000\b/);
      }
    }
    const big = buildGcode(recipe, ecc, { ...pen, tolerance: 0.02 }).text;
    expect(big).not.toMatch(/NaN|e-|-0\.000\b/);
  });

  it('reports stats consistent with the text', () => {
    const rings = ringsToolpath({ passes: 3, samples: 2048, r0: 10, r1: 30, amplitude: 0 });
    const { text, stats } = buildGcode(recipe, rings, pen);
    expect(stats.lines).toBe(text.split('\n').length - 1);
    const perimeter = 2 * Math.PI * (10 + 20 + 30);
    expect(stats.drawLength).toBeCloseTo(perimeter, 0);
    expect(stats.travelLength).toBeGreaterThan(9.9); // origin → first ring
    expect(stats.travelLength).toBeLessThan(10 + 10 + 10 + 1);
    const expected =
      (stats.drawLength / pen.feedRate) * 60 + (stats.travelLength / RAPID_RATE) * 60 + 7 * PEN_MOVE_SECONDS;
    expect(stats.estimatedSeconds).toBeCloseTo(expected, 6);
    expect(stats.bounds.maxX).toBeCloseTo(30, 2);
    expect(stats.bounds.minY).toBeCloseTo(-30, 2);
  });

  it('simplification cuts lines but keeps loops closed', () => {
    const rings = ringsToolpath({ passes: 5, samples: 4096, amplitude: 0.5 });
    const full = buildGcode(recipe, rings, pen);
    const simp = buildGcode(recipe, rings, { ...pen, tolerance: 0.02 });
    expect(simp.stats.lines).toBeLessThan(full.stats.lines / 4);
    for (const s of penStrokes(simp.text, pen)) expect(s[s.length - 1]).toEqual(s[0]);
    expect(simp.stats.drawLength).toBeCloseTo(full.stats.drawLength, -1);
  });

  it('handles 120 passes × 4096 samples fast', () => {
    const big = ringsToolpath({ passes: 120, samples: 4096, r0: 5, r1: 48, pump: 0.03 });
    for (const opts of [pen, DEFAULT_GCODE_OPTIONS, { ...cncOpts, tolerance: 0.02 }]) {
      const t = performance.now();
      const { stats } = buildGcode(recipe, big, opts);
      const ms = performance.now() - t;
      console.info(`G-code 120×4096 ${opts.profile} tol ${opts.tolerance}: ${ms.toFixed(0)} ms, ${stats.lines} lines`);
      expect(ms).toBeLessThan(2000);
    }
  });
});

function count(s: string, re: RegExp): number {
  return (s.match(re) ?? []).length;
}
