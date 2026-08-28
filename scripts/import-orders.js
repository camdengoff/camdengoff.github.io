#!/usr/bin/env node
/**
 * Import live state — gear currently checked out, and future reservations —
 * from a Cheqroom export (or any CSV) so the switchover doesn't lose track of
 * what's already out the door.
 *
 *   node scripts/import-orders.js orders.csv --kind=checkout --dry
 *   node scripts/import-orders.js orders.csv --kind=checkout
 *   node scripts/import-orders.js reservations.csv --kind=reservation
 *
 * Options
 *   --kind=checkout|reservation   what the file contains (required)
 *   --dry                         report only, write nothing
 *   --people=map.csv              two columns: source name/email → real email
 *   --notify-immediately          don't suppress the first reminder batch
 *   --allow-placeholders          create stub people for unmatched names
 *
 * Run scripts/import-csv.js first so the gear exists. This script never creates
 * items — an order referring to unknown gear is reported, not invented.
 *
 * `importOrders()` below is the part the Admin → Import screen also calls
 * (via src/api.js) — this file's main() is a thin CLI wrapper around it so
 * the two can't drift apart. It assumes the schema already exists; the CLI
 * wrapper calls migrate(), the web endpoint doesn't need to (the server ran
 * it at boot).
 */
import fs from 'node:fs';
import { q, migrate, pool, tx } from '../src/db.js';
import { parseCsv, buildIndex, describeColumns, cell, toDate, norm } from './lib-csv.js';

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const opt = name => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const FILE = argv.find(a => !a.startsWith('--'));
const KIND = opt('kind');
const DRY = flag('dry');
const NOTIFY_NOW = flag('notify-immediately');
const ALLOW_STUBS = flag('allow-placeholders');
const PEOPLE_MAP = opt('people');

/* Candidate column names, most specific first. */
const SPEC = {
  ref:      ['orderid', 'reservationid', 'ordernumber', 'reference', 'ref', 'id', 'order', 'reservation'],
  person:   ['customer', 'contactname', 'contact', 'assignedto', 'borrower', 'user', 'person', 'checkedoutto', 'reservedfor', 'customername'],
  email:    ['customeremail', 'contactemail', 'useremail', 'email'],
  item:     ['itemname', 'item', 'asset', 'equipment', 'assetname', 'name'],
  code:     ['assettag', 'itemcode', 'barcode', 'qrcode', 'code', 'tag'],
  serial:   ['serialnumber', 'serial', 'sn'],
  start:    ['checkoutdate', 'startdate', 'fromdate', 'datefrom', 'from', 'start', 'expectedcheckout', 'out'],
  due:      ['duedate', 'returndate', 'enddate', 'todate', 'dateto', 'expectedcheckin', 'due', 'to', 'end'],
  project:  ['project', 'purpose', 'jobname', 'location', 'note', 'notes', 'comment'],
  status:   ['status', 'state']
};
const REQUIRED = ['item'];

/* Statuses that mean "this is not live, skip it". */
const DEAD = ['returned', 'closed', 'completed', 'done', 'cancelled', 'canceled', 'checkedin', 'finished', 'expired'];

