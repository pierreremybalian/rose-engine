import { describe, expect, it } from 'vitest';
import { defaultRecipe, defaultRosette, layerFromBase, type Recipe } from '../../src/state/recipe';
import { computeToolpath, prepare } from '../../src/engine';
import { buildSVG, grooveWidth, fmt3 } from '../../src/export/svg';
import { buildGcode } from '../../src/export/gcode';
import { DEFAULT_GCODE_OPTIONS, type SvgOptions } from '../../src/export/types';

const bare: SvgOptions = { tolerance: 0.01, background: false, outline: false };
const groups = (svg: string) =>
  [...svg.matchAll(/<g inkscape:groupmode="layer" inkscape:label="([^"]*)"[^>]*stroke-width="([^"]*)"[^>]*>([\s\S]*?)<\/g>/g)].map((m) => ({
    label: m[1],
    width: m[2],
    paths: (m[3].match(/<path /g) ?? []).length,
  }));

function base(edit: (r: Recipe) => void = () => {}): Recipe {
  const r = defaultRecipe();
  r.mode = 'metal';
  r.machine.rubberRadius = 0;
  r.metal.baseDepth = 0.08;
  r.rosettes = [defaultRosette({ id: 'a', lobes: 12, amplitude: 0.6 })];
  r.slide = { ...r.slide, passes: 6, startRadius: 5, endRadius: 30 };
  edit(r);
  return r;
}

function twoCuts(edit: (r: Recipe) => void = () => {}): Recipe {
  return base((x) => {
    const l = layerFromBase(x, 0.03);
    l.rosettes = [defaultRosette({ id: 'b', lobes: 5, amplitude: 1, profile: 'triangle' })];
    l.slide = { ...l.slide, passes: 4, startRadius: 8, endRadius: 20 };
    x.layers = [l];
    edit(x);
  });
}

describe('SVG export of layered recipes', () => {
  it('metal: one layer per cut, each at its own groove width', () => {
    const r = twoCuts();
    const tp = computeToolpath(prepare(r));
    const g = groups(buildSVG(r, tp, bare));
    expect(g.map((x) => x.label)).toEqual(['1 Cut 1', '2 Cut 2']);
    expect(g[0].width).toBe(fmt3(grooveWidth(0.08, r.metal.toolAngle)));
    expect(g[1].width).toBe(fmt3(grooveWidth(0.03, r.metal.toolAngle)));
    expect(g[0].paths).toBe(tp.passes.filter((p) => p.cut === 0).length);
    expect(g[1].paths).toBe(tp.passes.filter((p) => p.cut === 1).length);
  });

  it('metal: divisions split within their cut', () => {
    const r = twoCuts((x) => (x.layers[0].eccentric = { enabled: true, offset: 3, angle: 0, divisions: 3, divisionStep: 0 }));
    const g = groups(buildSVG(r, computeToolpath(prepare(r)), bare));
    expect(g.map((x) => x.label)).toEqual(['1 Cut 1', '2 Cut 2 division 1', '3 Cut 2 division 2', '4 Cut 2 division 3']);
    expect(new Set(g.slice(1).map((x) => x.width)).size).toBe(1);
  });

  it('ink: colour layers per cut, line width unchanged', () => {
    const r = twoCuts((x) => {
      x.mode = 'ink';
      x.ink.palette = ['#112233'];
    });
    const g = groups(buildSVG(r, computeToolpath(prepare(r)), bare));
    expect(g.map((x) => x.label)).toEqual(['1 Cut 1 #112233', '2 Cut 2 #112233']);
    expect(g.every((x) => x.width === fmt3(r.ink.lineWidth))).toBe(true);
  });

  it('disabled layers: output identical to the recipe without them (labels and widths)', () => {
    const r = twoCuts((x) => (x.layers[0].enabled = false));
    const plain = { ...r, layers: [] };
    const tp = computeToolpath(prepare(r));
    expect(buildSVG(r, tp, bare).replace(/<metadata[\s\S]*?<\/metadata>/, '')).toBe(
      buildSVG(plain, computeToolpath(prepare(plain)), bare).replace(/<metadata[\s\S]*?<\/metadata>/, ''),
    );
    expect(groups(buildSVG(r, tp, bare)).map((x) => x.label)).toEqual(['1 engraving']);
  });
});

describe('G-code export of layered recipes', () => {
  it('lists the cuts in the header and opens each cut with a comment', () => {
    const r = twoCuts();
    const tp = computeToolpath(prepare(r));
    const g = buildGcode(r, tp, { ...DEFAULT_GCODE_OPTIONS, profile: 'cnc' });
    const lines = g.text.split('\n');
    expect(lines).toContain('; cuts: cut 1 (depth 0.080 mm), cut 2 (depth 0.030 mm)');
    const c1 = lines.indexOf('; cut 1 (depth 0.080 mm)');
    const c2 = lines.indexOf('; cut 2 (depth 0.030 mm)');
    expect(c1).toBeGreaterThan(0);
    expect(c2).toBeGreaterThan(c1);
    expect(lines.filter((l) => l.startsWith('; cut ')).length).toBe(2);
    expect(lines[c1 + 1]).toMatch(/^G0 X/);
    // Every plunge after the cut 2 comment goes to that cut's depth band (shallow), none before it does.
    const plunges = (from: number, to: number) => lines.slice(from, to).filter((l) => /^G1 Z/.test(l)).map((l) => -Number(/Z(-?[\d.]+)/.exec(l)![1]));
    for (const z of plunges(c2, lines.length)) expect(z).toBeLessThan(0.06);
    for (const z of plunges(c1, c2)) expect(z).toBeGreaterThan(0.05);
    expect(g.stats.lines).toBe(lines.length - 1);
    expect(lines.find((l) => l.startsWith('; lines:'))).toBe(`; lines: ${lines.length - 1}`);
  });

  it('ink / pen: cut comments without depth', () => {
    const r = twoCuts((x) => (x.mode = 'ink'));
    const g = buildGcode(r, computeToolpath(prepare(r)), DEFAULT_GCODE_OPTIONS);
    expect(g.text).toContain('; cuts: cut 1, cut 2\n');
    expect(g.text).toContain('\n; cut 2\n');
  });

  it('unlayered recipes get no cut comments', () => {
    const r = twoCuts((x) => (x.layers[0].enabled = false));
    const g = buildGcode(r, computeToolpath(prepare(r)), { ...DEFAULT_GCODE_OPTIONS, profile: 'cnc' });
    expect(g.text).not.toMatch(/; cuts?\b/);
  });
});
