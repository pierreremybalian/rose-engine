import { randomRecipe } from '../src/engine/random.ts';
import { defaultRecipe } from '../src/state/recipe.ts';
const counts = {};
for (const mode of ['ink', 'metal']) {
  const base = defaultRecipe(); base.mode = mode;
  const rows = [];
  for (let s = 1; s <= 40; s++) {
    const r = randomRecipe(s * 7919, base, []);
    const rock = r.rosettes.filter((x) => x.enabled && x.axis === 'rock').length;
    const pump = r.rosettes.filter((x) => x.enabled && x.axis === 'pump').length;
    const key = `${mode} rock${rock} pump${pump} ${mode === 'ink' ? r.ink.colorMode + '/' + r.ink.palette.length : 'enamel:' + r.metal.enamel}`;
    counts[key] = (counts[key] || 0) + 1;
  }
}
console.log(counts);
