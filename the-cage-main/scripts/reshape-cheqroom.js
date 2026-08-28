/**
 * Turn Cheqroom's own exports into the shape `import-orders.js` reads.
 *
 * Cheqroom exports two files that between them hold the live state, but
 * neither is in a form the importer can take directly:
 *
 *   items export        — one row per item, carrying the *current* checkout
 *                         (Check-out Started/Due/Id, Contact Name/Email)
 *   reservations export — one row per reservation, with the gear listed as a
 *                         comma-separated string of Cheqroom's internal item
 *                         ids, and no codes or names at all
 *
 * So reservations only become importable by joining them back to the items
 * export on that internal id. That's why this takes both files.
 *
 * Two quirks worth knowing, both found the hard way:
 *
 * - **The reservation dates are malformed.** They arrive as
 *   `2026-09-09/30/26 09:00:00` — a `YYYY-MM-` prefix glued to a US
 *   `MM/DD/YY`. The prefix month and the slash month agree, so the slash part
 *   is authoritative and the prefix contributes only the century.
 * - **Not every item has a code.** Cheqroom lets an item exist with an empty
 *   `Codes` field, and `import-csv.js` generates one on import, so the two
 *   sides won't agree. Those lines fall back to matching on name.
 *
 * Usage:
 *   node scripts/reshape-cheqroom.js --items=items.csv --out=./out
 *   node scripts/reshape-cheqroom.js --items=items.csv --reservations=res.csv --out=./out
 *
 * Writes checkouts.csv and (when given reservations) reservations.csv, then
 * you run import-orders.js on each. Reads only; nothing touches a database.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseCsv, sniffDelimiter } from './lib-csv.js';

const argv = process.argv.slice(2);
const arg = name => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const ITEMS = arg('items');
const RES = arg('reservations');
const OUT = arg('out') || '.';

if (!ITEMS) {
  console.error(`Usage: node scripts/reshape-cheqroom.js --items=items.csv [--reservations=res.csv] [--out=dir]

  --items=FILE          Cheqroom items export (required — reservations are
                        joined against it to resolve gear)
  --reservations=FILE   Cheqroom reservations export
  --out=DIR             where to write the reshaped CSVs (default: .)`);
  process.exit(1);
}

const read = file => {
  const text = readFileSync(file, 'utf8');
  const rows = parseCsv(text, sniffDelimiter(text));
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).filter(r => r.some(c => (c || '').trim()))
    .map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
};

/** `2026-09-09/30/26 09:00:00` → `2026-09-30`. Plain ISO passes through. */
export function cheqroomDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const glued = /^(\d{4})-\d{2}-(\d{2})\/(\d{2})\/(\d{2})\b/.exec(s);
  if (glued) {
    const [, yyyy, mm, dd, yy] = glued;
    return yyyy.slice(2) === yy ? `${yyyy}-${mm}-${dd}` : `20${yy}-${mm}-${dd}`;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : '';
}

/* Cheqroom parks broken gear against a stand-in contact rather than a person.
   Importing that as a loan would invent someone called "Maintenance" and show
   the gear as out with them, instead of down for repair. */
const NOT_A_PERSON = [/^maintenance$/i, /^todo@/i, /^n\/?a$/i];
const isPlaceholderContact = (name, email) =>
  NOT_A_PERSON.some(re => re.test(name || '') || re.test(email || ''));

const csv = rows => {
  const cols = Object.keys(rows[0]);
  const cell = v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n') + '\n';
};

const items = read(ITEMS);
const byInternalId = new Map(items.filter(r => r.Id).map(r => [r.Id, r]));
console.log(`Items export: ${items.length} row(s), ${byInternalId.size} with a Cheqroom id.`);

mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------- checkouts */

const openLoans = items.filter(r => r['Check-out Started'] && !r['Check-out Finished']);
const repairs = openLoans.filter(r => isPlaceholderContact(r['Contact Name'], r['Contact Email']));
const loans = openLoans.filter(r => !isPlaceholderContact(r['Contact Name'], r['Contact Email']));

if (loans.length) {
  const rows = loans.map(r => ({
    'Order ID': r['Check-out Id'],
    'State': 'Checked out',
    'Customer': r['Contact Name'],
    'Email': (r['Contact Email'] || '').toLowerCase(),
    'From': cheqroomDate(r['Check-out Started']),
    'Due': cheqroomDate(r['Check-out Due']),
    'Item name': r.Name,
    'Asset Tag': r.Codes || '',
    'Purpose': r['Check-out Location Name'] || ''
  }));
  writeFileSync(path.join(OUT, 'checkouts.csv'), csv(rows));
  const orders = new Set(rows.map(r => r['Order ID'])).size;
  console.log(`Wrote checkouts.csv — ${rows.length} line item(s) across ${orders} order(s).`);
}

if (repairs.length) {
  const rows = repairs.map(r => ({
    'Asset Tag': r.Codes || '',
    'Item name': r.Name,
    'Opened': cheqroomDate(r['Check-out Started']),
    'Contact': r['Contact Name']
  }));
  writeFileSync(path.join(OUT, 'repairs.csv'), csv(rows));
  console.log(`Wrote repairs.csv — ${rows.length} item(s) parked against "${repairs[0]['Contact Name']}".`);
  console.log('  These are not loans. Raise them as repair tickets, not checkouts.');
}

/* ---------------------------------------------------------- reservations */

if (RES) {
  const res = read(RES);
  const live = res.filter(r => (r.status || '').toLowerCase() === 'open');
  console.log(`\nReservations export: ${res.length} row(s), ${live.length} open.`);

  const rows = [];
  let unresolved = 0;
  for (const r of live) {
    const from = cheqroomDate(r.fromDate);
    const to = cheqroomDate(r.toDate);
    const purpose = [r.name, r['Project Description']].filter(Boolean).join(' — ');
    for (const id of (r.items || '').split(',').map(s => s.trim()).filter(Boolean)) {
      const it = byInternalId.get(id);
      if (!it) { unresolved++; continue; }
      rows.push({
        'Reservation ID': r.number,
        'State': 'Reserved',
        'Reserved For': r['contact name'],
        'Email': (r['contact email'] || '').toLowerCase(),
        'From': from,
        'To': to,
        'Item name': it.Name,
        'Asset Tag': it.Codes || '',
        'Purpose': purpose
      });
    }
  }
  writeFileSync(path.join(OUT, 'reservations.csv'), csv(rows));
  const groups = new Set(rows.map(r => r['Reservation ID'])).size;
  console.log(`Wrote reservations.csv — ${rows.length} line item(s) across ${groups} reservation(s).`);
  if (unresolved) {
    console.log(`  ${unresolved} item reference(s) had no match in the items export.`);
  }
  const noCode = rows.filter(r => !r['Asset Tag']).length;
  if (noCode) console.log(`  ${noCode} line(s) have no code and will be matched by name.`);
}

console.log('\nNothing was written to any database. Run import-orders.js next, with --dry first.');
