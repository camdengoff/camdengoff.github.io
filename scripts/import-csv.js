#!/usr/bin/env node
/**
 * Import a Cheqroom (or any) CSV export into the items table.
 *
 *   node scripts/import-csv.js path/to/export.csv [--dry] [--no-images]
 *
 * Column names are matched loosely and case-insensitively, so most exports work
 * untouched. Rows are matched on code first, then serial, so re-running the
 * import updates rather than duplicates.
 *
 * If the export has a photo column (Cheqroom's "Image Url"), the photo itself
 * is downloaded once and stored in the row — not hot-linked — so it keeps
 * working after the Cheqroom account this is replacing is gone. A re-import
 * only re-fetches a photo when the export points somewhere new; unchanged
 * fleets don't re-download anything. Pass --no-images to skip fetching
 * entirely (useful for a fast dry run against a huge export).
 *
 * `importItems()` below is the part the Admin → Import screen also calls
 * (via src/api.js) — this file's main() is a thin CLI wrapper around it so
 * the two can't drift apart. It assumes the schema already exists and the
 * caller handles migrate(); the CLI wrapper does that, the web endpoint
 * doesn't need to (the server ran it at boot).
 */
import fs from 'node:fs';
import { q, migrate, pool } from '../src/db.js';
import { parseCsv, buildIndex, norm, cell } from './lib-csv.js';

/** Candidate header names for each column we care about, best match first. */
const MAP = {
  name:     ['name', 'itemname', 'title', 'description', 'shortdescription'],
  // "id" is last on purpose. Cheqroom exports both a human-facing "Codes"
  // column — what the barcodes and QR labels carry — and an internal 22
  // character "Id". Matching "id" first imported the internal one, which
  // looks plausible and is useless on a label.
  code:     ['code', 'codes', 'assettag', 'assetnumber', 'tag',
             'barcode', 'barcodes', 'qrcode', 'assetid', 'itemcode', 'id'],
  // "kind" after the real category names: Cheqroom uses Kind for
  // Individual/Bulk, which would fill the category column with two values.
  category: ['category', 'type', 'group', 'itemtype', 'kind'],
  brand:    ['brand', 'make', 'manufacturer', 'vendor'],
  model:    ['model', 'modelnumber', 'modelno'],
  serial:   ['serial', 'serialnumber', 'serialno', 'sn'],
  notes:    ['notes', 'note', 'comment', 'comments', 'remarks', 'location'],
  // Cheqroom's own ownership marker — FLMKR or GAT in ours. Free text, not
  // an enum, so a flag we haven't seen before still comes through.
  flag:     ['flag', 'flags', 'owner', 'ownedby', 'owningteam'],
  image:    ['imageurl', 'image', 'photo', 'photourl', 'picture', 'thumbnail']
};

/**
 * Real category columns are inconsistent in ways that create phantom
 * duplicates: "Lighting > Diffusion/Bounce" and "Lighting/Diffusion/Bounce"
 * are the same shelf, and "Camera Stabilization " has a trailing space. Left
 * alone each spelling becomes its own filter chip.
 */
export function tidyCategory(raw) {
  return String(raw || '')
    .replace(/\s*>\s*/g, '/')     // "A > B" and "A/B" mean the same thing
    .split('/')
    .map(s => s.trim())
    .filter(Boolean)
    .join('/');
}

/**
 * The top level of the path, which is what the filter chips use. Twenty-nine
 * chips is a scrollbar; eight is a filter. The full path survives in notes.
 */
export function topCategory(raw) {
  const tidy = tidyCategory(raw);
  if (!tidy) return 'Uncategorized';
  return tidy.split('/')[0];
}

