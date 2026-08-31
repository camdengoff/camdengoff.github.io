#!/usr/bin/env node
/**
 * Freeze current reservations and checkouts into public/real-activity-data.js,
 * for the single-file build to seed itself from — same idea as
 * make-demo-data.js, but for activity instead of inventory.
 *
 *   npm run demo:activity
 *
 * The gear list is real (make-demo-data.js). Who has it was, until now,
 * always invented (demo-activity.js) — nobody real ever appeared on the
 * public build. This script makes the *activity* real too, while keeping
 * every person anonymous:
 *
 *   - No name or email ever leaves this script. The query that looks up
 *     people selects only `id` and `role` — there is no column to leak.
 *   - Each real person is assigned a stable label ("Member A", "Member B", …)
 *     the first time they show up, recorded in scripts/person-tags.json and
 *     never reassigned. That file holds nothing but small integers mapped to
 *     labels — it is safe to commit and diff.
 *   - Free-text fields (project/shoot) travel as-is, since removing them
 *     would make the board look empty, but are scanned for anything that
 *     looks like an email address before this writes anything out. They are
 *     NOT scanned for names typed into that text — if your team's project
 *     names ever include a colleague's name, scrub those in Postgres or
 *     extend `clean()` below before re-running this.
 *   - `note` is dropped entirely: free text with no display value here and
 *     the highest chance of carrying something personal.
 *
 * Re-run whenever you want the public build to reflect current activity,
 * then rebuild:
 *   npm run demo:activity && npm run build:standalone
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q, pool } from '../src/db.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TAGS_PATH = path.join(ROOT, 'scripts', 'person-tags.json');

/* Belt and braces, same as make-demo-data.js: strip anything that looks like
   an email address out of free text before it can travel. */
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const clean = s => String(s || '').replace(EMAIL, '').trim();

/** 0 -> A, 1 -> B, … 25 -> Z, 26 -> AA, 27 -> AB, … spreadsheet-column style. */
function letters(n) {
  let s = '';
  n += 1;
  while (n > 0) {
    n -= 1;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

/** Load the persisted id->tag map, or start a fresh one. Keys are strings
    because JSON object keys always are. */
function loadTags() {
  if (!existsSync(TAGS_PATH)) return {};
  try { return JSON.parse(readFileSync(TAGS_PATH, 'utf8')); }
  catch { return {}; }
}

/** Assign a tag to every person id that doesn't already have one. Existing
    assignments are never changed, so a label stays that person's label
    across every future run of this script. */
function tagsFor(personIds, existing) {
  const tags = { ...existing };
  const used = new Set(Object.values(tags));
  let next = 0;
  const nextTag = () => {
    let label;
    do { label = `Member ${letters(next++)}`; } while (used.has(label));
    used.add(label);
    return label;
  };
  for (const id of personIds) {
    if (!(String(id) in tags)) tags[String(id)] = nextTag();
  }
  return tags;
}

async function main() {
  const { rows: checkoutRows } = await q(`
    SELECT c.id, c.holder_id, c.project, c.shoot, c.out_at::date::text AS out_at,
           c.due_on::text AS due_on,
           c.returned_at::date::text AS returned_at,
           array_agg(i.code ORDER BY i.code) AS item_codes
    FROM checkouts c
    JOIN checkout_items ci ON ci.checkout_id = c.id
    JOIN items i ON i.id = ci.item_id
    WHERE c.returned_at IS NULL OR c.returned_at > now() - interval '90 days'
    GROUP BY c.id
    ORDER BY c.out_at
  `);

  const { rows: reservationRows } = await q(`
    SELECT r.id, r.person_id, r.project, r.shoot,
           r.start_on::text AS start_on, r.end_on::text AS end_on,
           array_agg(i.code ORDER BY i.code) AS item_codes
    FROM reservations r
    JOIN reservation_items ri ON ri.reservation_id = r.id
    JOIN items i ON i.id = ri.item_id
    WHERE r.cancelled_at IS NULL
      AND r.fulfilled_at IS NULL
      AND r.end_on > CURRENT_DATE - INTERVAL '3 days'
    GROUP BY r.id
    ORDER BY r.start_on
  `);

  /* Only id and role — no name, no email, nothing else. */
  const personIds = [...new Set([
    ...checkoutRows.map(c => c.holder_id),
    ...reservationRows.map(r => r.person_id)
  ])];
  const { rows: peopleRows } = personIds.length
    ? await q(`SELECT id, role FROM people WHERE id = ANY($1) ORDER BY id`, [personIds])
    : { rows: [] };

  const tags = tagsFor(personIds, loadTags());
  writeFileSync(TAGS_PATH, JSON.stringify(tags, null, 2) + '\n');

  const tagFor = id => tags[String(id)];

  const people = peopleRows.map(p => ({
    tag: tagFor(p.id),
    role: p.role === 'admin' ? 'admin' : 'member'
  }));

  const checkouts = checkoutRows.map(c => ({
    holder_tag: tagFor(c.holder_id),
    project: clean(c.project),
    shoot: clean(c.shoot),
    out_at: c.out_at,
    due_on: c.due_on,
    returned_at: c.returned_at,
    item_codes: c.item_codes
  }));

  const reservations = reservationRows.map(r => ({
    person_tag: tagFor(r.person_id),
    project: clean(r.project),
    shoot: clean(r.shoot),
    start_on: r.start_on,
    end_on: r.end_on,
    item_codes: r.item_codes
  }));

  const payload = { people, checkouts, reservations };
  const leaked = JSON.stringify(payload).match(EMAIL);
  if (leaked) {
    console.error(`Refusing to write: found what looks like ${leaked.length} email address(es) in the export.`);
    process.exit(1);
  }

  const generatedAt = new Date().toISOString().slice(0, 10);
  const out = `/**
 * Generated by scripts/make-real-activity.js — do not edit by hand.
 *
 * Real reservations and checkouts, anonymized: every person is a stable tag
 * ("Member A") rather than a name or email — see scripts/person-tags.json.
 * Gear is referenced by code, matched against public/demo-data.js at seed
 * time. If this is empty, the single-file build falls back to the invented
 * crew in public/demo-activity.js.
 *
 * ${people.length} people, ${checkouts.length} checkouts, ${reservations.length} reservations.
 * Generated ${generatedAt}.
 */
export const REAL_ACTIVITY = ${JSON.stringify(payload, null, 0)};
`;

  writeFileSync(path.join(ROOT, 'public', 'real-activity-data.js'), out);

  console.log(`Wrote public/real-activity-data.js — ${people.length} people, ${checkouts.length} checkouts, ${reservations.length} reservations.`);
  console.log('No names or emails included.');
  await pool.end();
}

main().catch(async err => {
  console.error('Failed:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
