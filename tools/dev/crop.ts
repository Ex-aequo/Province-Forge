// Dev helper: render a zoomed crop of a standalone SVG. Usage: tsx tools/dev/crop.ts in.svg x y w h out.png
import { readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
const [file, x, y, w, h, out] = process.argv.slice(2);
const svg = readFileSync(file, 'utf8');
// wrap the whole document in a nested <svg> with the crop viewBox (keeps the original intact)
const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const doc = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1600" height="${Math.round(1600 * Number(h) / Number(w))}" viewBox="${x} ${y} ${w} ${h}">${inner}</svg>`;
writeFileSync(out, new Resvg(doc).render().asPng());
console.log('wrote', out);
