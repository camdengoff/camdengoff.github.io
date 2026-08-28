#!/usr/bin/env node
/**
 * Import physical kits — a case that already holds a fixed set of individual
 * items, e.g. Cheqroom's "kits" export — into the existing kits/kit_items
 * tables. This creates ordinary kits, the same ones the Kits tab already
 * builds and edits by hand; nothing new is added to the schema.
 *
 *   node scripts/import-kits.js path/to/kits.csv             # dry run
 *   node scripts/import-kits.js path/to/kits.csv --write      # actually writes
 *
 * Unlike import-csv.js and import-orders.js, this one is dry-run BY DEFAULT
 * and needs --write to touch the database. Kit/item cross-references are
 * harder to eyeball-verify after the fact than a plain item or order row —
 * a wrong item in a kit doesn't show up until someone checks that kit out —
 * so the extra friction here is deliberate.
 *
 * Matching, most reliable first (same priority import-orders.js uses for
 * order line items):
 *   1. code   — CSV "item codes" (or Codes/Asset Tag/Barcode/Tag). What's
 *      physically printed on the unit, so it's the most trustworthy.
 *   2. serial — CSV "item Serial number". Used only when code is blank or
 *      doesn't match anything in the library.
 *   Name is deliberately NOT used as a fallback match on its own — this
 *   export repeats item names across distinct physical units (three
 *   identical monitors, two identical cameras in the sample kits file), so
 *   matching by name alone would confidently pick the wrong unit. A line
 *   that only has a name, or whose code/serial doesn't match, is reported as
 *   unmatched rather than guessed.
 *
 * Rows come one per (kit, item) pair — Cheqroom's export shape — and are
 * grouped back into one kit each by the "name" column.
 *
 * Idempotent by kit name: re-running replaces an existing *ownerless* kit's
 * item list when the (normalised) name matches, rather than creating a
 * duplicate. A same-named kit that already has a personal owner is left
 * alone and reported instead — someone's personal kit sharing a name with
 * an import is much more likely a coincidence than the same row.
 */
import fs from 'node:fs';
import { q, tx, migrate, pool } from '../src/db.js';
import { parseCsv, buildIndex, describeColumns, cell, norm } from './lib-csv.js';

const argv = process.argv.slice(2);
const FILE = argv.find(a => !a.startsWith('--'));
const WRITE = argv.includes('--write');

/* Candidate column names, most specific first. Both a kit-level "codes" and
   an item-level "item codes" column exist in the same file — the itemCode
   candidates below are all "item …" variants on purpose, so this never
   accidentally binds to the kit's own code column instead. */
const MAP = {
  kitName:    ['name'],
  itemCode:   ['itemcodes', 'itembarcodes', 'itemassettag', 'itemtag', 'itemqrcode', 'itemcode'],
  itemSerial: ['itemserialnumber', 'itemserial', 'itemsn'],
  itemName:   ['itemname'],
  itemBrand:  ['itembrand'],
  itemModel:  ['itemmodel']
};
const REQUIRED = ['kitName', 'itemName'];

/**
 * Parses and imports a physical-kits CSV. `dry` reports what would happen
 * and writes nothing. Returns a plain object — no console output, no
 * process.exit — so this can also be called from an admin screen later the
 * same way import-csv.js and import-orders.js already are.
 */
