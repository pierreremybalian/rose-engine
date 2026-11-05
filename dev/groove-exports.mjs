// Fill-to-edge exports through the real engine: SVG and G-code must stay on the plate and lift at the rim.
//   node dev/groove-exports.mjs
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const b = await chromium.launch();
const p = await b.newPage();
await p.goto('http://127.0.0.1:5173/');
await p.waitForFunction(() => window.__rose);
const out = await p.evaluate(async () => {
  const { presetRecipe } = await import('/src/presets/index.ts');
  const { prepare, computeToolpath } = await import('/src/engine/index.ts');
  const { plateRadius, effectiveEndRadius } = await import('/src/engine/plate.ts');
  const { buildSVG } = await import('/src/export/svg.ts');
  const { buildGcode } = await import('/src/export/gcode.ts');
  const { DEFAULT_SVG_OPTIONS, DEFAULT_GCODE_OPTIONS } = await import('/src/export/types.ts');
  const res = {};
  const cases = {
    'fine-barleycorn (preset, fill)': presetRecipe('fine-barleycorn'),
    'barleycorn ink fill': Object.assign(presetRecipe('barleycorn'), {}),
    'barleycorn eccentric fill': presetRecipe('barleycorn'),
  };
  cases['barleycorn ink fill'].machine.fillEdge = true;
  const e = cases['barleycorn eccentric fill'];
  e.machine.fillEdge = true;
  e.eccentric = { ...e.eccentric, enabled: true, offset: 12, divisions: 5 };
  e.slide.passes = 24;
  for (const [name, r] of Object.entries(cases)) {
    const tp = computeToolpath(prepare(r));
    const R = plateRadius(r);
    let rawMax = 0;
    for (let i = 0; i < tp.totalSamples; i++) rawMax = Math.max(rawMax, Math.hypot(tp.x[i], tp.y[i]));
    let t0 = performance.now();
    const svg = buildSVG(r, tp, DEFAULT_SVG_OPTIONS);
    const svgMs = performance.now() - t0;
    let svgMax = 0, paths = 0;
    for (const m of svg.matchAll(/<path d="([^"]*)"/g)) {
      paths++;
      const nums = m[1].replace(/[MLZ]/g, ' ').trim().split(/\s+/).map(Number);
      for (let k = 0; k + 1 < nums.length; k += 2) svgMax = Math.max(svgMax, Math.hypot(nums[k], nums[k + 1]));
    }
    t0 = performance.now();
    const g = buildGcode(r, tp, { ...DEFAULT_GCODE_OPTIONS, profile: 'pen' });
    const gMs = performance.now() - t0;
    let gMax = 0, downs = 0;
    for (const line of g.text.split('\n')) {
      if (line === DEFAULT_GCODE_OPTIONS.penDown) downs++;
      const m = /^G1 X(\S+) Y(\S+)/.exec(line);
      if (m) gMax = Math.max(gMax, Math.hypot(+m[1], +m[2]));
    }
    const unclipped = { ...r, machine: { ...r.machine, workDiameter: 1000 } };
    const gu = buildGcode(unclipped, tp, { ...DEFAULT_GCODE_OPTIONS, profile: 'pen' });
    res[name] = {
      plateR: R, effectiveEnd: +effectiveEndRadius(r).toFixed(2), passes: tp.passes.length, samples: tp.totalSamples,
      rawMaxRadius: +rawMax.toFixed(3), svgMaxRadius: +svgMax.toFixed(3), svgPaths: paths, svgMs: Math.round(svgMs),
      gcodeMaxRadius: +gMax.toFixed(3), penDowns: downs, gcodeMs: Math.round(gMs),
      drawLength: Math.round(g.stats.drawLength), drawLengthUnclipped: Math.round(gu.stats.drawLength),
      minutes: +(g.stats.estimatedSeconds / 60).toFixed(1), minutesUnclipped: +(gu.stats.estimatedSeconds / 60).toFixed(1),
      svgHead: /<svg[^>]*>/.exec(svg)[0].slice(0, 200),
    };
    if (name.startsWith('barleycorn ink')) res.svgSample = svg;
  }
  return res;
});
writeFileSync('dev/screenshots/grooves/export-barleycorn-fill.svg', out.svgSample);
delete out.svgSample;
console.log(JSON.stringify(out, null, 1));
await b.close();
