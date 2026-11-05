// Rasterise an exported SVG for a quick look: node dev/groove-svgshot.mjs <in.svg> <out.png>
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [inp, out] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 800, height: 800 } });
const svg = readFileSync(inp, 'utf8').replace(/width="[^"]*mm" height="[^"]*mm"/, 'width="800" height="800"');
await p.setContent(`<html><body style="margin:0;background:#fff">${svg.replace(/^<\?xml[^>]*>/, '')}</body></html>`);
await p.screenshot({ path: out });
await b.close();
