#!/usr/bin/env node
/**
 * Seed a demo cage: gear, people, and enough live activity that the board,
 * the calendar and the reminder batch all have something to show.
 *
 *   npm run seed            # add anything missing
 *   npm run seed -- --reset # wipe the demo data first, then re-seed
 *
 * Everything is dated relative to CURRENT_DATE, so a demo left running for a
 * month still looks current rather than showing a wall of ancient overdue kit.
 *
 * Safe to re-run: gear is matched on code, people on email, and the activity
 * is only created when there is none, so a second run is a no-op.
 *
 * This writes DEMO DATA. Don't point it at the instance holding your real
 * inventory — see the guard below.
 */
import { q, tx, migrate, pool } from '../src/db.js';

const RESET = process.argv.includes('--reset');
const FORCE = process.argv.includes('--force');

/* Demo people are marked placeholder so they're visibly not real accounts,
   and so an admin can spot them under Admin → People when it's time to clear
   the demo out. */
const PEOPLE = [
  ['alex.rivera@example.com', 'Alex Rivera'],
  ['priya.raman@example.com', 'Priya Raman'],
  ['marcus.webb@example.com', 'Marcus Webb'],
  ['jo.feldman@example.com', 'Jo Feldman']
];

const ITEMS = [
  // code, name, category, brand, model
  ['LC-101', 'PYXIS 6K', 'Camera', 'Blackmagic', 'PYXIS 6K'],
  ['LC-102', 'C400', 'Camera', 'Canon', 'EOS C400'],
  ['LC-103', 'C80', 'Camera', 'Canon', 'EOS C80'],
  ['LC-104', 'FX3', 'Camera', 'Sony', 'ILME-FX3'],
  ['LC-110', 'Sigma 18-35 f1.8', 'Lens', 'Sigma', '18-35mm f/1.8 DC HSM'],
  ['LC-111', 'Sigma 50-100 f1.8', 'Lens', 'Sigma', '50-100mm f/1.8 DC HSM'],
  ['LC-112', 'Canon RF 24-70 f2.8', 'Lens', 'Canon', 'RF 24-70mm f/2.8L'],
  ['LC-113', 'Canon RF 70-200 f2.8', 'Lens', 'Canon', 'RF 70-200mm f/2.8L'],
  ['LC-114', 'Laowa Probe', 'Lens', 'Laowa', '24mm f/14 Probe'],
  ['LC-120', 'Astera Titan Tube (x4)', 'Lighting', 'Astera', 'Titan Tube'],
  ['LC-121', 'Aputure 600D', 'Lighting', 'Aputure', 'LS 600d Pro'],
  ['LC-122', 'Aputure 300X', 'Lighting', 'Aputure', 'LS 300X'],
  ['LC-123', 'Nanlite PavoTube II', 'Lighting', 'Nanlite', 'PavoTube II 30X'],
  ['LC-130', 'MixPre-10 II', 'Audio', 'Sound Devices', 'MixPre-10 II'],
  ['LC-131', 'Sennheiser MKH 416', 'Audio', 'Sennheiser', 'MKH 416'],
  ['LC-132', 'Wireless GO II (x2)', 'Audio', 'Rode', 'Wireless GO II'],
  ['LC-133', 'Boom Pole', 'Audio', 'K-Tek', 'KEG-100CC'],
  ['LC-140', 'Sachtler FSB 8', 'Support', 'Sachtler', 'FSB 8 Fluid Head'],
  ['LC-141', 'Ronin 4D', 'Support', 'DJI', 'Ronin 4D-6K'],
  ['LC-142', 'Slider 100cm', 'Support', 'Rhino', 'Slider Pro 42"'],
  ['LC-150', 'C-Stand (x6)', 'Grip', 'Matthews', '40" C-Stand'],
  ['LC-151', 'Apple Box Set', 'Grip', 'Matthews', 'Full Set'],
  ['LC-160', 'V-Mount Kit (x6)', 'Power', 'Core SWX', 'Hypercore NEO 9'],
  ['LC-170', 'SmallHD 702 Touch', 'Monitoring', 'SmallHD', '702 Touch']
];

/* name, gear, owner email (null = the old unowned team list), shared.
   One of each so the Packages tab shows all three states: yours, a
   colleague's published one you can copy, and a legacy preset nobody owns.
   All four are hand-curated, so they default to type='package' — nothing
   here is a physical kit. */
const KITS = [
  ['Interview Kit', ['LC-102', 'LC-112', 'LC-131', 'LC-130', 'LC-122', 'LC-140'], null, false],
  ['Run & Gun', ['LC-104', 'LC-110', 'LC-132', 'LC-160'], 'alex.rivera@example.com', true],
  ['Doc Package', ['LC-101', 'LC-113', 'LC-114', 'LC-120', 'LC-170'], 'priya.raman@example.com', true],
  ['Podcast 2-cam', ['LC-101', 'LC-104', 'LC-120', 'LC-140'], 'priya.raman@example.com', false]
];

