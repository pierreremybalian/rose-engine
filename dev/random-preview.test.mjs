// Contact sheets of built-in presets and random seeds, rendered from the real engine toolpath.
//   PREVIEW=1 npx vitest run --config dev/random-vitest.config.mjs
// Env:
//   PREVIEW_SEEDS=1-24        seed range for the random sheets (default 1-24)
//   PREVIEW_BIG=preset:flame,seed:12,seed:7:metal   extra 1000 px single renders
//   PREVIEW_SKIP_PRESETS=1    skip the preset sheet
//   PREVIEW_MUTATE=flame      the preset plus 11 successive Mutate steps (seeds 1..11)
//   PREVIEW_LOCKS=rosettes PREVIEW_BASE=petals   random sheets start from a preset with these locks (comma list)
//   PREVIEW_WHERE='r.slide.spiral && r.eccentric.enabled'   only the first 24 seeds (from 1) matching, both modes
// Output: dev/screenshots/random/*.png
import { it } from 'vitest';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { computeToolpath, prepare, simplifyPolyline } from '../src/engine/index';
import { mutateRecipe, randomRecipe } from '../src/engine/random';
import { PRESETS } from '../src/presets/index';
import { passColor } from '../src/state/colors';
import { defaultRecipe } from '../src/state/recipe';

const OUT = 'dev/screenshots/random';
const METAL = {
  silver: ['#dfe2e6', '#5d636c'],
  gold: ['#e9cd7a', '#6d4f12'],
  rose: ['#ebbba6', '#7d4232'],
  brass: ['#d9b866', '#5e4a1a'],
  steel: ['#c0c5cc', '#41474f'],
  blued: ['#2b3f7a', '#a9bdf0'],
};

function esc(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
}

function describe(r) {
  const rs = r.rosettes
    .filter((x) => x.enabled)
    .map((x) => `${x.axis === 'pump' ? 'P' : ''}${x.lobes}${x.profile[0]}·${x.amplitude}`)
    .join(' ');
  const s = r.slide;
  const step = s.passes > 1 ? Math.abs(s.endRadius - s.startRadius) / (s.passes - 1) : 0;
  const ph = s.phaseMode === 'alternate' ? `alt${s.alternateEvery}/${s.alternateFraction.toFixed(2)}` : s.phaseMode === 'linear' ? `lin${s.phaseStep}` : 'cust';
  const ch = [r.eccentric.enabled ? `ecc${r.eccentric.offset}×${r.eccentric.divisions}` : '', r.elliptical.enabled ? `ell${r.elliptical.e}` : '', s.spiral ? 'spiral' : '']
    .filter(Boolean)
    .join(' ');
  return `${rs} | n${s.passes} ${s.startRadius}→${s.endRadius} st${step.toFixed(2)} ${ph} tp${s.amplitudeTaper} rb${r.machine.rubberRadius} ${ch}`;
}

