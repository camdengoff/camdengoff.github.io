#!/usr/bin/env node
/**
 * Work out what someone changed in a copy of the single-file build, and which
 * source file each change belongs in.
 *
 *   npm run demo:diff -- ~/Downloads/their-copy.html
 *
 * The standalone HTML is generated: the next build overwrites it. So when
 * someone has been working in that file, the changes have to be lifted back
 * into `src/` and `public/` or they're lost. Diffing two 250KB HTML files by
 * hand is miserable and mostly reports noise, because the whole bundle shifts
 * when anything above it changes.
 *
 * This splits both files back into the modules they were built from and diffs
 * them one at a time, so the output says "here is what changed, and it belongs
 * in public/app.js".
 *
 * It compares against a build of the CURRENT working tree. If their copy
 * records an older source commit — the header carries one — check that commit
 * out first, or you'll see your own later work reported as their changes.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const theirs = process.argv.slice(2).find(a => !a.startsWith('-'));
if (!theirs) {
  console.error(`
Usage: npm run demo:diff -- <their-copy.html>

Shows what they changed, grouped by the source file it belongs in.
`);
  process.exit(1);
}

/** Pull the `__M["name"] = (function () { ... })();` blocks back out. */
function splitModules(html) {
  const out = new Map();
  const re = /\/\* ---- (.+?) ---- \*\/\n__M\["(.+?)"\] = \(function \(\) \{\n([\s\S]*?)\n\}\)\(\);/g;
  let m;
  while ((m = re.exec(html))) out.set(m[2], { file: m[1], body: m[3] });

  // The entry module (app.js) is emitted the same way but has no return.
  const entry = html.match(/\/\* ---- (public\/app\.js) ---- \*\/\n__M\["app"\] = \(function \(\) \{\n([\s\S]*?)\n\}\)\(\);/);
  if (entry) out.set('app', { file: entry[1], body: entry[2] });
  return out;
}

function stampOf(html) {
  const m = html.match(/Built from source commit:\s*(\S+)/);
  return m ? m[1] : null;
}

const theirHtml = readFileSync(theirs, 'utf8');

console.log('Building the current source for comparison…');
execSync('node scripts/build-standalone.js', { cwd: ROOT, stdio: 'ignore' });
const ourHtml = readFileSync(path.join(ROOT, 'dist', 'the-cage.html'), 'utf8');

const theirStamp = stampOf(theirHtml);
const ourStamp = stampOf(ourHtml);

console.log('');
console.log(`Their copy was built from: ${theirStamp || 'no stamp (an older build)'}`);
console.log(`Yours is built from:       ${ourStamp || 'unknown'}`);
if (theirStamp && ourStamp && theirStamp !== ourStamp) {
  console.log('');
  console.log('These differ, so some of what follows is your work, not theirs.');
  console.log(`For only their changes:  git stash && git checkout ${theirStamp.replace('+local-changes', '')}`);
  console.log('                         npm run demo:diff -- ' + theirs);
}

const ours = splitModules(ourHtml);
const theirModules = splitModules(theirHtml);

if (!theirModules.size) {
  console.error(`
Couldn't find any module blocks in that file.

It may not be one of these builds at all — if they wrote their own HTML from
scratch, there's nothing mechanical to lift out and it's a read-and-port job.
`);
  process.exit(1);
}

const tmp = path.join(os.tmpdir(), 'cage-diff-' + process.pid);
mkdirSync(tmp, { recursive: true });

let changed = 0;
const summary = [];

for (const [name, mine] of ours) {
  const theirMod = theirModules.get(name);
  if (!theirMod) {
    summary.push(`  ${String(name).padEnd(18)} missing from their copy (older build?)`);
    continue;
  }
  if (theirMod.body === mine.body) continue;

  changed++;
  const a = path.join(tmp, `${name}.ours.js`);
  const b = path.join(tmp, `${name}.theirs.js`);
  writeFileSync(a, mine.body);
  writeFileSync(b, theirMod.body);

  let patch = '';
  try {
    execFileSync('diff', ['-u', '--label', `a/${mine.file}`, '--label', `b/${mine.file}`, a, b],
      { encoding: 'utf8' });
  } catch (e) {
    patch = e.stdout || '';   // diff exits 1 when files differ
  }

  const added = (patch.match(/^\+(?!\+\+)/gm) || []).length;
  const removed = (patch.match(/^-(?!--)/gm) || []).length;
  summary.push(`  ${String(mine.file).padEnd(28)} +${added} -${removed}`);

  console.log('');
  console.log('='.repeat(72));
  console.log(`${mine.file}   (+${added} -${removed})`);
  console.log('='.repeat(72));
  console.log(patch.trim());
}

// Anything they added that didn't exist as a module at all.
for (const [name, mod] of theirModules) {
  if (!ours.has(name)) {
    changed++;
    console.log('');
    console.log('='.repeat(72));
    console.log(`NEW MODULE in their copy: ${name} (${mod.file})`);
    console.log('='.repeat(72));
    console.log(mod.body.slice(0, 4000));
    if (mod.body.length > 4000) console.log(`\n… ${mod.body.length - 4000} more characters`);
  }
}

rmSync(tmp, { recursive: true, force: true });

console.log('');
console.log('─'.repeat(72));
if (!changed) {
  console.log('No differences in any module. Their copy matches this source.');
} else {
  console.log(`${changed} module(s) differ:`);
  summary.forEach(s => console.log(s));
  console.log('');
  console.log('Apply these to the source files named above, not to the HTML.');
  console.log('Then: npm test && npm run build:standalone');
}
console.log('');
console.log('Note: CSS and markup live outside the module blocks and are not');
console.log('compared here. If they restyled anything, diff the <style> block');
console.log('against public/styles.css separately.');
