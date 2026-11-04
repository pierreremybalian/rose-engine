import { describe, expect, it } from 'vitest';
import { buildSVG, extractRecipeJSON, fmt3, grooveWidth } from '../../src/export/svg';
import { DEFAULT_SVG_OPTIONS, type SvgOptions } from '../../src/export/types';
import { passColor } from '../../src/state/colors';
import { assertWellFormedXml, makeToolpath, recipeWith, ringsToolpath, spiralToolpath } from './fixtures';

const bare: SvgOptions = { tolerance: 0, background: false, outline: false };

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
const layers = (svg: string) => [...svg.matchAll(/<g inkscape:groupmode="layer"([^>]*)>/g)].map((m) => m[1]);
const pathDs = (svg: string) => [...svg.matchAll(/<path d="([^"]*)"/g)].map((m) => m[1]);

function pathPoints(d: string): [number, number][] {
  const nums = d.replace(/[MLZ]/g, ' ').trim().split(/\s+/).filter(Boolean).map(Number);
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  return pts;
}

describe('buildSVG', () => {
  const recipe = recipeWith(() => {});
  const tp = ringsToolpath({ passes: 7, samples: 256 });

  it('is well-formed standalone SVG 1.1 with Inkscape namespaces', () => {
    const svg = buildSVG(recipe, tp, { ...DEFAULT_SVG_OPTIONS, outline: true });
    expect(assertWellFormedXml(svg)).toBe('svg');
    expect(svg.startsWith('<?xml version="1.0"')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"');
    expect(svg).toContain('version="1.1"');
  });

  it('emits one <path> per pass, closed passes ending in Z, open ones not', () => {
    const svg = buildSVG(recipe, tp, bare);
    const ds = pathDs(svg);
    expect(ds.length).toBe(tp.passes.length);
    for (const d of ds) expect(d.endsWith(' Z')).toBe(true);
    for (const d of ds) expect(pathPoints(d).length).toBe(256);

    const sp = spiralToolpath(5, 128, 5, 40, 3);
    const svg2 = buildSVG(recipe, sp, DEFAULT_SVG_OPTIONS);
    const ds2 = pathDs(svg2);
    expect(ds2.length).toBe(3);
    for (const d of ds2) expect(d.includes('Z')).toBe(false);
  });

  it('uses mm width/height = work diameter and a viewBox centred on the work', () => {
    const svg = buildSVG(recipe, tp, bare);
    expect(svg).toMatch(/<svg[^>]* width="100mm" height="100mm" viewBox="-50 -50 100 100"/);
  });

  it('grows the canvas when the toolpath reaches outside the work disc', () => {
    const wide = ringsToolpath({ passes: 3, samples: 64, r0: 20, r1: 30, divisions: 4, offset: 25, amplitude: 0 });
    const svg = buildSVG(recipe, wide, bare);
    const m = /width="([\d.]+)mm" height="([\d.]+)mm" viewBox="(\S+) (\S+) (\S+) (\S+)"/.exec(svg)!;
    const D = Number(m[1]);
    expect(D).toBeGreaterThan(110);
    expect(Number(m[2])).toBe(D);
    expect(Number(m[3])).toBe(-D / 2);
    expect(Number(m[5])).toBe(D);
    // Every point is inside the viewBox.
    for (const d of pathDs(svg)) for (const [x, y] of pathPoints(d)) {
      expect(Math.abs(x)).toBeLessThanOrEqual(D / 2);
      expect(Math.abs(y)).toBeLessThanOrEqual(D / 2);
    }
  });

  it('flips y (work +Y up becomes SVG -y) and writes 3-decimal coordinates', () => {
    const t = makeToolpath([{ points: [[10, 20], [-5.12345, -7.00049], [0, 0.0001]], closed: false }]);
    const [d] = pathDs(buildSVG(recipe, t, bare));
    expect(d).toBe('M10 -20 L-5.123 7 0 0');
    expect(d).not.toMatch(/-0(?![.\d])/);
  });

  it('makes one layer per distinct passColor, stroked in that colour', () => {
    for (const mode of ['single', 'cycle', 'gradient'] as const) {
      const r = recipeWith((x) => {
        x.ink.colorMode = mode;
        x.ink.palette = ['#1d2a5c', '#b0303a', '#2f6b4f'];
      });
      const svg = buildSVG(r, tp, bare);
      const colours = new Set(tp.passes.map((p) => passColor(r.ink, p.index, tp.passes.length)));
      const ls = layers(svg);
      expect(ls.length).toBe(colours.size);
      for (const c of colours) expect(ls.some((l) => l.includes(`stroke="${c}"`))).toBe(true);
      for (const l of ls) {
        expect(l).toContain(`stroke-width="${fmt3(r.ink.lineWidth)}"`);
        expect(l).toContain(`stroke-opacity="${fmt3(r.ink.opacity)}"`);
        expect(l).toContain('fill="none"');
        expect(l).toContain('stroke-linecap="round"');
        expect(l).toContain('stroke-linejoin="round"');
      }
      expect(pathDs(svg).length).toBe(tp.passes.length);
    }
    expect(layers(buildSVG(recipeWith((x) => (x.ink.colorMode = 'cycle')), tp, bare)).length).toBe(3);
    expect(layers(buildSVG(recipeWith((x) => (x.ink.colorMode = 'gradient')), tp, bare)).length).toBe(7);
  });

  it('puts each pass in the layer of its colour', () => {
    const r = recipeWith((x) => (x.ink.colorMode = 'cycle'));
    const svg = buildSVG(r, tp, bare);
    const groups = [...svg.matchAll(/<g inkscape:groupmode="layer"[^>]* stroke="([^"]+)"[^>]*>([\s\S]*?)<\/g>/g)];
    const perColour = new Map(groups.map((g) => [g[1], count(g[2], /<path /g)]));
    const expected = new Map<string, number>();
    for (const p of tp.passes) {
      const c = passColor(r.ink, p.index, tp.passes.length);
      expected.set(c, (expected.get(c) ?? 0) + 1);
    }
    expect(perColour).toEqual(expected);
  });

  it('metal mode: one layer per eccentric division, groove-width dark strokes, no paper', () => {
    const r = recipeWith((x) => {
      x.mode = 'metal';
      x.metal.baseDepth = 0.08;
      x.metal.toolAngle = 120;
    });
    const ecc = ringsToolpath({ passes: 5, samples: 128, divisions: 3, offset: 6, r1: 30 });
    const svg = buildSVG(r, ecc, DEFAULT_SVG_OPTIONS);
    const ls = layers(svg);
    expect(ls.length).toBe(3);
    const w = grooveWidth(0.08, 120);
    expect(w).toBeCloseTo(2 * 0.08 * Math.tan(Math.PI / 3), 9);
    for (const l of ls) {
      expect(l).toContain(`stroke-width="${fmt3(w)}"`);
      expect(l).toContain('stroke="#3a3a3a"');
    }
    expect(svg).not.toContain('<rect');
    expect(pathDs(svg).length).toBe(15);
    expect(layers(buildSVG(r, tp, bare))).toHaveLength(1);
  });

  it('background adds a paper rect on a non-plotting layer; outline adds the work circle layer', () => {
    const svg = buildSVG(recipe, tp, { tolerance: 0, background: true, outline: true });
    expect(svg).toMatch(/inkscape:label="% background"[^>]*><rect x="-50" y="-50" width="100" height="100" fill="#f4efe4"/);
    expect(svg).toMatch(/inkscape:label="outline"[^>]*><circle cx="0" cy="0" r="50"\/>/);
    const plain = buildSVG(recipe, tp, bare);
    expect(plain).not.toContain('<rect');
    expect(plain).not.toContain('<circle');
  });

  it('round-trips the recipe JSON through <metadata> CDATA, even with ]]> in the name', () => {
    const r = recipeWith((x) => {
      x.name = 'Tricky ]]> <name> & "quotes" ]]]>';
      x.seed = 4172;
    });
    const svg = buildSVG(r, tp, DEFAULT_SVG_OPTIONS);
    expect(assertWellFormedXml(svg)).toBe('svg');
    expect(svg).toMatch(/<metadata[^>]*>[\s\S]*<!\[CDATA\[[\s\S]*<\/metadata>/);
    expect(extractRecipeJSON(svg)).toEqual(JSON.parse(JSON.stringify(r)));
    expect(svg).toContain('<title>Tricky ]]&gt; &lt;name&gt; &amp; &quot;quotes&quot; ]]]&gt;</title>');
  });

  it('simplifies with opts.tolerance, keeping only original samples', () => {
    const fine = ringsToolpath({ passes: 4, samples: 4096, amplitude: 0 });
    const svg = buildSVG(recipe, fine, { ...bare, tolerance: 0.01 });
    const ds = pathDs(svg);
    expect(ds.length).toBe(4);
    const all = new Set<string>();
    for (let i = 0; i < fine.totalSamples; i++) all.add(`${fmt3(fine.x[i])},${fmt3(-fine.y[i])}`);
    for (const d of ds) {
      const pts = pathPoints(d);
      expect(pts.length).toBeLessThan(4096);
      expect(pts.length).toBeGreaterThan(20);
      for (const [x, y] of pts) expect(all.has(`${fmt3(x)},${fmt3(y)}`)).toBe(true);
    }
  });

  it('serializes 120 passes × 4096 samples fast', () => {
    const big = ringsToolpath({ passes: 120, samples: 4096, r0: 5, r1: 48 });
    expect(big.totalSamples).toBe(491520);
    const r = recipeWith((x) => (x.ink.colorMode = 'gradient'));
    buildSVG(r, ringsToolpath({ passes: 4, samples: 512 }), bare); // warm-up
    let t = performance.now();
    const raw = buildSVG(r, big, bare);
    const rawMs = performance.now() - t;
    t = performance.now();
    const simp = buildSVG(r, big, DEFAULT_SVG_OPTIONS);
    const simpMs = performance.now() - t;
    expect(pathDs(raw).length).toBe(120);
    expect(pathDs(simp).length).toBe(120);
    console.info(`SVG 120×4096: raw ${rawMs.toFixed(0)} ms (${(raw.length / 1e6).toFixed(1)} MB), tol 0.01 ${simpMs.toFixed(0)} ms (${(simp.length / 1e6).toFixed(1)} MB)`);
    expect(rawMs).toBeLessThan(1000);
    expect(simpMs).toBeLessThan(1000);
  });
});