/** Runs `fn` over `items` with at most `limit` in flight at once. */
async function mapLimit(items, limit, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) await fn(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Downloads one photo. Never throws — a bad URL is a problem to report, not
 *  a reason to abort 450 other rows. */
async function fetchImage(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { error: 'empty response' };
    return { data: buf, type: res.headers.get('content-type') || 'application/octet-stream' };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Parses and imports an items CSV. `dry` reports what would happen and
 * writes nothing — including no photo downloads. Returns a plain object —
 * no console output, no process.exit — so both the CLI wrapper and the web
 * endpoint can use it.
 */
export async function importItems(csvText, { dry = false, fetchImages = true, imageConcurrency = 8 } = {}) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    return { ok: false, error: 'That file has no data rows.' };
  }

  const header = rows[0];
  const idx = buildIndex(header, MAP);
  const columns = Object.keys(MAP).map(field => ({
    field,
    header: idx[field] !== undefined ? header[idx[field]] : null
  }));
  if (idx.name === undefined) {
    return { ok: false, error: 'No name column found. Rename a column to "Name" and try again.', columns };
  }

  const pick = (row, field) => cell(row, idx, field);
  let created = 0, updated = 0, skipped = 0, auto = 0;
  const seen = new Set();
  const preview = [];
  const problems = [];

  // Highest existing numeric code, so generated codes don't collide.
  let nextNum = 100;
  const { rows: [r] } = await q(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(code, '\\D', '', 'g'), '')::bigint), 100) AS n FROM items`
  );
  nextNum = Number(r.n);

  // Existing items, preloaded once rather than a query per row. The table is
  // a few hundred rows, not millions, and having it all in memory is what
  // lets the photo downloads below run several at a time instead of one
  // painfully sequential fetch per row.
  const byCode = new Map(), bySerial = new Map();
  if (!dry) {
    const { rows: existing } = await q('SELECT id, code, serial, image_source FROM items');
    for (const it of existing) {
      byCode.set(norm(it.code), it);
      if (it.serial) bySerial.set(norm(it.serial), it);
    }
  }
  const findExisting = record =>
    byCode.get(norm(record.code)) ?? (record.serial ? bySerial.get(norm(record.serial)) : undefined);

  const records = [];
  for (const row of rows.slice(1)) {
    const name = pick(row, 'name');
    if (!name) { skipped++; continue; }

    let code = pick(row, 'code').toUpperCase();
    if (!code) { code = 'LC-' + (++nextNum); auto++; }
    if (seen.has(code)) { code = 'LC-' + (++nextNum); auto++; }
    seen.add(code);

    const rawCategory = pick(row, 'category');
    records.push({
      code,
      name,
      category: topCategory(rawCategory),
      brand: pick(row, 'brand'),
      model: pick(row, 'model'),
      serial: pick(row, 'serial'),
      // Keep the full path — flattening is for the filter chips, not a reason
      // to throw the detail away.
      notes: [tidyCategory(rawCategory), pick(row, 'notes')].filter(Boolean).join(' · '),
      flag: pick(row, 'flag').toUpperCase(),
      imageUrl: pick(row, 'image')
    });
  }

  if (dry) {
    return {
      ok: true, columns, created: records.length, updated: 0, skipped, auto, dry,
      imagesFound: records.filter(rec => rec.imageUrl).length,
      preview: records.slice(0, 50)
    };
  }

  // Only fetch a photo when there's a URL and it's either a brand new item or
  // the export points somewhere new — a re-import of an unchanged fleet
  // should not re-download 450 photos that haven't moved.
  const toFetch = fetchImages
    ? records.filter(rec => rec.imageUrl && findExisting(rec)?.image_source !== rec.imageUrl)
    : [];
  const fetched = new Map(); // url -> { data, type } | { error }
  await mapLimit(toFetch, imageConcurrency, async rec => {
    if (fetched.has(rec.imageUrl)) return; // two rows sharing one photo URL
    fetched.set(rec.imageUrl, await fetchImage(rec.imageUrl));
  });
  for (const [url, result] of fetched) {
    if (result.error) problems.push(`image ${url}: ${result.error}`);
  }

  for (const record of records) {
    const found = findExisting(record);
    const image = record.imageUrl ? fetched.get(record.imageUrl) : null;
    const hasNewImage = Boolean(image && !image.error);

    if (found) {
      const base = `UPDATE items SET name=$2, category=$3, brand=$4, model=$5, serial=$6,
           notes = CASE WHEN $7 = '' THEN notes ELSE $7 END,
           flag = CASE WHEN $8 = '' THEN flag ELSE $8 END`;
      const params = [found.id, record.name, record.category, record.brand, record.model, record.serial, record.notes, record.flag];
      // image_version bump matters here in a way it doesn't for a brand-new
      // row below: a browser may already have this item's old photo cached
      // "forever" (see api.js's photo routes), and that cache is only ever
      // invalidated by the URL itself changing.
      await q(
        hasNewImage
          ? `${base}, image_data=$9, image_type=$10, image_source=$11, image_version=image_version+1 WHERE id=$1`
          : `${base} WHERE id=$1`,
        hasNewImage ? [...params, image.data, image.type, record.imageUrl] : params
      );
      updated++;
    } else {
      const params = [record.code, record.name, record.category, record.brand, record.model, record.serial, record.notes, record.flag];
      await q(
        hasNewImage
          ? `INSERT INTO items (code, name, category, brand, model, serial, notes, flag, image_data, image_type, image_source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`
          : `INSERT INTO items (code, name, category, brand, model, serial, notes, flag)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        hasNewImage ? [...params, image.data, image.type, record.imageUrl] : params
      );
      created++;
      preview.push(record);
    }
  }

  const fetchResults = [...fetched.values()];
  return {
    ok: true, columns, created, updated, skipped, auto, dry,
    imagesFetched: fetchResults.filter(v => !v.error).length,
    imagesFailed: fetchResults.filter(v => v.error).length,
    problems,
    preview: preview.slice(0, 50)
  };
}

