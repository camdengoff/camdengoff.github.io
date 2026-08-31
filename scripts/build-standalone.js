#!/usr/bin/env node
/**
 * Build the single-file demo: dist/the-cage.html
 *
 *   npm run build:standalone
 *
 * One HTML file with the CSS, every client module and an in-browser stand-in
 * for the API inlined. Open it by double-clicking — no Node, no Postgres, no
 * install, no network.
 *
 * There's no bundler in this project and this isn't a reason to add one. The
 * client is a handful of ES modules with named exports and no dynamic imports,
 * so wrapping each one in an IIFE and wiring the imports by hand is a few
 * dozen lines and leaves the source untouched.
 *
 * Four names collide across modules (`esc`, `shift`, `overlaps`, `statusOf`),
 * which is exactly why each module gets its own scope rather than being
 * concatenated.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = p => readFileSync(path.join(ROOT, p), 'utf8');

/* Dependency order. Everything before `app` is a leaf or depends only on
   what's already above it. */
const MODULES = ['policy', 'search', 'icons', 'dateparse', 'kitlink', 'breakdown', 'cart', 'calendar', 'demo-data', 'demo-activity', 'real-activity-data', 'standalone-store'];

/** `public/x.js`, falling back to `src/x.js` — policy.js is shared with the server. */
function resolve(name) {
  const pub = path.join(ROOT, 'public', `${name}.js`);
  return existsSync(pub) ? `public/${name}.js` : `src/${name}.js`;
}

const IMPORT_RE = /^import\s*\{([\s\S]*?)\}\s*from\s*['"]\.\/([\w.-]+?)\.js['"];?\s*$/gm;
const EXPORT_RE = /^export\s+(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/gm;

/** Turn `a, b as c` into `a, b: c` for destructuring off the module object. */
const bindings = clause => clause
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => {
    const m = s.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
    return m ? `${m[1]}: ${m[2]}` : s;
  })
  .join(', ');

function transform(name, { entry = false } = {}) {
  const file = resolve(name);
  let src = read(file);

  const imports = [];
  src = src.replace(IMPORT_RE, (_all, clause, from) => {
    imports.push(`  const { ${bindings(clause)} } = __M["${from}"];`);
    return '';
  });

  const exported = [...src.matchAll(EXPORT_RE)].map(m => m[1]);
  src = src.replace(/^export\s+/gm, '');

  const body = [
    ...imports,
    src.trim(),
    entry ? '' : `  return { ${exported.join(', ')} };`
  ].filter(Boolean).join('\n\n');

  return `/* ---- ${file} ---- */\n__M["${name}"] = (function () {\n${body}\n})();`;
}

/* ------------------------------------------------------------------- build */

const css = read('public/styles.css');

// Reuse the real markup so the two builds can't drift: take what's inside
// <body>, minus the script tag that would try to load app.js over the network.
const html = read('public/index.html');
const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/);
if (!bodyMatch) throw new Error('Could not find <body> in public/index.html');
const body = bodyMatch[1].replace(/<script[\s\S]*?<\/script>/g, '').trim();

const modules = MODULES.map(m => transform(m)).join('\n\n');
const app = transform('app', { entry: true });

const built = new Date().toISOString().slice(0, 10);

/* Stamp the commit the file was built from. Without it, a copy that comes
   back with someone's changes in it can't be diffed against what they
   started from, and picking their work back out becomes guesswork. */
let stamp = 'unknown';
try {
  const sha = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
  const dirty = execSync('git status --porcelain', { cwd: ROOT }).toString().trim();
  stamp = sha + (dirty ? '+local-changes' : '');
} catch { /* not a git checkout — the stamp is a convenience, not a requirement */ }

