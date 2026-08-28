#!/usr/bin/env node
/**
 * Put simulated crew and bookings on top of whatever inventory is already
 * there.
 *
 *   npm run seed:activity            # add it
 *   npm run seed:activity -- --reset # clear simulated activity first
 *
 * `npm run seed` invents its own gear and refuses to run against a real
 * inventory, which is right — but it leaves you with 459 real items and an
 * empty board after an import, and an empty board tells you nothing about
 * whether anything works.
 *
 * This touches no items. It adds people (@example.com, marked placeholder)
 * and the checkouts, holds and repair tickets they'd have, using the same
 * generator as the single-file demo, so both look the same.
 *
 * DEMO DATA. Don't run it against the instance holding real bookings.
 */
import { q, tx, migrate, pool } from '../src/db.js';
import { simulateActivity } from '../public/demo-activity.js';
import { localToday } from '../src/reminders.js';

const RESET = process.argv.includes('--reset');
const FORCE = process.argv.includes('--force');

async function clearSimulated() {
  await tx(async c => {
    await c.query(`DELETE FROM checkouts WHERE holder_id IN
      (SELECT id FROM people WHERE email LIKE '%@example.com')`);
    await c.query(`DELETE FROM reservations WHERE person_id IN
      (SELECT id FROM people WHERE email LIKE '%@example.com')`);
    await c.query(`DELETE FROM maintenance WHERE opened_by IN
      (SELECT id FROM people WHERE email LIKE '%@example.com')
       OR notes LIKE '%[simulated]%'`);
    await c.query(`DELETE FROM audit WHERE person_id IN
      (SELECT id FROM people WHERE email LIKE '%@example.com')`);
    await c.query(`DELETE FROM people WHERE email LIKE '%@example.com'`);
    await c.query(`DELETE FROM notifications`);
  });
  console.log('Cleared previous simulated activity.');
}

async function main() {
  await migrate();

  const { rows: items } = await q(
    `SELECT id, code, name, category, brand, model FROM items WHERE retired = FALSE ORDER BY id`
  );
  if (!items.length) {
    console.error('\nNo inventory. Import gear first, or use `npm run seed` for a demo cage.\n');
    await pool.end();
    process.exit(1);
  }

  const { rows: [{ n: realBookings }] } = await q(`
    SELECT count(*)::int AS n FROM checkouts c
    JOIN people p ON p.id = c.holder_id
    WHERE p.email NOT LIKE '%@example.com'
  `);
  if (realBookings > 0 && !FORCE) {
    console.error(
      `\nThere are ${realBookings} checkout(s) here from people who aren't simulated.\n` +
      `That looks like real usage, so nothing was written. Use --force if you're sure.\n`
    );
    await pool.end();
    process.exit(1);
  }

  if (RESET) await clearSimulated();

  const today = localToday();
  const sim = simulateActivity({ items, today });

  // People. The demo admin isn't wanted here — the real app has real admins.
  const idFor = {};
  for (const p of sim.people.filter(x => x.email.endsWith('@example.com'))) {
    const { rows: [row] } = await q(
      `INSERT INTO people (email, name, role, placeholder) VALUES ($1, $2, 'member', TRUE)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [p.email, p.name]
    );
    idFor[p.id] = row.id;
  }

  const mapPerson = simId => idFor[simId] ?? Object.values(idFor)[0];

  let outCount = 0;
  for (const c of sim.checkouts) {
    if (!c.item_ids.length) continue;
    await tx(async client => {
      const { rows: [row] } = await client.query(
        `INSERT INTO checkouts (holder_id, actor_id, project, out_at, due_on, returned_at)
         VALUES ($1, $1, $2, $3::date, $4::date, $5) RETURNING id`,
        [mapPerson(c.holder_id), c.project, c.out_at, c.due_on, c.returned_at]
      );
      for (const itemId of c.item_ids) {
        await client.query(
          'INSERT INTO checkout_items (checkout_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [row.id, itemId]
        );
      }
    });
    outCount++;
  }

  let holdCount = 0;
  for (const r of sim.reservations) {
    if (!r.item_ids.length) continue;
    await tx(async client => {
      const { rows: [row] } = await client.query(
        `INSERT INTO reservations (person_id, start_on, end_on, project)
         VALUES ($1, $2::date, $3::date, $4) RETURNING id`,
        [mapPerson(r.person_id), r.start_on, r.end_on, r.project]
      );
      for (const itemId of r.item_ids) {
        await client.query(
          'INSERT INTO reservation_items (reservation_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [row.id, itemId]
        );
      }
    });
    holdCount++;
  }

  for (const m of sim.maintenance) {
    await q(
      `INSERT INTO maintenance (item_id, kind, notes, opened_on, closed_on, opened_by)
       VALUES ($1, $2, $3, $4::date, $5::date, $6)`,
      [m.item_id, m.kind, `${m.notes} [simulated]`, m.opened_on, m.closed_on, mapPerson(2)]
    );
  }

  for (const k of sim.kits) {
    await tx(async client => {
      const { rows } = await client.query('SELECT id FROM kits WHERE name = $1', [k.name]);
      const kitId = rows[0]?.id ?? (await client.query(
        'INSERT INTO kits (name) VALUES ($1) RETURNING id', [k.name])).rows[0].id;
      await client.query('DELETE FROM kit_items WHERE kit_id = $1', [kitId]);
      for (const itemId of k.item_ids) {
        await client.query(
          'INSERT INTO kit_items (kit_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [kitId, itemId]);
      }
    });
  }

  const { rows: [counts] } = await q(`
    SELECT (SELECT count(*) FROM checkouts WHERE returned_at IS NULL) AS out,
           (SELECT count(*) FROM checkouts WHERE returned_at IS NULL AND due_on < $1::date) AS late,
           (SELECT count(*) FROM reservations WHERE cancelled_at IS NULL AND fulfilled_at IS NULL) AS held,
           (SELECT count(*) FROM maintenance WHERE closed_on IS NULL) AS down`, [today]);

  console.log(`
Simulated activity added against ${items.length} real items:
  ${Object.keys(idFor).length} crew (@example.com, marked placeholder)
  ${outCount} checkouts (${counts.out} still open, ${counts.late} overdue)
  ${holdCount} holds  ·  ${counts.down} items down for repair
  ${sim.kits.length} kits

Clear it later with: npm run seed:activity -- --reset
`);
  await pool.end();
}

main().catch(async err => {
  console.error('Failed:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
