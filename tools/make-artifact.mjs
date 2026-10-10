// Turns dist-single/index.html into an artifact page body (the host adds doctype/head/body).
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync('dist-single/index.html', 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1]
  .replace(/<meta charset[^>]*>/, '').replace(/<meta name="viewport"[^>]*>/, '');
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1];
// keep <title> first (the host scans the first 8KB for it)
const title = head.match(/<title>[\s\S]*?<\/title>/)[0];
writeFileSync('dist-single/province-forge.html', `${title}\n${head.replace(title, '').trim()}\n${body.trim()}\n`);
console.log('wrote dist-single/province-forge.html');
