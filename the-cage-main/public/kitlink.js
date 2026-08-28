/**
 * Kits as links you can text someone.
 *
 * The whole kit travels *in* the URL rather than as a pointer to a row. Two
 * reasons, both learned the hard way elsewhere:
 *
 * - **Item ids are per-database.** A link built as `#kit/12` on one instance
 *   resolves to whatever happens to be row 12 on another — not an error, just
 *   the wrong gear, which is worse. Codes are what's printed on the case and
 *   they're identical anywhere the inventory came from the same export.
 * - **The single-file build has no server.** Nothing can be looked up. A
 *   self-contained link works there, against a deployed instance, and between
 *   the two.
 *
 * The cost is that a link is a snapshot: edit your kit afterwards and a link
 * already sent still carries the old contents. That's the right trade for
 * something sent over SMS — the alternative is a link that silently changes
 * under the person you sent it to.
 *
 * Pure and dependency-free so it can be tested without a browser.
 */

export const KIT_LINK_VERSION = 1;

/* A kit far past this isn't a kit, it's someone's whole inventory, and the
   URL stops being textable long before. Rejected rather than truncated: half
   a gear list is worse than a clear refusal. */
export const MAX_KIT_LINK_ITEMS = 120;

const enc = new TextEncoder();
const dec = new TextDecoder();

/* base64url — '+' and '/' get mangled by URLs and by some messaging apps that
   helpfully "fix" links, and '=' padding trips up hash parsing. */
function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Encode a kit for sharing.
 * @param {{name:string, notes?:string}} kit
 * @param {string[]} codes   item codes, in order
 * @param {string} [from]    who's sharing, for the "Alex shared…" line
 * @returns {string} the payload, ready to sit after `#kit=`
 */
export function encodeKit(kit, codes, from = '') {
  const list = [...new Set((codes || []).map(c => String(c).trim()).filter(Boolean))];
  if (!list.length) throw new Error('A kit with no gear in it has nothing to share.');
  if (list.length > MAX_KIT_LINK_ITEMS) {
    throw new Error(`Too much gear to fit in a link (${list.length}, limit ${MAX_KIT_LINK_ITEMS}).`);
  }
  /* Short keys because this ends up in a text message. v is first so a future
     format can be told apart before anything else is trusted. */
  const payload = { v: KIT_LINK_VERSION, n: String(kit.name || 'Kit'), c: list };
  if (kit.notes) payload.t = String(kit.notes);
  if (from) payload.f = String(from);
  return toBase64Url(enc.encode(JSON.stringify(payload)));
}

/**
 * Decode a payload back to a kit. Returns null for anything that isn't a
 * well-formed link of a version we understand — this is untrusted input
 * arriving from a text message, so it either parses cleanly or it's ignored.
 */
export function decodeKit(payload) {
  if (typeof payload !== 'string' || !payload) return null;
  let obj;
  try {
    obj = JSON.parse(dec.decode(fromBase64Url(payload)));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  if (obj.v !== KIT_LINK_VERSION) return null;
  if (typeof obj.n !== 'string' || !obj.n.trim()) return null;
  if (!Array.isArray(obj.c)) return null;

  const codes = obj.c
    .filter(c => typeof c === 'string' || typeof c === 'number')
    .map(c => String(c).trim())
    .filter(Boolean)
    .slice(0, MAX_KIT_LINK_ITEMS);
  if (!codes.length) return null;

  return {
    name: obj.n.trim(),
    notes: typeof obj.t === 'string' ? obj.t : '',
    from: typeof obj.f === 'string' ? obj.f : '',
    codes
  };
}

/**
 * First free name in the "X", "X 2", "X 3" sequence, for prefilling the save
 * box. Saving the same link twice should leave two kits you can tell apart.
 */
export function uniqueKitName(base, existingNames = []) {
  const clean = String(base || 'Kit').trim() || 'Kit';
  if (!existingNames.includes(clean)) return clean;
  let n = 2;
  while (existingNames.includes(`${clean} ${n}`)) n++;
  return `${clean} ${n}`;
}

/** Pull the payload out of a full URL or a bare hash. */
export function kitPayloadFromHash(hash) {
  if (typeof hash !== 'string') return null;
  const m = /[#&]kit=([A-Za-z0-9\-_]+)/.exec(hash);
  return m ? m[1] : null;
}

/** Build the link to send. `base` is the app URL, hash and query stripped. */
export function kitShareUrl(base, kit, codes, from = '') {
  const clean = String(base || '').split('#')[0];
  return `${clean}#kit=${encodeKit(kit, codes, from)}`;
}

/**
 * Match a decoded kit against the recipient's inventory.
 *
 * Codes are compared case- and space-insensitively because they get retyped.
 * Anything unmatched is reported rather than dropped: "6 of 8 items" tells you
 * to go find the other two, silently saving 6 does not.
 */
export function resolveKit(shared, items = []) {
  const byCode = new Map();
  for (const it of items) {
    const key = String(it.code || '').trim().toLowerCase();
    if (key && !byCode.has(key)) byCode.set(key, it);
  }
  const found = [];
  const missing = [];
  for (const code of shared.codes) {
    const hit = byCode.get(code.trim().toLowerCase());
    if (hit) found.push(hit); else missing.push(code);
  }
  return { name: shared.name, notes: shared.notes, from: shared.from, found, missing };
}