async function main() {
  const file = process.argv[2];
  const dry = process.argv.includes('--dry');
  const fetchImages = !process.argv.includes('--no-images');
  if (!file) {
    console.error('Usage: node scripts/import-csv.js <file.csv> [--dry] [--no-images]');
    process.exit(1);
  }

  const csvText = fs.readFileSync(file, 'utf8');
  if (!dry) await migrate();

  if (!dry && fetchImages) console.log('Importing gear and fetching any new photos — this can take a minute…\n');

  const result = await importItems(csvText, { dry, fetchImages });
  if (!result.ok) {
    console.error(`\n${result.error}`);
    process.exit(1);
  }

  console.log('Columns detected:');
  for (const c of result.columns) {
    console.log(`  ${c.field.padEnd(9)} ${c.header ? `← "${c.header}"` : '— not found'}`);
  }

  console.log(`\n${dry ? 'Would import' : 'Imported'}: ${result.created} new, ${result.updated} updated, ${result.skipped} skipped (no name).`);
  if (result.auto) console.log(`${result.auto} row(s) had no usable code — generated one. Print fresh labels for those.`);
  if (dry) {
    if (result.imagesFound) console.log(`${result.imagesFound} row(s) have a photo — fetched on a real run, skipped here.`);
    for (const record of result.preview) {
      console.log(`  ${record.code.padEnd(10)} ${record.name}${record.flag ? ` [${record.flag}]` : ''}`);
    }
    console.log('Dry run — nothing was written. Drop --dry to commit.');
  } else {
    if (result.imagesFetched) console.log(`Fetched ${result.imagesFetched} new or changed photo(s).`);
    if (result.imagesFailed) console.log(`${result.imagesFailed} photo(s) failed to download — see below. The item still imported.`);
    if (result.problems.length) {
      console.log(`\nIssues (${result.problems.length}):`);
      result.problems.slice(0, 40).forEach(p => console.log(`  - ${p}`));
      if (result.problems.length > 40) console.log(`  … and ${result.problems.length - 40} more`);
    }
  }
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