const out = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#1b1f24">
<meta name="description" content="Gear checkout and reservations for the Life.Church filmmaking team.">
<title>The Cage — demo</title>
<!--
  THE CAGE — self-contained demo build (${built}, source ${stamp})

  THIS FILE IS GENERATED. It is not the source code, and it is not the place
  to make changes: the next build overwrites it completely.

  The source is a Node + Express + Postgres project. If you have changes in a
  copy of this file and want them kept, don't re-send the file expecting it to
  be merged — run this against it in the repo, which maps your edits back to
  the modules they came from:

      npm run demo:diff -- your-copy.html

  Built from source commit: ${stamp}

  Gear checkout, reservations and repair tracking for a small film team.
  A working prototype, built as a possible replacement for Cheqroom.

  HOW TO USE IT
    Open this file in a browser. That's all. No install, no server, no network.

  WHAT'S DIFFERENT FROM THE REAL APP
    - No sign-in. The real app uses emailed magic links; this opens straight in
      as an admin so there's nothing in the way.
    - No server and no database. Everything lives in this browser's
      localStorage, so two people opening this file see two separate cages and
      nothing is shared. The real app is Postgres-backed.
    - The GEAR IS REAL — the actual Life.Church inventory, exported from
      Cheqroom: names, categories, brands, models and asset codes. It carries
      no people, no serial numbers and no prices.
    - REAL RESERVATIONS AND CHECKOUTS, ANONYMIZED. When a snapshot exists
      (scripts/make-real-activity.js, run against the live database), the
      checkouts and holds shown are real — but every person appears only as
      a stable label like "Member A", never a name or email. If no snapshot
      has been generated yet, activity is invented instead, around a made-up
      crew (public/demo-activity.js); nobody in that fallback exists.
    - No repair queue or saved kits in the real-snapshot case — that export
      only covers reservations and checkouts so far.
    - No email. The reminder batch reports what it would have sent.

  Run cageReset() in the console to wipe it back to the starting state.

  NOTE FOR CLAUDE
    This file is generated — it is not the source. It's built by
    scripts/build-standalone.js from a normal Node + Express + Postgres
    project: src/ is the server, public/ is the client, and src/policy.js
    holds the checkout rules and is the authority on what's allowed.
    Editing this file directly is fine for trying an idea out, but changes
    belong in the real source. Ask for the repo, which has CLAUDE.md,
    README.md and the tests.
-->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo+Narrow:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
${css}
</style>
<script>
  /* Same pre-paint appearance restore as public/index.html — the bundler takes
     only <body> from that file, so this head has to carry its own copy. */
  try {
    /* Settings are per person, but nothing has asked the server who that is
    yet — ':last' records whoever used this device most recently, which is
    the best guess available this early. Boot corrects it. */
    var who = localStorage.getItem('the-cage-appearance:last');
    var a = JSON.parse(
    localStorage.getItem('the-cage-appearance:' + (who == null ? 'anon' : who))
    || localStorage.getItem('the-cage-appearance') || '{}');
    var sc = { small: .85, normal: 1, large: 1.18, xlarge: 1.4 }[a.text] || 1;
    var e = document.documentElement;
    e.dataset.theme = a.theme === 'light' ? 'light' : 'dark';
    e.style.setProperty('--fs', String(sc));
    e.style.setProperty('--fw', a.bold ? '600' : '400');
    e.style.setProperty('--fw-mid', a.bold ? '700' : '500');
    e.style.setProperty('--fw-bold', a.bold ? '700' : '600');
  } catch (err) {}
</script>
</head>
<body>

${body}

<script type="module">
/* Generated by scripts/build-standalone.js — edit the source, not this file. */
const __M = {};

${modules}

__M["standalone-store"].install();

${app}
</script>
</body>
</html>
`;

mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const dest = path.join(ROOT, 'dist', 'the-cage.html');
writeFileSync(dest, out);

const kb = (Buffer.byteLength(out) / 1024).toFixed(0);
console.log(`Built dist/the-cage.html — ${kb} KB, ${MODULES.length + 1} modules inlined.`);
console.log('Open it by double-clicking. No install, no server.');