const today = () => new Date().toISOString().slice(0, 10);
const shiftDays = (d, n) => {
  const x = new Date(d + 'T12:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

/* --------------------------------------------------------------- people map */

/** Two columns: source name/email in the first, the real email in the second. */
function parsePeopleMap(text) {
  const map = new Map();
  if (!text) return map;
  const rows = parseCsv(text);
  // Skip a header row if the second column doesn't look like an email.
  const start = rows[0] && /@/.test(rows[0][1] || '') ? 0 : 1;
  for (const r of rows.slice(start)) {
    const from = String(r[0] || '').trim();
    const to = String(r[1] || '').trim().toLowerCase();
    if (from && to.includes('@')) map.set(norm(from), to);
  }
  return map;
}

/* ------------------------------------------------------------------ matching */

async function loadItems() {
  const { rows } = await q('SELECT id, code, name, serial FROM items');
  const byCode = new Map(), bySerial = new Map(), byName = new Map();
  for (const r of rows) {
    if (r.code) byCode.set(norm(r.code), r.id);
    if (r.serial) bySerial.set(norm(r.serial), r.id);
    if (r.name) byName.set(norm(r.name), r.id);
  }
  return { byCode, bySerial, byName, count: rows.length };
}

async function loadPeople() {
  const { rows } = await q('SELECT id, email, name FROM people');
  const byEmail = new Map(), byName = new Map();
  for (const r of rows) {
    byEmail.set(norm(r.email), r.id);
    if (r.name) byName.set(norm(r.name), r.id);
    // Also index the local part, so "Alex Rivera" finds alex.rivera@…
    byName.set(norm(r.email.split('@')[0]), r.id);
  }
  return { byEmail, byName };
}

/* ---------------------------------------------------------------------- core */

/**
 * Parses and imports a checkouts or reservations CSV. `dry` reports what
 * would happen and writes nothing. Returns a plain object — no console
 * output, no process.exit.
 */
export async function importOrders(csvText, kind, options = {}) {
  const { dry = false, notifyImmediately = false, allowPlaceholders = false, peopleMapText = null } = options;
  if (!['checkout', 'reservation'].includes(kind)) {
    return { ok: false, error: 'kind must be "checkout" or "reservation".' };
  }

  const rows = parseCsv(csvText);
  if (rows.length < 2) return { ok: false, error: 'No data rows in that file.' };

  const header = rows[0];
  const idx = buildIndex(header, SPEC);
  const { columns, missing } = describeColumns(header, SPEC, idx, REQUIRED);
  if (missing.length) {
    return {
      ok: false,
      error: `Cannot continue without: ${missing.join(', ')}. Rename the column in the CSV, or map it by hand.`,
      columns
    };
  }

  const items = await loadItems();
  const people = await loadPeople();
  const nameMap = parsePeopleMap(peopleMapText);

  /* ---- group rows into transactions ---------------------------------- */
  // Exports come in two shapes: one row per order with items on that row, or
  // one row per line item repeating the order reference. Grouping on the
  // reference handles both; without a reference each row stands alone.
  const groups = new Map();
  let lineNo = 1;
  for (const row of rows.slice(1)) {
    lineNo++;
    const status = cell(row, idx, 'status').toLowerCase();
    if (status && DEAD.some(d => norm(status).includes(d))) continue;

    const ref = cell(row, idx, 'ref') || `line-${lineNo}`;
    if (!groups.has(ref)) {
      groups.set(ref, {
        ref,
        person: cell(row, idx, 'person'),
        email: cell(row, idx, 'email').toLowerCase(),
        start: toDate(cell(row, idx, 'start')),
        due: toDate(cell(row, idx, 'due')),
        project: cell(row, idx, 'project'),
        lines: []
      });
    }
    const g = groups.get(ref);
    g.person ||= cell(row, idx, 'person');
    g.email ||= cell(row, idx, 'email').toLowerCase();
    g.start ||= toDate(cell(row, idx, 'start'));
    g.due ||= toDate(cell(row, idx, 'due'));
    g.project ||= cell(row, idx, 'project');
    g.lines.push({
      lineNo,
      item: cell(row, idx, 'item'),
      code: cell(row, idx, 'code'),
      serial: cell(row, idx, 'serial')
    });
  }

  /* ---- resolve ------------------------------------------------------- */
  const ready = [];
  const problems = [];
  const unmatchedPeople = new Set();
  const unmatchedItems = new Set();

  for (const g of groups.values()) {
    // people
    let personId = null;
    const mapped = nameMap.get(norm(g.person)) || nameMap.get(norm(g.email));
    const email = mapped || g.email;
    if (email) personId = people.byEmail.get(norm(email)) ?? null;
    if (!personId && g.person) personId = people.byName.get(norm(g.person)) ?? null;

    // An address from the source system is good enough to open a real account.
    // They've never signed in, but a magic link to that address will just work,
    // so there's no reason to make an admin map it by hand.
    const canCreateReal = !personId && email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

    // items
    const itemIds = [];
    for (const line of g.lines) {
      /* Ternaries, not `&&`: an empty code makes `line.code && …` evaluate to
         `''`, which is falsy but not nullish, so `??` accepted it as the answer
         and the serial and name fallbacks never ran. Gear with no asset tag —
         which a real export does contain — could then never be matched at all. */
      const hit =
        (line.code ? items.byCode.get(norm(line.code)) : null) ??
        (line.serial ? items.bySerial.get(norm(line.serial)) : null) ??
        (line.item ? items.byName.get(norm(line.item)) : null) ?? null;
      if (hit) {
        if (!itemIds.includes(hit)) itemIds.push(hit);
      } else {
        unmatchedItems.add(`${line.item || '(no name)'}${line.code ? ` [${line.code}]` : ''}`);
        problems.push(`ref ${g.ref} line ${line.lineNo}: no gear matches "${line.item}"${line.code ? ` / ${line.code}` : ''}`);
      }
    }

    // dates
    const start = g.start || today();
    let due = g.due;
    if (!due) {
      due = kind === 'checkout' ? today() : shiftDays(start, 1);
      problems.push(`ref ${g.ref}: no due date found, using ${due}`);
    }
    if (kind === 'reservation' && due < start) {
      problems.push(`ref ${g.ref}: end before start, skipped`);
      continue;
    }
    // A reservation that already finished isn't worth carrying over.
    if (kind === 'reservation' && due < today()) continue;

    if (!personId && !canCreateReal) {
      unmatchedPeople.add(g.person || g.email || '(blank)');
      if (!allowPlaceholders) {
        problems.push(`ref ${g.ref}: cannot identify "${g.person || g.email || 'blank'}", skipped`);
        continue;
      }
    }
    if (!itemIds.length) {
      problems.push(`ref ${g.ref}: no recognisable gear, skipped`);
      continue;
    }

    ready.push({ ...g, personId, email: email || null, itemIds, start, due, canCreateReal });
  }

  const summaryBase = {
    ok: true,
    columns,
    groupCount: groups.size,
    readyCount: ready.length,
    problems,
    unmatchedPeople: [...unmatchedPeople],
    unmatchedItems: [...unmatchedItems]
  };

  if (dry) {
    return {
      ...summaryBase,
      dry: true,
      preview: ready.slice(0, 50).map(r => ({
        ref: r.ref, person: r.person || r.email || 'stub', itemCount: r.itemIds.length, start: r.start, due: r.due
      }))
    };
  }

  if (!ready.length) {
    return { ...summaryBase, dry: false, created: 0, skipped: 0, stubs: 0, invited: 0, lateHolders: 0 };
  }

  /* ---- write --------------------------------------------------------- */
  let created = 0, skipped = 0, stubs = 0, invited = 0;

  for (const r of ready) {
    const externalRef = `${kind}:${r.ref}`;
    const table = kind === 'checkout' ? 'checkouts' : 'reservations';

    const { rows: existing } = await q(
      `SELECT id FROM ${table} WHERE external_ref = $1`, [externalRef]
    );
    if (existing.length) { skipped++; continue; }

    let personId = r.personId;
    if (!personId) {
      const label = r.person || 'imported';
      const isReal = r.canCreateReal;
      const address = isReal ? r.email : `${norm(label) || 'unknown'}@placeholder.invalid`;
      /* Each group resolved its person during preparation, before any of these
         inserts had run, so every group belonging to the same colleague still
         arrives here with no personId. The upsert is idempotent, so the data
         was always right — but counting on the way past reported one new
         account per reservation rather than one per person, which read as
         though the import had made 52 accounts for 7 people. */
      personId = people.byEmail.get(norm(address)) ?? null;
      if (!personId) {
        const { rows: [p] } = await q(
          `INSERT INTO people (email, name, placeholder) VALUES ($1, $2, $3)
           ON CONFLICT (email) DO UPDATE SET
             name = CASE WHEN people.name = '' THEN EXCLUDED.name ELSE people.name END
           RETURNING id`,
          [address, label, !isReal]
        );
        personId = p.id;
        people.byEmail.set(norm(address), personId);
        if (isReal) invited++; else stubs++;
      }
    }

    await tx(async client => {
      if (kind === 'checkout') {
        const { rows: [co] } = await client.query(
          `INSERT INTO checkouts (holder_id, actor_id, project, out_at, due_on, note, external_ref)
           VALUES ($1, NULL, $2, $3::date, $4, $5, $6) RETURNING id`,
          [personId, r.project || '', r.start, r.due, `Imported from Cheqroom (${r.ref})`, externalRef]
        );
        for (const itemId of r.itemIds) {
          await client.query(
            'INSERT INTO checkout_items (checkout_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [co.id, itemId]
          );
        }
        // Keep the first reminder batch quiet for gear that was already out.
        if (!notifyImmediately) {
          for (const notifKind of ['due_tomorrow', 'due_today', 'overdue']) {
            await client.query(
              `INSERT INTO notifications (kind, ref, on_date) VALUES ($1, $2, CURRENT_DATE)
               ON CONFLICT DO NOTHING`,
              [notifKind, String(co.id)]
            );
          }
        }
      } else {
        const { rows: [rv] } = await client.query(
          `INSERT INTO reservations (person_id, start_on, end_on, project, external_ref)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [personId, r.start, r.due, r.project || '', externalRef]
        );
        for (const itemId of r.itemIds) {
          await client.query(
            'INSERT INTO reservation_items (reservation_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [rv.id, itemId]
          );
        }
        if (!notifyImmediately) {
          await client.query(
            `INSERT INTO notifications (kind, ref, on_date) VALUES ('pickup', $1, CURRENT_DATE)
             ON CONFLICT DO NOTHING`,
            [String(rv.id)]
          );
        }
      }
    });
    created++;
  }

  const { rows: [late] } = await q(
    `SELECT count(DISTINCT holder_id)::int AS n FROM checkouts
     WHERE returned_at IS NULL AND due_on < CURRENT_DATE`
  );

  return { ...summaryBase, dry: false, created, skipped, stubs, invited, lateHolders: late.n };
}

/* ---------------------------------------------------------------------- cli */

async function main() {
  if (!FILE || !['checkout', 'reservation'].includes(KIND)) {
    console.error(`Usage: node scripts/import-orders.js <file.csv> --kind=checkout|reservation [options]

  --dry                    report only, write nothing
  --people=map.csv         map source names to real emails
  --notify-immediately     allow reminders to fire for imported rows today
  --allow-placeholders     create stub people for names you can't map yet`);
    process.exit(1);
  }

  const csvText = fs.readFileSync(FILE, 'utf8');
  const peopleMapText = PEOPLE_MAP ? fs.readFileSync(PEOPLE_MAP, 'utf8') : null;
  if (PEOPLE_MAP) console.log(`Loaded name→email mapping(s) from ${PEOPLE_MAP}.`);

  await migrate();
  console.log('');

  const result = await importOrders(csvText, KIND, {
    dry: DRY, notifyImmediately: NOTIFY_NOW, allowPlaceholders: ALLOW_STUBS, peopleMapText
  });

  if (!result.ok) {
    if (result.columns) {
      console.log('Columns detected:');
      const width = Math.max(...result.columns.map(c => c.field.length));
      for (const c of result.columns) {
        const flag = !c.header && c.required ? '  ** REQUIRED **' : '';
        console.log(`  ${c.field.padEnd(width)}  ${c.header ? `← "${c.header}"` : '— not found'}${flag}`);
      }
      console.log('');
    }
    console.error(result.error);
    process.exit(1);
  }

  console.log('Columns detected:');
  const width = Math.max(...result.columns.map(c => c.field.length));
  for (const c of result.columns) {
    const flag = !c.header && c.required ? '  ** REQUIRED **' : '';
    console.log(`  ${c.field.padEnd(width)}  ${c.header ? `← "${c.header}"` : '— not found'}${flag}`);
  }
  console.log(`\nMatching against gear already in the database.\n`);

  console.log(`Found ${result.groupCount} live ${KIND}(s) in the file.`);
  console.log(`Ready to import: ${result.readyCount}`);
  if (result.problems.length) {
    console.log(`\nIssues (${result.problems.length}):`);
    result.problems.slice(0, 40).forEach(p => console.log(`  - ${p}`));
    if (result.problems.length > 40) console.log(`  … and ${result.problems.length - 40} more`);
  }
  if (result.unmatchedPeople.length) {
    console.log(`\nUnrecognised people (${result.unmatchedPeople.length}):`);
    result.unmatchedPeople.forEach(p => console.log(`  ${p}`));
    console.log(`\nMap them with a two-column CSV and --people=map.csv:`);
    console.log(`  ${result.unmatchedPeople[0]},firstname.lastname@life.church`);
    console.log(`Or pass --allow-placeholders to create stub accounts you can merge later.`);
  }
  if (result.unmatchedItems.length) {
    console.log(`\nUnrecognised gear (${result.unmatchedItems.length}):`);
    result.unmatchedItems.slice(0, 25).forEach(i => console.log(`  ${i}`));
    console.log(`\nRun scripts/import-csv.js on your inventory export first.`);
  }

  if (DRY) {
    console.log(`\nDry run — nothing written.`);
    if (result.preview.length) {
      console.log(`\nPreview:`);
      result.preview.forEach(r => console.log(
        `  ${r.ref.padEnd(14)} ${r.person.padEnd(22)} ${r.itemCount} item(s)  ${r.start} → ${r.due}`
      ));
      if (result.readyCount > result.preview.length) console.log(`  … and ${result.readyCount - result.preview.length} more`);
    }
    await pool.end();
    return;
  }

  if (!result.readyCount) {
    console.log('\nNothing to import.');
    await pool.end();
    return;
  }

  console.log(`\nImported ${result.created} ${KIND}(s). ${result.skipped} already present, left alone.`);
  if (result.invited) {
    console.log(`Created ${result.invited} account(s) from addresses in the export. They can sign`);
    console.log(`in straight away — no invite needed, the magic link does it.`);
  }
  if (result.stubs) {
    console.log(`Created ${result.stubs} placeholder account(s). They can't sign in until the`);
    console.log(`address is corrected on the Admin → People screen.`);
  }
  if (!NOTIFY_NOW && KIND === 'checkout') {
    console.log(`\nToday's reminders are suppressed for these, so nobody gets an overdue`);
    console.log(`notice about gear they took out before the switchover. Tomorrow's batch`);
    console.log(`runs normally. Pass --notify-immediately to skip that.`);
  }

  if (result.lateHolders > 0) {
    console.log(`\nHeads up: ${result.lateHolders} person/people now hold overdue gear. With`);
    console.log(`block_overdue_borrowers on, they can't check anything out until it's`);
    console.log(`back. Consider raising overdue_grace_days on the Admin screen for the`);
    console.log(`first week so day one isn't a wall of blocks.`);
  }

  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
