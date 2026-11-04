// Contact sheet: node dev/qa-sheet.mjs out.png cols img1 img2 ...
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
const [out, cols, ...files] = process.argv.slice(2);
const cells = files.map((f) => `<figure><img src="data:image/png;base64,${readFileSync(f).toString('base64')}"><figcaption>${basename(f)}</figcaption></figure>`).join('');
const html = `<style>body{margin:0;background:#222;color:#ddd;font:12px sans-serif;display:grid;grid-template-columns:repeat(${cols},1fr);gap:6px;padding:6px}figure{margin:0}img{width:100%;display:block}</style>${cells}`;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1400, height: 800 } });
await p.setContent(html);
await p.screenshot({ path: out, fullPage: true });
await b.close();
