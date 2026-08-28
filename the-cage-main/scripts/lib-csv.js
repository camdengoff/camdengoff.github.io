/**
 * CSV reading and fuzzy column matching, shared by the importers.
 *
 * Exports from different systems name their columns differently and there's no
 * point demanding an exact format from someone who just wants their gear moved
 * over. Matching is loose and case-insensitive; whatever it resolves gets
 * printed so a human can sanity check it before anything is written.
 */

/**
 * Work out what separates the fields by counting candidates in the header,
 * outside quotes. Cheqroom exports semicolons, Excel exports semicolons in
 * much of Europe, and a comma-only parser reads either as one enormous
 * column \u2014 which looks like a mangled file rather than a wrong delimiter.
 */
export function sniffDelimiter(text) {
  const clean = text.replace(/^\uFEFF/, '');
  const end = clean.search(/\r|\n/);
  const header = end === -1 ? clean : clean.slice(0, end);

  let best = ',', bestCount = 0;
  for (const d of [',', ';', '\t', '|']) {
    let count = 0, inQuotes = false;
    for (let i = 0; i < header.length; i++) {
      const c = header[i];
      if (c === '"') inQuotes = !inQuotes;
      else if (c === d && !inQuotes) count++;
    }
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

/**
 * Handles quoted fields, escaped quotes, CRLF, trailing newlines, and
 * newlines *inside* quoted fields \u2014 Cheqroom puts whole paragraphs in the
 * description column.
 *
 * The delimiter is sniffed unless one is passed.
 */
export function parseCsv(text, delimiter = null) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const clean = text.replace(/^\uFEFF/, ''); // strip a BOM if Excel added one
  const d = delimiter || sniffDelimiter(clean);

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === d) {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(v => v.trim() !== '')) rows.push(row);
  return rows;
}

export const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Resolve a header row against a spec of { field: [candidate, ...] }.
 * Candidates are tried in order, so put the most specific first.
 * Falls back to a substring match, which catches things like
 * "Item name (English)".
 */
export function buildIndex(header, spec) {
  const cols = header.map(norm);
  const idx = {};
  const taken = new Set();

  for (const [field, candidates] of Object.entries(spec)) {
    for (const cand of candidates) {
      const at = cols.findIndex((c, i) => c === cand && !taken.has(i));
      if (at !== -1) { idx[field] = at; taken.add(at); break; }
    }
  }
  // Second pass: substring match for anything still unresolved.
  for (const [field, candidates] of Object.entries(spec)) {
    if (idx[field] !== undefined) continue;
    for (const cand of candidates) {
      const at = cols.findIndex((c, i) => c.includes(cand) && !taken.has(i));
      if (at !== -1) { idx[field] = at; taken.add(at); break; }
    }
  }
  return idx;
}

/**
 * Same resolution `reportIndex` prints, as data — for callers (the web import
 * endpoints) that show it in a UI instead of a terminal. `reportIndex` is a
 * thin wrapper around this so the CLI scripts' output doesn't change.
 */
export function describeColumns(header, spec, idx, required = []) {
  const columns = Object.keys(spec).map(field => ({
    field,
    header: idx[field] !== undefined ? header[idx[field]] : null,
    required: required.includes(field)
  }));
  const missing = required.filter(f => idx[f] === undefined);
  return { columns, missing };
}

export function reportIndex(header, spec, idx, required = []) {
  const { columns, missing } = describeColumns(header, spec, idx, required);
  console.log('Columns detected:');
  const width = Math.max(...Object.keys(spec).map(k => k.length));
  for (const c of columns) {
    const flag = !c.header && c.required ? '  ** REQUIRED **' : '';
    console.log(`  ${c.field.padEnd(width)}  ${c.header ? `← "${c.header}"` : '— not found'}${flag}`);
  }
  return missing;
}

/** Read a cell as a trimmed string. */
export const cell = (row, idx, field) =>
  (idx[field] !== undefined ? String(row[idx[field]] ?? '').trim() : '');

/**
 * Normalise the many date shapes exports produce into YYYY-MM-DD.
 * Ambiguous numeric formats are read day-first only when the first part
 * can't be a month, because guessing wrong silently is worse than failing.
 */
export function toDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  /* Some Cheqroom exports mangle a date into "YYYY-MM-MM/DD/YY HH:MM:SS" —
     the day slot in the ISO-looking prefix is always just the month
     repeated (verified against 10,000+ rows of a real export: zero
     exceptions), and the real day lives after the first slash. Checked
     before the plain ISO regex below, which would otherwise match the
     corrupted prefix and silently return the wrong day every time the real
     day differs from the month — e.g. "2026-10-10/06/26 10:30:00" is
     actually October 6th, not the 10th. */
  let m = s.match(/^(\d{4})-(\d{2})-\2\/(\d{2})\/\d{2}(?:[ T]|$)/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);            // ISO
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})/);     // M/D/Y or D/M/Y
  if (m) {
    let [, a, b, y] = m;
    if (y.length === 2) y = '20' + y;
    let month = Number(a), day = Number(b);
    if (month > 12) { month = Number(b); day = Number(a); } // must be day-first
    if (month > 12 || day > 31) return null;
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  const parsed = new Date(s);                              // "12 Aug 2026", etc.
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}