const id = async (sql, params) => (await q(sql, params)).rows[0]?.id;

async function wipeDemo() {
  // Only ever removes rows this script created: demo gear codes and the
  // @example.com people, plus whatever hangs off them.
  await tx(async c => {
    await c.query(`DELETE FROM checkouts WHERE holder_id IN
      (SELECT id FROM people WHERE email LIKE '%@example.com')`);
    await c.query(`DELETE FROM reservations WHERE person_id IN
      (SELECT id FROM people WHERE email LIKE '%@example.com')`);
    await c.query(`DELETE FROM maintenance WHERE item_id IN
      (SELECT id FROM items WHERE code LIKE 'LC-%')`);
    await c.query(`DELETE FROM checkout_items WHERE item_id IN
      (SELECT id FROM items WHERE code LIKE 'LC-%')`);
    await c.query(`DELETE FROM reservation_items WHERE item_id IN
      (SELECT id FROM items WHERE code LIKE 'LC-%')`);
    await c.query(`DELETE FROM kit_items WHERE item_id IN
      (SELECT id FROM items WHERE code LIKE 'LC-%')`);
    await c.query(`DELETE FROM kits WHERE name = ANY($1::text[])`, [KITS.map(k => k[0])]);
    await c.query(`DELETE FROM items WHERE code LIKE 'LC-%'`);
    await c.query(`DELETE FROM people WHERE email LIKE '%@example.com'`);
    // Clear claimed notification slots so the demo can send reminders again.
    await c.query(`DELETE FROM notifications`);
  });
  console.log('Cleared previous demo data.');
}