function svgFor(recipe, px) {
  const prep = prepare(recipe, { maxSamples: 500_000 });
  const tp = computeToolpath(prep);
  const R = recipe.machine.workDiameter / 2;
  const ink = recipe.mode === 'ink';
  const [bg, line] = ink ? [recipe.ink.paper, null] : METAL[recipe.metal.material];
  // Full-coverage metal would be a solid fill here: draw groove centre lines instead, width ∝ depth.
  const sl = recipe.slide;
  const spacing = sl.passes > 1 ? Math.abs(sl.endRadius - sl.startRadius) / (sl.spiral ? sl.passes : sl.passes - 1) : 0.4;
  const groove = 0.45 * spacing;
  const hasPump = tp.zMax - tp.zMin > 1e-6;
  const tol = (2 * R) / px / 6;
  let body = '';
  for (const p of tp.passes) {
    const idx = simplifyPolyline(tp.x, tp.y, p.start, p.count, tol, p.closed);
    const color = ink ? passColor(recipe.ink, p.index, tp.passes.length) : line;
    if (!hasPump) {
      let d = '';
      for (let i = 0; i < idx.length; i++) d += (i ? 'L' : 'M') + tp.x[idx[i]].toFixed(2) + ' ' + (-tp.y[idx[i]]).toFixed(2);
      if (p.closed) d += 'Z';
      const w = ink ? recipe.ink.lineWidth : Math.max(0.04, groove);
      body += `<path d="${d}" stroke="${color}" stroke-width="${w}"/>`;
    } else {
      // Width follows pump depth: chunk the stroke and give each chunk its mean width.
      const all = p.closed ? [...idx, idx[0]] : idx;
      for (let a = 0; a < all.length - 1; a += 6) {
        const b = Math.min(all.length - 1, a + 6);
        let z = 0;
        let d = '';
        for (let i = a; i <= b; i++) {
          z += tp.z[all[i]];
          d += (i > a ? 'L' : 'M') + tp.x[all[i]].toFixed(2) + ' ' + (-tp.y[all[i]]).toFixed(2);
        }
        z /= b - a + 1;
        const w = ink
          ? recipe.ink.lineWidth * (0.4 + 1.2 * ((z - tp.zMin) / Math.max(1e-9, tp.zMax - tp.zMin)))
          : groove * Math.max(0, (recipe.metal.baseDepth + z) / recipe.metal.baseDepth);
        if (w > 0.005) body += `<path d="${d}" stroke="${color}" stroke-width="${w.toFixed(3)}"/>`;
      }
    }
  }
  const enamel =
    !ink && recipe.metal.enamel ? `<circle r="${R}" fill="${recipe.metal.enamelColor}" opacity="${(recipe.metal.enamelOpacity * 0.7).toFixed(2)}"/>` : '';
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="${-R} ${-R} ${2 * R} ${2 * R}">
<defs><clipPath id="c"><circle r="${R}"/></clipPath></defs>
<circle r="${R}" fill="${bg}"/><g clip-path="url(#c)" fill="none" stroke-linecap="round" stroke-linejoin="round" ${ink ? `opacity="${recipe.ink.opacity}"` : ''}>${body}</g>${enamel}
<circle r="${R - 0.2}" fill="none" stroke="#888" stroke-width="0.3"/></svg>`,
    samples: tp.totalSamples,
  };
}

async function sheet(browser, items, file, px = 340, cols = 6) {
  const tiles = items
    .map(({ recipe, title }) => {
      const t0 = performance.now();
      const { svg, samples } = svgFor(recipe, px);
      const ms = performance.now() - t0;
      return `<figure>${svg}<figcaption><b>${esc(title)}</b><br>${esc(describe(recipe))}<br><i>${(samples / 1000).toFixed(0)}k samples, ${ms.toFixed(0)} ms</i></figcaption></figure>`;
    })
    .join('');
  const html = `<!doctype html><html><head><style>
body{margin:0;padding:12px;background:#2a2622;font:11px/1.3 system-ui,sans-serif;color:#e8e0d0;display:grid;grid-template-columns:repeat(${cols},${px}px);gap:14px 12px}
figure{margin:0}figcaption{margin-top:4px;width:${px}px;word-break:break-word}b{color:#f3d48a}i{color:#9a8f80}
</style></head><body>${tiles}</body></html>`;
  const page = await browser.newPage({ viewport: { width: cols * (px + 12) + 24, height: 800 } });
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: `${OUT}/${file}`, fullPage: true });
  await page.close();
}

function parseRange(s, def) {
  const m = /^(\d+)-(\d+)$/.exec(s ?? '');
  const [a, b] = m ? [+m[1], +m[2]] : def;
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

it.skipIf(!process.env.PREVIEW)(
  'render random / preset contact sheets',
  async () => {
    mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch();
    try {
      if (!process.env.PREVIEW_SKIP_PRESETS) {
        await sheet(
          browser,
          PRESETS.map((p) => ({ recipe: p.recipe, title: `${p.name} (${p.id}, ${p.recipe.mode})` })),
          'presets.png',
        );
      }
      const seeds = parseRange(process.env.PREVIEW_SEEDS, [1, 24]);
      const based = PRESETS.find((p) => p.id === process.env.PREVIEW_BASE)?.recipe;
      const ink = based ? { ...based, mode: 'ink' } : defaultRecipe();
      const metal = { ...(based ?? defaultRecipe()), mode: 'metal' };
      const locks = (process.env.PREVIEW_LOCKS ?? '').split(',').filter(Boolean);
      const tag = `${seeds[0]}-${seeds[seeds.length - 1]}`;
      await sheet(
        browser,
        seeds.map((seed) => ({ recipe: randomRecipe(seed, ink, locks), title: `seed ${seed}: ${randomRecipe(seed, ink, locks).name}` })),
        `random-ink-${tag}${locks.length ? '-locked' : ''}.png`,
      );
      await sheet(
        browser,
        seeds.map((seed) => ({ recipe: randomRecipe(seed, metal, locks), title: `seed ${seed}: ${randomRecipe(seed, metal, locks).name}` })),
        `random-metal-${tag}${locks.length ? '-locked' : ''}.png`,
      );
      if (process.env.PREVIEW_MUTATE) {
        const base = PRESETS.find((p) => p.id === process.env.PREVIEW_MUTATE)?.recipe;
        if (base) {
          const items = [{ recipe: base, title: `${base.name} (original)` }];
          let cur = base;
          for (let i = 1; i <= 11; i++) {
            cur = mutateRecipe(cur, i, []);
            items.push({ recipe: cur, title: `mutate step ${i}` });
          }
          await sheet(browser, items, `mutate-${process.env.PREVIEW_MUTATE}.png`);
        }
      }
      if (process.env.PREVIEW_WHERE) {
        const where = new Function('r', `return (${process.env.PREVIEW_WHERE});`);
        const found = [];
        for (let seed = 1; seed < 5000 && found.length < 24; seed++) {
          for (const base of [ink, metal]) {
            const r = randomRecipe(seed, base, []);
            if (found.length < 24 && where(r)) found.push({ recipe: r, title: `seed ${seed} ${base.mode}: ${r.name}` });
          }
        }
        await sheet(browser, found, 'where.png');
      }
      for (const spec of (process.env.PREVIEW_BIG ?? '').split(',').filter(Boolean)) {
        const [kind, id, mode] = spec.split(':');
        const recipe =
          kind === 'preset' ? PRESETS.find((p) => p.id === id)?.recipe : randomRecipe(+id, mode === 'metal' ? metal : ink, []);
        if (!recipe) continue;
        await sheet(browser, [{ recipe, title: `${spec}: ${recipe.name}` }], `big-${spec.replace(/:/g, '-')}.png`, 1000, 1);
      }
    } finally {
      await browser.close();
    }
  },
);