export async function importKits(csvText, { dry = true } = {}) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return { ok: false, error: 'That file has no data rows.' };

  const header = rows[0];
  const idx = buildIndex(header, MAP);
  const { columns, missing } = describeColumns(header, MAP, idx, REQUIRED);
  if (missing.length) {
    return {
      ok: false,
      error: `Cannot continue without: ${missing.join(', ')}. Rename a column and try again.`,
      columns
    };
  }
  const pick = (row, field) => cell(row, idx, field);

  /* Existing gear, indexed once. byName only ever holds a usable value when
     exactly one item has that name — a second item with the same name turns
     the entry into the string 'AMBIGUOUS' rather than silently overwriting
     the first, so an ambiguous name is told apart from no match at all. */
  const { rows: items } = await q('SELECT id, code, name, serial, retired FROM items');
  const byCode = new Map(), bySerial = new Map(), byName = new Map();
  for (const it of items) {
    if (it.code) byCode.set(norm(it.code), it);
    if (it.serial) bySerial.set(norm(it.serial), it);
    if (it.name) {
      const key = norm(it.name);
      byName.set(key, byName.has(key) ? 'AMBIGUOUS' : it);
    }
  }

  /* ---- group rows into one kit each ----------------------------------- */
  const groups = new Map();
  let lineNo = 1;
  const problems = [];
  for (const row of rows.slice(1)) {
    lineNo++;
    const kitName = pick(row, 'kitName');
    if (!kitName) { problems.push(`line ${lineNo}: no kit name, row skipped`); continue; }
    if (!groups.has(kitName)) groups.set(kitName, []);
    groups.get(kitName).push({
      lineNo,
      code: pick(row, 'itemCode'),
      serial: pick(row, 'itemSerial'),
      name: pick(row, 'itemName'),
      brand: pick(row, 'itemBrand'),
      model: pick(row, 'itemModel')
    });
  }

  /* ---- resolve each kit's lines to item ids ---------------------------- */
  const ready = [];
  const unmatchedLines = [];

  for (const [kitName, lines] of groups) {
    const itemIds = [];
    for (const line of lines) {
      const hit =
        (line.code   ? byCode.get(norm(line.code))     : null) ??
        (line.serial ? bySerial.get(norm(line.serial)) : null) ??
        null;

      if (hit) {
        if (hit.retired) {
          problems.push(`"${kitName}": ${line.name || hit.name} (${line.code || line.serial}) is retired — kept in the kit anyway, same as a hand-built kit would.`);
        }
        // A code/serial match with a wildly different name is worth a second
        // look even though it isn't blocked — a typo'd asset tag two units
        // apart would otherwise import silently wrong.
        if (line.name && norm(hit.name) !== norm(line.name)) {
          problems.push(`"${kitName}": matched "${line.code || line.serial}" to library item "${hit.name}", but the CSV calls it "${line.name}" — worth checking.`);
        }
        if (!itemIds.includes(hit.id)) itemIds.push(hit.id);
        continue;
      }

      const byNameHit = line.name ? byName.get(norm(line.name)) : null;
      unmatchedLines.push({
        kit: kitName,
        name: line.name || '(no name)',
        code: line.code || '',
        serial: line.serial || '',
        reason: byNameHit === 'AMBIGUOUS'
          ? 'no code/serial match, and the name alone matches more than one item in the library'
          : (line.code || line.serial)
            ? 'no item in the library has that code or serial'
            : 'row has no code or serial to match on'
      });
    }

    if (!itemIds.length) {
      problems.push(`"${kitName}": none of its ${lines.length} row(s) matched — kit not imported.`);
      continue;
    }
    ready.push({ name: kitName, itemIds, matched: itemIds.length, total: lines.length });
  }

  /* ---- decide create vs. update vs. leave-alone ------------------------ */
  const { rows: existingKits } = await q('SELECT id, name, owner_id FROM kits');
  const existingByName = new Map(existingKits.map(k => [norm(k.name), k]));

  const toCreate = [], toUpdate = [], collisions = [];
  for (const r of ready) {
    const clash = existingByName.get(norm(r.name));
    if (clash && clash.owner_id != null) {
      collisions.push({ name: r.name, existingId: clash.id });
      continue;
    }
    if (clash) toUpdate.push({ ...r, existingId: clash.id });
    else toCreate.push(r);
  }

  const summary = {
    ok: true,
    columns,
    kitCount: groups.size,
    rowCount: rows.length - 1,
    toCreate: toCreate.map(r => ({ name: r.name, items: r.matched, ofTotal: r.total })),
    toUpdate: toUpdate.map(r => ({ name: r.name, existingId: r.existingId, items: r.matched, ofTotal: r.total })),
    collisions,
    unmatchedLines,
    problems
  };

  if (dry) return { ...summary, dry: true };

  /* ---- write ------------------------------------------------------------ */
  let created = 0, updated = 0;
  for (const r of toCreate) {
    await tx(async client => {
      // type is explicit rather than left to the column default — this is
      // the one place a *physical* kit gets created, and that shouldn't
      // depend on the default staying whatever it happens to be today.
      const { rows: [k] } = await client.query(
        `INSERT INTO kits (name, type) VALUES ($1, 'kit') RETURNING id`, [r.name]
      );
      for (const itemId of r.itemIds) {
        await client.query(
          'INSERT INTO kit_items (kit_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [k.id, itemId]
        );
      }
    });
    created++;
  }
  for (const r of toUpdate) {
    await tx(async client => {
      // Belt and suspenders with the one-time migration backfill: a kit
      // this importer is willing to update is definitionally physical,
      // whatever it was tagged before.
      await client.query(`UPDATE kits SET type = 'kit' WHERE id = $1`, [r.existingId]);
      // Replace wholesale rather than diff — a kit import reflects "this is
      // what's in the case now", the same as re-running import-csv.js
      // reflects the current export rather than patching field by field.
      await client.query('DELETE FROM kit_items WHERE kit_id = $1', [r.existingId]);
      for (const itemId of r.itemIds) {
        await client.query(
          'INSERT INTO kit_items (kit_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [r.existingId, itemId]
        );
      }
    });
    updated++;
  }

  return { ...summary, dry: false, created, updated };
}