async function main() {
  await migrate();

  /* Guard: refuse to scribble demo gear over a real inventory. */
  const { rows: [{ n: realItems }] } = await q(
    `SELECT count(*)::int AS n FROM items WHERE code NOT LIKE 'LC-%'`
  );
  if (realItems > 0 && !FORCE) {
    console.error(
      `\nThis database already holds ${realItems} item(s) that this script didn't create.\n` +
      `That looks like a real inventory, so nothing was written.\n` +
      `Re-run with --force if you're certain this is the demo instance.\n`
    );
    await pool.end();
    process.exit(1);
  }

  if (RESET) await wipeDemo();

  /* ---- people ---- */
  const person = {};
  for (const [email, name] of PEOPLE) {
    person[email] = await id(
      `INSERT INTO people (email, name, role, placeholder) VALUES ($1, $2, 'member', TRUE)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [email, name]
    );
  }
  console.log(`People: ${PEOPLE.length}`);

  /* ---- gear ---- */
  const item = {};
  for (const [code, name, category, brand, model] of ITEMS) {
    item[code] = await id(
      `INSERT INTO items (code, name, category, brand, model) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name, category = EXCLUDED.category,
             brand = EXCLUDED.brand, model = EXCLUDED.model
       RETURNING id`,
      [code, name, category, brand, model]
    );
  }
  console.log(`Gear: ${ITEMS.length}`);

  /* ---- kits ---- */
  for (const [name, codes, ownerEmail, shared] of KITS) {
    const ownerId = ownerEmail ? person[ownerEmail] ?? null : null;
    await tx(async c => {
      const { rows } = await c.query('SELECT id FROM kits WHERE name = $1', [name]);
      const kitId = rows[0]?.id ?? (await c.query(
        'INSERT INTO kits (name) VALUES ($1) RETURNING id', [name]
      )).rows[0].id;
      await c.query('UPDATE kits SET owner_id = $2, shared = $3 WHERE id = $1',
        [kitId, ownerId, shared]);
      await c.query('DELETE FROM kit_items WHERE kit_id = $1', [kitId]);
      for (const code of codes) {
        await c.query(
          'INSERT INTO kit_items (kit_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [kitId, item[code]]
        );
      }
    });
  }
  console.log(`Kits: ${KITS.length}`);

  /* ---- live activity ------------------------------------------------------
     Only seeded when the board is empty, so re-running doesn't pile up
     duplicate loans. Dates are relative to today so this always looks live. */
  const { rows: [{ n: openNow }] } = await q(
    `SELECT count(*)::int AS n FROM checkouts WHERE returned_at IS NULL`
  );

  if (openNow > 0) {
    console.log('Activity: already present, left alone.');
  } else {
    // out_at / due_on offsets in days from today. A negative due_on is overdue.
    const CHECKOUTS = [
      { who: 'alex.rivera@example.com',  out: -2, due:  2, project: 'Anniversary tribute',
        codes: ['LC-101', 'LC-113', 'LC-120'] },
      { who: 'priya.raman@example.com', out: -1, due:  3, project: 'Weekend series',
        codes: ['LC-103', 'LC-110', 'LC-122'] },
      // Overdue, so the board shows red and the overdue notice has something to send.
      { who: 'marcus.webb@example.com',   out: -9, due: -3, project: 'Baptism shoot',
        codes: ['LC-130', 'LC-131', 'LC-133'] },
      // Due today, so the due-today reminder fires.
      { who: 'jo.feldman@example.com',   out: -3, due:  0, project: 'Staff headshots',
        codes: ['LC-102', 'LC-112'] }
    ];

    for (const co of CHECKOUTS) {
      await tx(async c => {
        const { rows: [row] } = await c.query(
          `INSERT INTO checkouts (holder_id, actor_id, project, out_at, due_on)
           VALUES ($1, $1, $2, CURRENT_DATE + ($3 || ' days')::interval,
                   CURRENT_DATE + ($4 || ' days')::interval)
           RETURNING id`,
          [person[co.who], co.project, String(co.out), String(co.due)]
        );
        for (const code of co.codes) {
          await c.query(
            'INSERT INTO checkout_items (checkout_id, item_id) VALUES ($1, $2)',
            [row.id, item[code]]
          );
        }
      });
    }

    // A closed loan, so the calendar has history to look back at.
    await tx(async c => {
      const { rows: [row] } = await c.query(
        `INSERT INTO checkouts (holder_id, actor_id, project, out_at, due_on, returned_at)
         VALUES ($1, $1, 'Christmas promo',
                 CURRENT_DATE - interval '16 days',
                 CURRENT_DATE - interval '11 days',
                 CURRENT_DATE - interval '12 days')
         RETURNING id`,
        [person['alex.rivera@example.com']]
      );
      for (const code of ['LC-141', 'LC-170']) {
        await c.query('INSERT INTO checkout_items (checkout_id, item_id) VALUES ($1, $2)',
          [row.id, item[code]]);
      }
    });

    const RESERVATIONS = [
      { who: 'jo.feldman@example.com',   start: 4,  end: 7,  project: 'Easter promo',
        codes: ['LC-101', 'LC-121', 'LC-140'] },
      { who: 'priya.raman@example.com', start: 9,  end: 12, project: 'Small groups series',
        codes: ['LC-104', 'LC-111', 'LC-123'] },
      // Starts today, so the pickup notice has something to send.
      { who: 'marcus.webb@example.com',   start: 0,  end: 2,  project: 'Volunteer interviews',
        codes: ['LC-142', 'LC-151'] }
    ];

    for (const r of RESERVATIONS) {
      await tx(async c => {
        const { rows: [row] } = await c.query(
          `INSERT INTO reservations (person_id, start_on, end_on, project)
           VALUES ($1, CURRENT_DATE + ($2 || ' days')::interval,
                       CURRENT_DATE + ($3 || ' days')::interval, $4)
           RETURNING id`,
          [person[r.who], String(r.start), String(r.end), r.project]
        );
        for (const code of r.codes) {
          await c.query(
            'INSERT INTO reservation_items (reservation_id, item_id) VALUES ($1, $2)',
            [row.id, item[code]]
          );
        }
      });
    }

    // Gear down for repair, so the availability rules have something to block on.
    await q(
      `INSERT INTO maintenance (item_id, kind, notes, opened_on)
       VALUES ($1, 'Repair', 'Iris ring sticking at the wide end — sent to Canon.',
               CURRENT_DATE - interval '5 days')`,
      [item['LC-114']]
    );
    await q(
      `INSERT INTO maintenance (item_id, kind, notes, opened_on)
       VALUES ($1, 'Damage', 'Dented barn door, still usable. Ordered a replacement.',
               CURRENT_DATE - interval '1 day')`,
      [item['LC-122']]
    );

    console.log(`Activity: ${CHECKOUTS.length} open checkouts (1 overdue, 1 due today), ` +
                `1 returned, ${RESERVATIONS.length} reservations, 2 repair tickets.`);
  }

  const { rows: [counts] } = await q(`
    SELECT (SELECT count(*) FROM items)  AS items,
           (SELECT count(*) FROM people) AS people,
           (SELECT count(*) FROM checkouts WHERE returned_at IS NULL) AS out,
           (SELECT count(*) FROM reservations
              WHERE cancelled_at IS NULL AND fulfilled_at IS NULL) AS held`);
  console.log(`\nDemo cage ready — ${counts.items} items, ${counts.people} people, ` +
              `${counts.out} out, ${counts.held} on hold.`);
  await pool.end();
}

main().catch(async err => {
  console.error('Seed failed:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