/* ---------------------------------------------------------------------- cli */

async function main() {
  if (!FILE) {
    console.error(`Usage: node scripts/import-kits.js <file.csv> [--write]

  (no flag)   dry run — report only, write nothing (the default, deliberately)
  --write     actually create/update kits in the database`);
    process.exit(1);
  }

  const csvText = fs.readFileSync(FILE, 'utf8');
  await migrate();
  console.log('');

  const result = await importKits(csvText, { dry: !WRITE });

  if (!result.ok) {
    if (result.columns) {
      console.log('Columns detected:');
      const width = Math.max(...result.columns.map(c => c.field.length));
      for (const c of result.columns) {
        const flag = !c.header && REQUIRED.includes(c.field) ? '  ** REQUIRED **' : '';
        console.log(`  ${c.field.padEnd(width)}  ${c.header ? `← "${c.header}"` : '— not found'}${flag}`);
      }
      console.log('');
    }
    console.error(result.error);
    await pool.end();
    process.exit(1);
  }

  console.log('Columns detected:');
  const width = Math.max(...result.columns.map(c => c.field.length));
  for (const c of result.columns) {
    console.log(`  ${c.field.padEnd(width)}  ${c.header ? `← "${c.header}"` : '— not found'}`);
  }

  console.log(`\nFound ${result.kitCount} kit(s) across ${result.rowCount} row(s).`);
  console.log(`Would create: ${result.toCreate.length}    Would update: ${result.toUpdate.length}    Left alone (name collision with a personal kit): ${result.collisions.length}`);

  if (result.toCreate.length) {
    console.log(`\nNew kits:`);
    result.toCreate.forEach(k => console.log(`  ${k.name.padEnd(40)} ${k.items}/${k.ofTotal} item(s) matched`));
  }
  if (result.toUpdate.length) {
    console.log(`\nExisting ownerless kits whose item list would be replaced:`);
    result.toUpdate.forEach(k => console.log(`  ${k.name.padEnd(40)} kit #${k.existingId} — ${k.items}/${k.ofTotal} item(s) matched`));
  }
  if (result.collisions.length) {
    console.log(`\nSkipped — a personal kit already has this exact name (not touched):`);
    result.collisions.forEach(c => console.log(`  ${c.name} ↔ existing kit #${c.existingId}`));
  }
  if (result.problems.length) {
    console.log(`\nWorth a look (${result.problems.length}):`);
    result.problems.forEach(p => console.log(`  - ${p}`));
  }
  if (result.unmatchedLines.length) {
    console.log(`\nUnmatched rows (${result.unmatchedLines.length}) — not guessed, not imported:`);
    result.unmatchedLines.forEach(u =>
      console.log(`  [${u.kit}] ${u.name}${u.code ? ` code=${u.code}` : ''}${u.serial ? ` serial=${u.serial}` : ''} — ${u.reason}`));
  }

  if (result.dry) {
    console.log(`\nDry run — nothing written. Re-run with --write once this looks right.`);
    await pool.end();
    return;
  }

  console.log(`\nCreated ${result.created} kit(s), updated ${result.updated}.`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
