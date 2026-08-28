/* The Cage — client. Talks to /api, renders six tabs plus admin. */

import {
  renderBoard, renderCheckoutBoard, renderAgenda, renderPicker, bookingsFromState,
  firstOpening, collisions, dayList, shift as shiftDate, daysBetween, itemSchedule,
  dailyLoad, itemsInGroups, bookingLabel
} from './calendar.js';
import {
  searchItems, searchKits, searchReservations, swapCandidates, normalize
} from './search.js';
import { iconFor, gearVisual, kitVisual, initials } from './icons.js';
import { categoryBreakdown, segments, SEGMENT_ORDER } from './breakdown.js';
import {
  emptyCart, loadCart, saveCart, addToCart, removeFromCart, cartHas, cartCount, pruneCart, setCartKit,
  addSwappedOut
} from './cart.js';
import {
  kitShareUrl, kitPayloadFromHash, decodeKit, resolveKit, uniqueKitName
} from './kitlink.js';
import {
  parseDayQuery, addMonths, startOfMonth, daysInMonth, monthLabel
} from './dateparse.js';

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

const readFileAsText = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error || new Error('Could not read that file.'));
  reader.readAsText(file);
});

/* ------------------------------------------------------------------ photos */

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
/* 'item' -> /api/items, 'kit' -> /api/kits, 'person' -> /api/people. Not a
   blind "+s" because person/people is the one that isn't. */
const photoPath = kind => (kind === 'person' ? 'people' : `${kind}s`);

/** A person's photo (round), or their initials on the same muted background
    every other placeholder uses. Self-contained — unlike gearVisual/
    kitVisual, this returns the whole wrapped element, since its call sites
    (an admin list row, a detail header, the edit form's preview) don't
    already have their own wrapping convention the way gear rows do. */
function personAvatar(p, { large = false } = {}) {
  const inner = p?.has_image
    ? `<img src="/api/people/${p.id}/image?v=${p.image_v || 0}" alt="" loading="lazy">`
    : esc(initials(p?.name || p?.email));
  return `<span class="avatar${large ? ' large' : ''}">${inner}</span>`;
}

/** gearVisual/kitVisual return their inner content only, expecting the
    caller to wrap it — every existing call site already does, with a class
    that sometimes carries status colour too. The photo field needs the same
    wrapping without a status to carry. A person's own photo goes through
    personAvatar() instead, which already wraps itself. */
const photoWrapper = (kind, innerHtml) =>
  `<span class="${kind === 'item' ? 'gear-i' : 'kit-i'}">${innerHtml}</span>`;

/**
 * The upload control shared by the item, kit/package, and person edit forms:
 * a preview, a file input, and Remove when there's something to remove.
 * `previewHtml` is fully wrapped already (photoWrapper() or personAvatar()),
 * so this doesn't need to know which kind of entity it's showing one of.
 *
 * `id` is blank when creating something new — there's no row yet to attach a
 * photo to, so a chosen file is staged in PENDING_PHOTO instead and only
 * actually uploaded once the create call above it returns a real id (see
 * the save-item/save-kit/save-person handlers).
 */
function photoField(kind, id, previewHtml, has) {
  return `
    <div class="field">
      <label class="lbl">Photo <span style="color:var(--dim)">optional</span></label>
      <div class="photo-pick">
        <span id="photo-preview">${previewHtml}</span>
        <div style="flex:1;min-width:0">
          <input type="file" id="photo-file" data-kind="${kind}" data-id="${id || ''}"
            accept="${PHOTO_TYPES.join(',')}">
          <div class="hint">JPG, PNG or WEBP, up to 5MB.</div>
        </div>
      </div>
      <button class="btn small danger" data-act="remove-photo" data-kind="${kind}" data-id="${id || ''}"
        style="margin-top:8px" id="photo-remove-btn" ${has ? '' : 'hidden'}>Remove photo</button>
    </div>`;
}

/** A file chosen before the entity it belongs to exists yet — uploaded the
    moment save-item/save-kit/save-person gets a real id back. Cleared on
    every sheet open, same as every other "building something new" scrap of
    state in this file. */
let PENDING_PHOTO = null;

/** Update the entity in place in S rather than re-fetching everything —
    list rows elsewhere pick up has_image/image_v next time they render,
    without the flash (and the lost typing, mid-edit, on whatever other field
    someone hasn't saved yet) a full refresh() would cost the open sheet. */
function setLocalImage(kind, id, hasImage, imageV) {
  const arr = kind === 'item' ? S.items : kind === 'kit' ? S.kits : S.people;
  const row = arr?.find(x => x.id === Number(id));
  if (row) { row.has_image = hasImage; row.image_v = imageV; }
}

/** Uploads a photo staged before its entity existed, once save-item/save-kit/
    save-person has a real id to attach it to. The entity is already saved by
    the time this runs, so a failed upload is reported on its own rather than
    read as the whole save having failed. */
async function uploadPendingPhoto(kind, id) {
  if (!PENDING_PHOTO || PENDING_PHOTO.kind !== kind) return;
  const file = PENDING_PHOTO.file;
  PENDING_PHOTO = null;
  try {
    const r = await uploadPhoto(`/api/${photoPath(kind)}/${id}/photo`, file);
    setLocalImage(kind, id, true, r.image_v);
  } catch (err) {
    toast(`Saved, but the photo didn't upload: ${err.message}`, true);
  }
}

/** Swap the preview back to whatever "no photo" looks like for this kind,
    after a removal — reusing gearVisual/kitVisual's own fallback rather than
    duplicating icon-choosing logic here. */
function photoFallbackHtml(kind, entity) {
  if (kind === 'item') return photoWrapper('item', gearVisual({ ...entity, has_image: false }));
  if (kind === 'kit') return photoWrapper('kit', kitVisual({ ...entity, has_image: false }));
  return personAvatar({ ...entity, has_image: false }, { large: true });
}

let S = null;            // server state
let AUTH_OFF = false;    // AUTH_MODE=none on the server, or the standalone build
let TAB = 'out';         // the checkout hub is the landing tab
let FILTER = 'All';      // category chip on the Gear tab
let STATUSF = 'all';     // status chip on the Gear tab
let FLAGF = 'all';       // ownership (Cheqroom "Flag" — FLMKR/GAT) chip on the Gear tab
let QUERY = '';
/* Gear rows collapsed into a "N units" group the viewer has unrolled, keyed by
   gearGroupKey(). A Set rather than a single flag — more than one group can
   be open on a long list without the others springing shut. */
let GROUPS_OPEN = new Set();
/* "Show all units" override — every group unrolled and the bars gone, as if
   nothing were grouped at all. Separate from GROUPS_OPEN so switching it off
   puts each group back exactly how the viewer had left it. */
let SHOW_ALL_UNITS = false;
/* Ticked on the Gear tab to build a reservation from anywhere in the list,
   rather than only from the picker inside "Reserve for later". Cleared once
   they're handed off to sheet_res, not when the tab changes — checking a few
   things, glancing at Calendar, and coming back to finish shouldn't lose them. */
let GEAR_PICKED = new Set();
let stream = null;
let preflightTimer = null;
let lastCell = null;     // last timeline column width, so resize can no-op

/* Gear scanned this session on the Check Out dashboard — the camera stays
   running across hits rather than stopping after the first, so a stack of
   gear can be scanned tag by tag before deciding what to do with it. */
let SCAN_ITEMS = [];

/* Gear picker inside the checkout and reserve sheets. 'free' hides anything
   already spoken for over the dates being asked about. */
let PICK_AVAIL = 'free'; // 'all' | 'free' — default to hiding what's spoken for
let PICK_Q = '';         // gear search inside the checkout/reserve sheets
let PICK_TL = 'conflicts';   // 'conflicts' | 'all' — how much of the day grid to show
/* Project name, shoot description and "share with" — closed by default so
   the checkout sheet reaches the gear list (the thing a walk-up checkout
   actually needs) without scrolling past fields most checkouts never touch.
   Collapsed, not gone: the toggle button itself shows whatever's already in
   there, same idea as the Reservations tab's own closed-by-default Dates panel. */
let CO_MORE = false;

/* Reservations tab. With a real cage this list runs to dozens of holds
   months out, so it needs narrowing down rather than scrolling. */
let RES_Q = '';
let RES_WHO = 'all';        // person id, or 'all'
let RES_SORT = 'soonest';   // 'soonest' | 'latest'
let RES_FROM = '';
let RES_TO = '';
let RES_DATES = false;      // is the date-range panel showing?
let KIT_PICK_Q = '';        // gear search inside the kit editor
/* Items already shown as an actionable Conflicts card. The server's own block
   for these says the same sentence, so it isn't printed twice — but anything
   the client didn't anticipate still comes through untouched. */
let SWAP_IDS = new Set();
let PICK_CTX = 'checkout';

/* Calendar tab window, and the picker's own scroll position.
   `span` is the chip that's lit; 'month' resolves to the length of whichever
   month `from` lands in, so paging moves a month at a time. */
let CAL = {
  from: null, span: 14, days: 14,
  // A phone opens straight to the day-by-day agenda — the grid needs columns
  // wide enough to read a date in, which is the one thing a phone doesn't
  // have. Read once at boot, same as PICKER_DAYS: this is an opening default,
  // not a live media query, so it doesn't jump under someone mid-session.
  group: window.innerWidth < 640 ? 'agenda' : 'checkout',   // 'agenda' | 'checkout' | 'item' | 'list'
  scope: 'booked',       // 'booked' | 'outnow' | 'all' — item view only
  cat: 'All',
  find: '', hi: null, findErr: false,
  gear: '',              // gear search — also drives the schedule list
  // Per-day load strip. Cameras and lighting are the two that decide whether a
  // shoot can happen, so they're the two the strip measures — independently.
  heat: false,
  heatGroups: { cameras: true, lighting: true },
  // Explicit period for the list. Null means "whatever's loaded", which is
  // wider than the window on screen.
  rangeFrom: null, rangeTo: null,
  listShow: 'both',      // 'both' | 'booked' | 'free'
  bookings: null, loading: false,
  // The span actually fetched, which is wider than the window on screen. The
  // schedule list reports against this, so "every day it's booked" isn't
  // silently truncated to what happens to be visible.
  loadedFrom: null, loadedTo: null
};
let PICK = { from: null, start: null, end: null, mode: 'start' };

/* Admin → Import. Holds the CSV text between the preview (dry run) and
   confirm steps so the file doesn't need re-reading, and the last result so
   re-rendering the sheet (e.g. after toggling a checkbox) doesn't lose it. */
let IMPORT_ITEMS = { csv: null, fetchImages: true, result: null };
let IMPORT_ORDERS = { csv: null, kind: 'checkout', allowPlaceholders: false, notifyImmediately: false, peopleMap: '', result: null };

const STATUS_TEXT = { ready:'In the cage', out:'Out on set', overdue:'Overdue', repair:'Down for repair', held:'Held' };

/* ------------------------------------------------------------------ plumbing */

async function req(method, url, body) {
  // The standalone single-file build installs an in-browser stand-in for the
  // API here, so the same client code runs with no server behind it.
  if (globalThis.__CAGE_LOCAL) return globalThis.__CAGE_LOCAL(method, url, body);

  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}
const GET = url => req('GET', url);
const POST = (url, body) => req('POST', url, body);
const PATCH = (url, body) => req('PATCH', url, body);
const PUT = (url, body) => req('PUT', url, body);
const DEL = (url, body) => req('DELETE', url, body);

/**
 * A photo upload, as multipart rather than JSON — req() always sends JSON,
 * which is the wrong shape for raw image bytes. Deliberately not wired into
 * the standalone build: that build has never served a real photo either
 * (has_image is always false there), so failing here with a clear message
 * is more honest than pretending to support it.
 */
async function uploadPhoto(url, file) {
  if (globalThis.__CAGE_LOCAL) {
    throw new Error("Photo uploads aren't available in the offline demo build.");
  }
  const body = new FormData();
  body.append('photo', file);
  const res = await fetch(url, { method: 'POST', body });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data.error || `Upload failed (${res.status})`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = bad ? 'show bad' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, bad ? 4200 : 2600);
}

const today = () => S?.today || new Date().toISOString().slice(0, 10);
function shift(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* -------------------------------------------------------- derived item state */

const item = id => S.items.find(i => i.id === Number(id));

/* A flag's colour is a fixed, alphabetical assignment across the whole
   fleet — never a hash — so the same flag value gets the same colour
   wherever it shows up, and a 7th+ distinct value just goes uncoloured
   (still shown as plain text) rather than reusing a colour or making one
   up. See public/styles.css for the --owner-N steps. Derived fresh off
   S.items rather than cached, so it always reflects whatever's live after
   the next refresh(); the list is small enough that this costs nothing. */
const flagIndex = flag => [...new Set(S.items.filter(i => !i.retired).map(i => i.flag).filter(Boolean))]
  .sort().indexOf(flag);

/** The owner tag shown next to an item's name everywhere it appears in a
    list — every list except a physical label preview or the compact
    swap-candidate buttons, where there's no room for it. Empty string for
    an item with no flag, so callers can splice it in unconditionally. */
function flagTag(it) {
  if (!it?.flag) return '';
  const i = flagIndex(it.flag);
  const dot = i >= 0 && i < 6 ? `<i class="flag-dot" data-flag-i="${i + 1}"></i>` : '';
  return `<span class="flag-tag">${dot}${esc(it.flag)}</span>`;
}

const openOut = id => S.openCheckouts.find(c => c.item_ids.includes(id));
const downFor = id => S.openMaintenance.find(m => m.item_id === id);
const heldNow = id => S.reservations.find(r =>
  r.item_ids.includes(id) && r.start_on <= today() && today() <= r.end_on);

function statusOf(id) {
  if (downFor(id)) return 'repair';
  const c = openOut(id);
  if (c) return c.due_on < today() ? 'overdue' : 'out';
  if (heldNow(id)) return 'held';
  return 'ready';
}
const isAdmin = () => S?.me?.role === 'admin';
const personName = p => p?.name || p?.email || 'someone';

/* ================================ views ================================ */

/**
 * The landing tab: everything needed to get gear out of the door and back in,
 * and nothing else. The inventory, the alerts and the status board all live on
 * the Gear tab, because none of them are part of doing a checkout.
 */
function view_out() {
  const mine = S.openCheckouts.filter(c => c.holder_id === S.me.id);
  const myLate = mine.filter(c => c.due_on < today());
  /* Two panels, and the words have to line up with the rest of the app: a
     reservation is a "hold" everywhere else — Release this hold, held for X —
     so the hold panel is the reservations one. Gear physically out is "out
     with you", not "holding", which is what made a new hold look like it had
     landed in the wrong place. */
  const myHolds = S.reservations
    .filter(r => r.person_id === S.me.id && r.end_on >= today())
    .sort((a, b) => a.start_on.localeCompare(b.start_on));

  const reqs = S.requests || [];
  const toDecide = reqs.filter(r => r.holder_id === S.me.id || (isAdmin() && r.requester_id !== S.me.id));
  const mineSent = reqs.filter(r => r.requester_id === S.me.id);

  const names = ids => (ids || []).map(i => item(i)?.name).filter(Boolean).join(', ');
  /* A swap has to read as a trade, both directions on screen — "wants to add"
     would be a lie about what accepting does. */
  const reqBody = (r, theirSide) => r.kind === 'swap'
    ? `<span class="row-sub">${theirSide ? 'You give' : 'They give'}: ${esc(names(r.item_ids))}</span>
       <span class="row-sub">${theirSide ? 'You get' : 'You give'}: ${esc(names(r.offer_item_ids))}</span>`
    : `<span class="row-sub">${esc(names(r.item_ids))}</span>`;

  const decideRow = r => `<div class="req">
    <div class="req-h"><span class="row-name">${esc(r.requester_name)} ${
      r.kind === 'swap' ? 'offers a swap' : `wants to add ${r.item_ids.length} item${r.item_ids.length === 1 ? '' : 's'}`}</span>
      ${reqBody(r, true)}
      ${r.note ? `<span class="row-sub">“${esc(r.note)}”</span>` : ''}</div>
    <div class="btn-row">
      <button class="btn small primary" data-act="req-approve" data-id="${r.id}">${
        r.kind === 'swap' ? 'Accept' : 'Approve'}</button>
      <button class="btn small" data-act="req-decline" data-id="${r.id}">Decline</button>
    </div>
  </div>`;
  const sentRow = r => `<div class="req sent">
    <div class="req-h"><span class="row-name">Waiting on ${esc(r.holder_name)}${
      r.kind === 'swap' ? ' — swap' : ''}</span>
      ${reqBody(r, false)}</div>
    <div class="btn-row"><button class="btn small" data-act="req-cancel" data-id="${r.id}">Withdraw</button></div>
  </div>`;

  // Same lead as everywhere else this pattern shows up (bookingHeaderMeta):
  // the project is what you're scanning your own list for, not a repeat of
  // gear you already know you booked — falls back to the gear summary when
  // there's no project to show instead.
  const resRow = r => {
    const now = r.start_on <= today();
    const label = bookingLabel(r);
    const gear = esc(bookingGearSummary(r)) || 'No gear on this hold';
    return `<button class="row" data-act="edit-res" data-id="${r.id}">
      <i class="tally held"></i>
      <span class="row-main">
        <span class="row-name">${label ? esc(label) : gear}</span>
        <span class="row-sub">${label ? gear + ' · ' : ''}${now ? 'now' : 'from'} ${r.start_on} → ${r.end_on}</span>
      </span>
      <span class="lbl">${now ? 'Collect' : 'Booked'}</span>
    </button>`;
  };

  const coRow = c => {
    const late = c.due_on < today();
    const label = bookingLabel(c);
    const gear = esc(bookingGearSummary(c)) || 'No gear on this loan';
    return `<button class="row" data-act="checkout" data-id="${c.id}">
      <i class="tally ${late ? 'overdue' : 'out'}"></i>
      <span class="row-main">
        <span class="row-name">${label ? esc(label) : gear}</span>
        <span class="row-sub">${label ? gear + ' · ' : ''}due ${c.due_on}${late ? ' · overdue' : ''}</span>
      </span>
      <span class="lbl">Check in</span>
    </button>`;
  };

  return `
  <div class="lbl">Check out / check in</div>
  <h2 style="margin:6px 0 16px">What do you need?</h2>

  ${myLate.length ? `<button class="alert as-row" data-act="checkout" data-id="${myLate[0].id}" style="margin-bottom:14px">
    <span>
      <span class="lbl">Overdue</span>
      <span class="row-name">You're holding ${myLate.reduce((n, c) => n + c.item_ids.length, 0)} item(s) past due</span>
      <span class="row-sub">Get them back before taking anything else out.</span>
    </span></button>` : ''}

  <div class="cols">
    <div>
      <div class="act-grid">
        <button class="act primary" data-act="new-checkout">
          <span class="act-i">${iconFor({ category: 'Camera' })}</span>
          <span class="act-t">Check out gear</span>
          <span class="act-d">Take it now</span>
        </button>
        <button class="act" data-act="new-res">
          <span class="act-i">${iconFor({ category: 'Support' })}</span>
          <span class="act-t">Reserve for later</span>
          <span class="act-d">Hold it for a shoot</span>
        </button>
      </div>

      <!-- Scanning is a phone-camera feature (native BarcodeDetector) — on a
           laptop or desktop it's dead weight above the fold, so the whole
           panel is hidden past the 900px breakpoint where the nav itself
           already treats the screen as a desktop. Looking gear up by code
           without a camera still works — it's what the Gear tab's search is
           for. -->
      <div class="panel scan-panel">
        <div class="panel-h"><span class="lbl">Scan</span></div>
        <div class="panel-b">
          <div id="cam-wrap"></div>
          <div class="btn-row" style="margin-top:10px">
            <button class="btn primary" data-act="start-cam">Use camera</button>
            <button class="btn" data-act="stop-cam">Stop</button>
          </div>
          <!-- The camera keeps running across scans rather than stopping after
               the first hit, so a stack of gear can be scanned one tag after
               another before deciding what to do with the pile. -->
          <div id="scan-results">${scanResultsBlock()}</div>
          <div class="field" style="margin-top:14px">
            <label class="lbl" for="code">Or type the code</label>
            <input id="code" placeholder="LC-101" autocomplete="off" autocapitalize="characters" spellcheck="false">
          </div>
          <button class="btn wide" data-act="lookup">Look up gear</button>
        </div>
      </div>
    </div>

    <div>
      ${toDecide.length ? `<div class="panel">
        <div class="panel-h"><span class="lbl">Waiting on you</span>
          <span class="mono" style="color:var(--dim)">${toDecide.length}</span></div>
        <div class="panel-b">${toDecide.map(decideRow).join('')}</div>
      </div>` : ''}
      ${mineSent.length ? `<div class="panel">
        <div class="panel-h"><span class="lbl">You've asked for</span>
          <span class="mono" style="color:var(--dim)">${mineSent.length}</span></div>
        <div class="panel-b">${mineSent.map(sentRow).join('')}</div>
      </div>` : ''}

      <div class="panel">
        <div class="panel-h">
          <span class="lbl">Out with you</span>
          <span class="mono" style="color:var(--dim)">${mine.reduce((n, c) => n + c.item_ids.length, 0)}</span>
        </div>
        <div class="panel-b flush">${
          mine.length
            ? mine.map(coRow).join('')
            : `<div class="empty">Nothing out in your name. Check something out to get started.</div>`
        }</div>
      </div>

      <div class="panel">
        <div class="panel-h">
          <span class="lbl">On hold for you</span>
          <span class="mono" style="color:var(--dim)">${myHolds.reduce((n, r) => n + r.item_ids.length, 0)}</span>
        </div>
        <div class="panel-b flush">${
          myHolds.length
            ? myHolds.map(resRow).join('')
            : `<div class="empty">Nothing on hold. Reserve gear ahead of a shoot and it shows up here.</div>`
        }</div>
      </div>
    </div>
  </div>`;
}

/** The inventory: what exists, what state it's in, and where to find it. */
/** Same physical gear, different unit — "Accsoon Cineview HE-1", "-2", "-3" —
 *  collapse to one row. Keyed on the name with a trailing "-<number>" stripped
 *  (case-insensitive, so inconsistent capitalisation still folds together),
 *  plus the flag: a GAT-owned unit never joins a group of otherwise-identical
 *  FLMKR-owned ones, even though the stripped name matches. */
function gearGroupKey(it) {
  return it.name.replace(/-\s*\d+\s*$/, '').trim().toLowerCase() + '::' + (it.flag || '');
}

/** True once `list` has at least one gearGroupKey shared by more than one
 *  item — the "Show all units" toggle is pointless, and hidden, otherwise. */
function hasGroupedGear(list) {
  const seen = new Set();
  for (const it of list) {
    const key = gearGroupKey(it);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/**
 * Groups by gearGroupKey(), in the order each key first appears in `list` —
 * a filtered/searched view still reads top to bottom the way it always did.
 * A group of one is just a row; a group of more collapses to its first unit
 * plus a bar for the rest, unless the viewer has already unrolled that key —
 * or switched on "Show all units", which skips grouping altogether.
 * `rowFn` renders one item; kept as a parameter rather than importing
 * view_gear's row markup here, so this stays a plain data transform.
 */
function gearRows(list, rowFn) {
  if (SHOW_ALL_UNITS) return list.map(rowFn).join('');
  const groups = [];
  const byKey = new Map();
  for (const it of list) {
    const key = gearGroupKey(it);
    const g = byKey.get(key);
    if (g) g.push(it);
    else { const fresh = [it]; byKey.set(key, fresh); groups.push(fresh); }
  }
  return groups.map(g => {
    if (g.length === 1) return rowFn(g[0]);
    const key = gearGroupKey(g[0]);
    const open = GROUPS_OPEN.has(key);
    return (open ? g : [g[0]]).map(rowFn).join('') +
      `<button class="group-bar" data-act="group-toggle" data-key="${esc(key)}">${
        open ? 'Show fewer' : `+ ${g.length - 1} more like this`}</button>`;
  }).join('');
}

function view_gear() {
  const counts = { ready:0, out:0, overdue:0, held:0, repair:0 };
  const live = S.items.filter(i => !i.retired);
  live.forEach(i => counts[statusOf(i.id)]++);

  /* One bar per category rather than one rectangle per item. Every segment is
     a filter: tap "3 out" under Cameras and the list below shows exactly those
     three. The whole row is reachable by keyboard for the same reason. */
  const cage = categoryBreakdown(live, i => statusOf(i.id)).map(row => {
    const free = row.total - row.unavailable;
    const parts = SEGMENT_ORDER.filter(s => s !== 'ready' && row[s])
      .map(s => `${row[s]} ${STATUS_TEXT[s].toLowerCase()}`);
    return `<div class="cage-row">
      <div class="cage-head">
        <button class="cage-cat" data-act="cat-filter" data-cat="${esc(row.category)}"
          title="Show only ${esc(row.category)}">${esc(row.category)}</button>
        <span class="cage-n">${free}<span class="of"> / ${row.total} free</span></span>
      </div>
      <div class="cage-bar">
        ${segments(row).map(seg =>
          `<button class="seg ${seg.status}" style="--w:${seg.pct.toFixed(2)}%"
            data-act="cat-status" data-cat="${esc(row.category)}" data-status="${seg.status}"
            aria-label="${seg.count} ${esc(STATUS_TEXT[seg.status])}"
            title="${esc(row.category)} — ${seg.count} ${esc(STATUS_TEXT[seg.status].toLowerCase())}"></button>`
        ).join('')}
      </div>
      <div class="cage-sum" title="${esc(parts.length ? parts.join(' · ') : 'all on the shelf')}">${
        parts.length ? esc(parts.join(' · ')) : 'all on the shelf'}</div>
    </div>`;
  }).join('');

  /* The legend doubles as the status filter — the colours already mean
     something, so making them tappable saves a second row of controls. */
  const statusChip = (key, label, n, dot) =>
    `<button class="chip stat" data-act="status-filter" data-status="${key}" aria-pressed="${STATUSF === key}">
      ${dot ? `<i class="dot ${dot}"></i>` : ''}${label}<span class="n">${n}</span>
    </button>`;

  let alerts = '';
  S.openCheckouts.filter(c => c.due_on < today()).forEach(c => {
    const days = Math.round((Date.parse(today()) - Date.parse(c.due_on)) / 864e5);
    alerts += `<button class="alert as-row" data-act="checkout" data-id="${c.id}"><span>
      <span class="lbl">Overdue ${days}d</span>
      <span class="row-name">${esc(bookingGearSummary(c))}</span>
      <span class="row-sub">${esc(c.holder_name || c.holder_email)} · due ${c.due_on}</span>
    </span></button>`;
  });
  S.openMaintenance.forEach(m => {
    const mi = item(m.item_id);
    alerts += `<button class="alert warn as-row" data-act="item" data-id="${m.item_id}"><span>
      <span class="lbl">${esc(m.kind)}</span>
      <span class="row-name">${esc(mi?.name || 'Unknown item')}${flagTag(mi)}</span>
      <span class="row-sub">opened ${m.opened_on}${m.notes ? ' · ' + esc(m.notes) : ''}</span>
    </span></button>`;
  });

  const cats = ['All', ...new Set(live.map(i => i.category))].sort((a, b) =>
    a === 'All' ? -1 : b === 'All' ? 1 : a.localeCompare(b));
  // Same values flagIndex derives its colours from — kept local since only
  // the filter chips need the actual list, not just a colour for one.
  const flags = [...new Set(live.map(i => i.flag).filter(Boolean))].sort();
  const flagDot = f => { const i = flagIndex(f); return i >= 0 && i < 6 ? `<i class="flag-dot" data-flag-i="${i + 1}"></i>` : ''; };

  const byCat = live.filter(i => FILTER === 'All' || i.category === FILTER);
  const byFlag = byCat.filter(i => FLAGF === 'all' || i.flag === FLAGF);
  const byStatus = byFlag.filter(i => STATUSF === 'all' || statusOf(i.id) === STATUSF);
  const list = searchItems(byStatus, QUERY);

  /* A row can't hold a button — it is one — so the quick-add lives beside it
     in a wrapper, and the pick checkbox on the other side of it, same reason. */
  const gearRow = i => {
    const st = statusOf(i.id);
    const c = openOut(i.id);
    const h = heldNow(i.id);
    return `<div class="row-wrap"><span class="row-check">
      <input type="checkbox" class="gear-pick" value="${i.id}" ${GEAR_PICKED.has(i.id) ? 'checked' : ''}
        aria-label="Select ${esc(i.name)}"></span>
      <button class="row" data-act="item" data-id="${i.id}">
        <i class="tally ${st}"></i>
        <span class="gear-i ${st}">${gearVisual(i)}</span>
        <span class="row-main">
          <span class="row-name">${esc(i.name)}${flagTag(i)}</span>
          <span class="row-sub">${esc(i.code)} · ${esc(i.brand || i.category)}${
            c ? ' · ' + esc(c.holder_name || c.holder_email) : h ? ' · held for ' + esc(h.person_name) : ''}</span>
        </span>
        <span class="lbl">${st === 'ready' ? '' : STATUS_TEXT[st]}</span>
      </button>
      <button class="row-add ${cartHas(CART, i.id) ? 'in' : ''}" data-act="cart-add" data-id="${i.id}"
        title="${cartHas(CART, i.id) ? 'Already in your checkout' : 'Add to checkout'}"
        aria-label="${cartHas(CART, i.id) ? 'Already in your checkout' : `Add ${esc(i.name)} to checkout`}"
        >${cartHas(CART, i.id) ? '✓' : '+'}</button></div>`;
  };

  const pickedHere = [...GEAR_PICKED].filter(id => item(id));

  return `
  <div class="lbl">Inventory</div>
  <h2 style="margin:6px 0 14px">Gear</h2>

  <section class="cage-grid">${cage}</section>

  <div class="chips" style="margin:12px 0 14px">
    ${statusChip('all', 'All', live.length, '')}
    ${statusChip('ready', 'Available', counts.ready, 'ready')}
    ${statusChip('out', 'Out', counts.out, 'out')}
    ${statusChip('overdue', 'Overdue', counts.overdue, 'overdue')}
    ${statusChip('held', 'Held', counts.held, 'held')}
    ${statusChip('repair', 'Down', counts.repair, 'repair')}
  </div>

  ${alerts ? `<div class="alert-stack">${alerts}</div>` : ''}

  ${isAdmin() ? `<div class="btn-row" style="margin-bottom:14px">
    <button class="btn" data-act="new-item">Add gear</button>
    <button class="btn" data-act="labels">QR labels</button>
  </div>` : ''}

  <div class="btn-row" style="margin-bottom:12px">
    <div class="field" style="flex:1;margin-bottom:0">
      <input id="q" type="search" placeholder="Search name, brand, serial or code" value="${esc(QUERY)}"></div>
    ${hasGroupedGear(list) ? `<button class="btn" data-act="show-all-units" aria-pressed="${SHOW_ALL_UNITS}">${
      SHOW_ALL_UNITS ? 'Group duplicates' : 'Show all units'}</button>` : ''}
  </div>
  <div class="chips" style="margin-bottom:14px">
    ${cats.map(c => `<button class="chip" data-act="filter" data-cat="${esc(c)}" aria-pressed="${c === FILTER}">${esc(c)}</button>`).join('')}
  </div>
  ${flags.length ? `<div class="chips" style="margin-bottom:14px">
    <button class="chip" data-act="flag-filter" data-flag="all" aria-pressed="${FLAGF === 'all'}">All owners</button>
    ${flags.map(f => `<button class="chip" data-act="flag-filter" data-flag="${esc(f)}" aria-pressed="${FLAGF === f}">${flagDot(f)}${esc(f)}</button>`).join('')}
  </div>` : ''}

  ${pickedHere.length ? `<div class="btn-row" style="margin-bottom:10px">
    <button class="btn primary" style="flex:1" data-act="gear-add-to-res">Add ${pickedHere.length} to a reservation</button>
    <button class="btn" data-act="gear-clear-picks">Clear</button>
  </div>` : ''}

  <div class="panel"><div class="panel-b flush">
    ${list.length ? gearRows(list, gearRow) : `<div class="empty">${
      QUERY ? 'Nothing matches that search.' : 'No gear in this filter.'
    }</div>`}
  </div></div>`;
}

/** Everyone holding something, for the person filter. */
function reservationPeople() {
  const seen = new Map();
  for (const r of S.reservations) {
    if (!seen.has(r.person_id)) seen.set(r.person_id, r.person_name || r.person_email);
  }
  return [...seen].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
}

function view_reserve() {
  const gearOf = r => r.item_ids.map(i => item(i)).filter(Boolean);
  let rows = S.reservations;

  if (RES_WHO !== 'all') rows = rows.filter(r => String(r.person_id) === RES_WHO);
  /* A hold counts as "in" a range if any of it falls inside — a shoot running
     across the end of the month is still happening this month. */
  if (RES_FROM) rows = rows.filter(r => r.end_on >= RES_FROM);
  if (RES_TO) rows = rows.filter(r => r.start_on <= RES_TO);
  rows = searchReservations(rows, RES_Q, { itemsFor: gearOf });
  rows = [...rows].sort((a, b) => RES_SORT === 'latest'
    ? b.start_on.localeCompare(a.start_on) || b.end_on.localeCompare(a.end_on)
    : a.start_on.localeCompare(b.start_on) || a.end_on.localeCompare(b.end_on));

  const total = S.reservations.length;
  const people = reservationPeople();
  const filtered = rows.length !== total;
  const chip = (v, label) => `<button class="chip" data-act="res-sort" data-sort="${v}"
    aria-pressed="${RES_SORT === v}">${label}</button>`;

  return `
  <div class="lbl">On the books</div>
  <h2 style="margin:6px 0 14px">Reservations</h2>
  <button class="btn primary wide" data-act="new-res" style="margin-bottom:14px">Hold gear for a date</button>

  <div class="field" style="margin-bottom:8px"><input id="res-q" type="search"
    placeholder="Search reservations — person, project, or gear" value="${esc(RES_Q)}"></div>
  <div class="res-bar">
    <select id="res-who" aria-label="Filter by person">
      <option value="all">Everyone</option>
      ${people.map(([id, name]) =>
        `<option value="${id}" ${String(id) === RES_WHO ? 'selected' : ''}>${esc(name)}</option>`).join('')}
    </select>
    <span class="chips tight">${chip('soonest', 'Soonest')}${chip('latest', 'Latest')}</span>
    <button class="btn small" data-act="res-dates" aria-expanded="${RES_DATES}">${
      RES_FROM || RES_TO ? `${esc(RES_FROM || 'any')} → ${esc(RES_TO || 'any')}` : 'Dates'}</button>
  </div>
  ${RES_DATES ? `<div class="res-dates">
    <div class="two">
      <div class="field"><label class="lbl" for="res-from">From</label>
        <input id="res-from" type="date" value="${esc(RES_FROM)}"></div>
      <div class="field"><label class="lbl" for="res-to">To</label>
        <input id="res-to" type="date" value="${esc(RES_TO)}"></div>
    </div>
    <div class="btn-row">
      <button class="btn small" data-act="res-range" data-range="week">This week</button>
      <button class="btn small" data-act="res-range" data-range="month">This month</button>
      <button class="btn small" data-act="res-range" data-range="30">Next 30 days</button>
      <button class="btn small" data-act="res-range" data-range="clear">Clear</button>
    </div>
  </div>` : ''}
  <!-- "1 of 52 reservations": the noun agrees with the total, not the match count. -->
  <div class="pick-meta">${filtered ? `${rows.length} of ${total}` : `${total}`} reservation${
    total === 1 ? '' : 's'}${
    RES_WHO !== 'all' ? ` · ${esc(people.find(p => String(p[0]) === RES_WHO)?.[1] || '')}` : ''}</div>

  <div class="panel"><div class="panel-b flush">
    ${rows.length ? rows.map(r => {
      const started = r.start_on <= today() && r.end_on >= today();
      const past = r.end_on < today();
      const gear = gearOf(r);
      // Same lead as the hold's own detail sheet (bookingHeaderMeta) — the
      // project is what someone's scanning this list for, not who booked it.
      const hm = bookingHeaderMeta(r, r.person_name || r.person_email);
      // The kit/package name if the gear on this hold still matches one, e.g.
      // "Aputure B7C Kit" — short and worth a glance. Every item's own name
      // strung together was the opposite: 24 items reads as a wall of text
      // before you've even opened the thing. That detail is what the row
      // exists to link to, not what it exists to print.
      const kitLabel = kitBookingLabel(r);
      return `<button class="row" data-act="edit-res" data-id="${r.id}">
        <i class="tally ${past ? 'ready' : started ? 'held' : 'ready'}"></i>
        <span class="row-main">
          <span class="row-name">${esc(hm.header)}${
            started ? ' <span class="kit-tag shared">now</span>' : ''}</span>
          <!-- The dates get their own line rather than trailing the project name —
               .row-name is nowrap-ellipsis, so on a narrow phone a long name was
               clipping the one thing this list exists to tell you: when. -->
          <span class="row-sub">${r.start_on} → ${r.end_on}</span>
          <span class="row-sub">${hm.sub ? esc(hm.sub) + ' · ' : ''}${
            kitLabel ? esc(kitLabel) + ' · ' : ''}${gear.length} item${gear.length === 1 ? '' : 's'}</span>
        </span>
      </button>`;
    }).join('') : `<div class="empty">${
      total ? 'No reservation matches those filters.'
            : "Nothing on the books. Hold gear ahead of a shoot so it's there when you need it."}</div>`}
  </div></div>`;
}

function view_repairs() {
  const card = (m, open) => `<button class="row" data-act="${open ? 'close-maint' : 'item'}" data-id="${open ? m.id : m.item_id}">
    <i class="tally ${open ? 'repair' : 'ready'}"></i>
    <span class="row-main">
      <span class="row-name">${esc(item(m.item_id)?.name || 'Unknown item')}</span>
      <span class="row-sub">${esc(m.kind)} · opened ${m.opened_on}${m.closed_on ? ' · closed ' + m.closed_on : ''}</span>
      ${m.notes ? `<span class="row-sub">${esc(m.notes)}</span>` : ''}
    </span>
    ${open ? `<span class="lbl">Mark fixed</span>` : ''}
  </button>`;

  return `
  <div class="lbl">Service log</div>
  <h2 style="margin:6px 0 14px">Repairs</h2>
  <button class="btn primary wide" data-act="new-maint" style="margin-bottom:14px">Log a problem</button>
  <div class="cols">
    <div class="panel">
      <div class="panel-h"><span class="lbl">Open</span><span class="mono" style="color:var(--dim)">${S.openMaintenance.length}</span></div>
      <div class="panel-b flush">${S.openMaintenance.length
        ? S.openMaintenance.map(m => card(m, true)).join('')
        : `<div class="empty">Nothing is down.</div>`}</div>
    </div>
    <div class="panel">
      <div class="panel-h"><span class="lbl">Closed</span><span class="mono" style="color:var(--dim)">${S.closedMaintenance.length}</span></div>
      <div class="panel-b flush">${S.closedMaintenance.length
        ? S.closedMaintenance.map(m => card(m, false)).join('')
        : `<div class="empty">No closed tickets yet.</div>`}</div>
    </div>
  </div>`;
}

/* Which package sections are expanded. Yours is open by default because
   it's the one you came for; the team list is a browse, not a destination. */
const PKG_OPEN = { mine: true, team: false };
/* Packages tab search. `scope` narrows to one section; 'all' shows both. */
let PKG_Q = '';
let PKG_SCOPE = 'all';
/* Kits tab search — a flat list, no ownership scoping: a physical kit has
   no personal owner to scope by. */
let KIT_Q = '';

/* A kit with no owner_id predates personal kits and belongs to everyone.
   Mirrors kitVisibleTo/kitEditableBy in src/policy.js — advisory only, the
   server refuses regardless. */
const kitIsMine = k => k.owner_id != null && k.owner_id === S.me.id;
const kitCanEdit = k => kitIsMine(k) || (k.owner_id == null && isAdmin());
const kitOwnerName = k => k.owner_id == null
  ? 'the team'
  : (k.owner_name || k.owner_email || 'someone');

/**
 * A booking that started from a kit or package names that instead of every
 * item — "Aputure B7C Kit" reads far better than four asset codes. Only
 * trusted when the booking's gear still covers the kit's *current*
 * contents; if items were taken off since, this backs off to null rather
 * than naming a kit that isn't really all there. Extra gear beyond the kit
 * — a second kit stacked on, or something added by hand — shows as "+ N
 * more" instead of silently disappearing from the count.
 */
function kitBookingLabel(b) {
  const k = b.kit_id ? S.kits.find(x => x.id === b.kit_id) : null;
  if (!k) return null;
  const bookingIds = new Set(b.item_ids);
  if (!k.item_ids.every(id => bookingIds.has(id))) return null;
  const extra = b.item_ids.filter(id => !k.item_ids.includes(id)).length;
  return extra ? `${k.name} + ${extra} more` : k.name;
}

/** Item names, joined — or the kit/package label when the booking has one
    and it still holds. */
function bookingGearSummary(b) {
  return kitBookingLabel(b) || b.item_ids.map(i => item(i)?.name).filter(Boolean).join(', ');
}

/**
 * Wraps a booking's item list behind a collapsed "Gimbal Rig · 5 items" bar
 * when kitBookingLabel has something to say — expanding is one tap for the
 * times you do need to see or tick each item, same reasoning as the list
 * view showing the kit name instead of every item's name. A booking with no
 * such label (no kit, or one that's drifted from it) just gets the plain
 * list, same as always — there's nothing meaningful to hide it behind.
 *
 * `innerHtml` keeps whatever wrapping the caller already used (some wrap
 * their rows in a .panel, some don't) — this only ever adds the toggle
 * around it. The rows stay in the DOM either way, just hidden rather than
 * unrendered, so a hidden checkbox is still there for "Check in selected"
 * to read — collapsed-by-default with every box pre-ticked means the
 * default action is exactly "check in the whole kit".
 */
function bookingItemsBlock(booking, innerHtml, itemCount) {
  const label = kitBookingLabel(booking);
  if (!label) return innerHtml;
  const open = BOOKING_ITEMS_OPEN;
  return `
    <button class="kit-sec ${open ? 'open' : ''}" data-act="booking-items-toggle" aria-expanded="${open}">
      <span class="kit-sec-t">${esc(label)}<span class="kit-tag">${itemCount}</span></span>
      <span class="kit-sec-c">${open ? '−' : '+'}</span>
    </button>
    <div class="kit-sec-b" ${open ? '' : 'hidden'}>${innerHtml}</div>`;
}

/**
 * A checkout preset — curated by a person, not a physical bundle. Full
 * ownership functionality: edit, duplicate, share, delete, send as a link.
 * See kitPanel() below for the physical-kit equivalent, which drops all of
 * that — a case of gear has no owner to duplicate or share on someone's
 * behalf.
 */
function packagePanel(k) {
  const missing = k.item_ids.filter(i => !item(i));
  const blocked = k.item_ids.filter(i => item(i) && statusOf(i) !== 'ready');
  const editable = kitCanEdit(k);
  const mine = kitIsMine(k);
  return `<div class="panel">
    <div class="panel-h">
      <span style="display:flex;align-items:center;gap:10px;min-width:0">
        <span class="kit-i">${kitVisual(k)}</span>
        <span style="min-width:0"><span class="row-name">${esc(k.name)}${
          k.shared ? '<span class="kit-tag shared">shared</span>' : ''}${
          !mine && k.owner_id != null ? `<span class="kit-tag">${esc(kitOwnerName(k))}</span>` : ''}</span>
        <span class="row-sub">${k.item_ids.length} item${k.item_ids.length === 1 ? '' : 's'} · ${
          blocked.length ? `${blocked.length} unavailable` : 'all ready'}${
          missing.length ? ` · ${missing.length} since retired` : ''}</span></span>
      </span>
      <i class="tally ${blocked.length ? 'out' : 'ready'}"></i>
    </div>
    ${k.notes ? `<div class="panel-b"><span class="row-sub">${esc(k.notes)}</span></div>` : ''}
    <div class="panel-b flush">
      ${k.item_ids.map(id => {
        const it = item(id); if (!it) return '';
        const st = statusOf(id);
        return `<button class="row ${st === 'ready' ? '' : 'dim'}" data-act="item" data-id="${id}">
          <i class="tally ${st}"></i>
          <span class="gear-i ${st}">${gearVisual(it)}</span>
          <span class="row-main"><span class="row-name">${esc(it.name)}${flagTag(it)}</span>
          <span class="row-sub">${esc(it.code)}${st !== 'ready' ? ' · ' + STATUS_TEXT[st] : ''}</span></span>
        </button>`;
      }).join('')}
    </div>
    <div class="panel-b btn-row">
      <button class="btn primary" data-act="cart-add-kit" data-id="${k.id}">Add to checkout</button>
      <button class="btn" data-act="kit-out" data-id="${k.id}">Check out now</button>
      <button class="btn" data-act="kit-res" data-id="${k.id}">Reserve</button>
    </div>
    <div class="panel-b btn-row kit-acts">
      ${editable ? `<button class="btn small" data-act="kit-edit" data-id="${k.id}">Edit</button>` : ''}
      <button class="btn small" data-act="kit-dup" data-id="${k.id}">Duplicate</button>
      <button class="btn small" data-act="kit-link" data-id="${k.id}">Send link</button>
      ${editable ? `<button class="btn small" data-act="kit-share" data-id="${k.id}">${
        k.shared ? 'Make private' : 'Share with team'}</button>` : ''}
      ${(editable || isAdmin()) ? `<button class="btn small danger" data-act="kit-del" data-id="${k.id}">Delete</button>` : ''}
    </div>
  </div>`;
}

/**
 * Two collapsible sections rather than one long list. With a shared cage the
 * team list gets long fast, and you're nearly always reaching for your own.
 * Each opens independently so you can still have both up to compare.
 */
function packageSection(key, title, kits, emptyText, { searching = false, sole = false } = {}) {
  /* A closed section hides its matches, which reads as "no results". So a
     search opens whatever it found, and narrowing to one section opens it —
     scoping to Team and getting a closed box is a dead end. Collapsing it
     again is still your call. */
  const open = PKG_OPEN[key] || sole || (searching && kits.length > 0);
  return `
  <button class="kit-sec ${open ? 'open' : ''}" data-act="package-sec" data-sec="${key}"
          aria-expanded="${open}">
    <span class="kit-sec-t">${title}<span class="kit-tag">${kits.length}</span></span>
    <span class="kit-sec-c">${open ? '−' : '+'}</span>
  </button>
  ${open ? `<div class="kit-sec-b">${
    kits.length ? kits.map(packagePanel).join('') : `<div class="empty">${emptyText}</div>`
  }</div>` : ''}`;
}

/** Checkout presets — hand-curated bundles for a specific kind of shoot. */
function view_packages() {
  const q = PKG_Q.trim();
  const find = kits => searchKits(kits, q, {
    itemsFor: k => k.item_ids.map(i => item(i)).filter(Boolean)
  });
  const packages = S.kits.filter(k => k.type === 'package');
  const mine = find(packages.filter(kitIsMine));
  const theirs = find(packages.filter(k => !kitIsMine(k)));
  const scope = PKG_SCOPE;
  const chip = (v, label) =>
    `<button class="chip" data-act="package-scope" data-scope="${v}"
       aria-pressed="${scope === v}">${label}</button>`;

  const nothing = q && !mine.length && !theirs.length;
  return `
  <div class="lbl">Checkout presets</div>
  <h2 style="margin:6px 0 14px">Packages</h2>
  <button class="btn primary wide" data-act="new-package" style="margin-bottom:14px">Build a package</button>
  <div class="field" style="margin-bottom:8px"><input id="pkg-q" type="search"
    placeholder="Search packages — by name, or the gear inside" value="${esc(PKG_Q)}"></div>
  <div class="chips tight" style="margin:0 0 14px">
    ${chip('all', 'All')}${chip('mine', 'Yours')}${chip('team', 'Team')}
  </div>
  ${nothing
    /* One clear miss beats the same news twice over two empty sections. */
    ? `<div class="empty">No packages match “${esc(q)}”. The search covers package
       names, their notes, and the gear inside them.</div>`
    : `${scope !== 'team' ? packageSection('mine', 'Your packages', mine,
        q ? `Nothing of yours matches “${esc(q)}”.`
          : 'No packages of your own yet. Build one so nobody forgets the lav bag again — or duplicate a team package and make it yours.',
        { searching: Boolean(q), sole: scope === 'mine' }) : ''}
      ${scope !== 'mine' ? packageSection('team', 'Team packages', theirs,
        q ? `No team package matches “${esc(q)}”.`
          : 'Nothing shared yet. Share one of yours and it shows up here for everyone.',
        { searching: Boolean(q), sole: scope === 'team' }) : ''}`}`;
}

/**
 * A physical kit — a case that already holds a fixed set of gear, imported
 * from Cheqroom rather than built by hand. No owner, so none of a package's
 * personal-curation controls apply: nobody duplicates a case, or shares one
 * that was already visible to the whole team. Admins can still fix its
 * contents or retire it outright — that's maintenance, not ownership.
 */
function kitPanel(k) {
  const missing = k.item_ids.filter(i => !item(i));
  const blocked = k.item_ids.filter(i => item(i) && statusOf(i) !== 'ready');
  return `<div class="panel">
    <div class="panel-h">
      <span style="display:flex;align-items:center;gap:10px;min-width:0">
        <span class="kit-i">${kitVisual(k)}</span>
        <span style="min-width:0"><span class="row-name">${esc(k.name)}</span>
        <span class="row-sub">${k.item_ids.length} item${k.item_ids.length === 1 ? '' : 's'} · ${
          blocked.length ? `${blocked.length} unavailable` : 'all ready'}${
          missing.length ? ` · ${missing.length} since retired` : ''}</span></span>
      </span>
      <i class="tally ${blocked.length ? 'out' : 'ready'}"></i>
    </div>
    ${k.notes ? `<div class="panel-b"><span class="row-sub">${esc(k.notes)}</span></div>` : ''}
    <div class="panel-b flush">
      ${k.item_ids.map(id => {
        const it = item(id); if (!it) return '';
        const st = statusOf(id);
        return `<button class="row ${st === 'ready' ? '' : 'dim'}" data-act="item" data-id="${id}">
          <i class="tally ${st}"></i>
          <span class="gear-i ${st}">${gearVisual(it)}</span>
          <span class="row-main"><span class="row-name">${esc(it.name)}${flagTag(it)}</span>
          <span class="row-sub">${esc(it.code)}${st !== 'ready' ? ' · ' + STATUS_TEXT[st] : ''}</span></span>
        </button>`;
      }).join('')}
    </div>
    <div class="panel-b btn-row">
      <button class="btn primary" data-act="cart-add-kit" data-id="${k.id}">Add to checkout</button>
      <button class="btn" data-act="kit-out" data-id="${k.id}">Check out now</button>
      <button class="btn" data-act="kit-res" data-id="${k.id}">Reserve</button>
    </div>
    ${isAdmin() ? `<div class="panel-b btn-row kit-acts">
      <button class="btn small" data-act="kit-edit" data-id="${k.id}">Edit</button>
      <button class="btn small danger" data-act="kit-del" data-id="${k.id}">Delete</button>
    </div>` : ''}
  </div>`;
}

/** Physical kits — cases Cheqroom already assembled, a flat list since none
    of them have a personal owner to group by. */
function view_kits() {
  const q = KIT_Q.trim();
  const kits = searchKits(S.kits.filter(k => k.type === 'kit'), q, {
    itemsFor: k => k.item_ids.map(i => item(i)).filter(Boolean)
  });
  return `
  <div class="lbl">Physical gear</div>
  <h2 style="margin:6px 0 14px">Kits</h2>
  <div class="field" style="margin-bottom:14px"><input id="kit-q" type="search"
    placeholder="Search kits — by name, or the gear inside" value="${esc(KIT_Q)}"></div>
  ${kits.length ? kits.map(kitPanel).join('') : `<div class="empty">${
    q ? `No kit matches “${esc(q)}”.`
      : 'No physical kits yet — import them from Admin, or ask an admin to add one.'}</div>`}`;
}

function view_admin() {
  const cfg = S.settings;
  const sw = (key, title, desc) => `<label class="switch">
    <span class="t"><span class="row-name">${title}</span><span class="d">${desc}</span></span>
    <input type="checkbox" data-setting="${key}" ${String(cfg[key]) === 'true' ? 'checked' : ''}>
  </label>`;

  return `
  <div class="lbl">Settings</div>
  <h2 style="margin:6px 0 14px">Admin</h2>

  <div class="panel">
    <div class="panel-h"><span class="lbl">Checkout rules</span></div>
    <div class="panel-b">
      ${sw('enforce_availability', 'Block unavailable gear', 'Stop checkouts of anything already out or down for repair. Off means it only warns.')}
      ${sw('enforce_reservations', 'Respect other people\'s holds', "Stop checkouts of gear reserved by someone else for those dates.")}
      ${sw('block_overdue_borrowers', 'Block overdue borrowers', 'Nobody can take more gear while they\'re sitting on something overdue.')}
      ${sw('send_receipts', 'Email a receipt on checkout', 'Confirmation listing what they took and when it\'s due.')}
      <div class="two" style="margin-top:14px">
        <div class="field"><label class="lbl" for="s-loan">Default loan days</label>
          <input id="s-loan" type="number" min="1" max="120" value="${esc(cfg.default_loan_days)}"></div>
        <div class="field"><label class="lbl" for="s-grace">Overdue grace days</label>
          <input id="s-grace" type="number" min="0" max="60" value="${esc(cfg.overdue_grace_days)}"></div>
      </div>
      <div class="two">
        <div class="field"><label class="lbl" for="s-hour">Reminder hour (24h, local)</label>
          <input id="s-hour" type="number" min="0" max="23" value="${esc(cfg.reminder_hour)}"></div>
        <div class="field"><label class="lbl" for="s-esc">CC admins after N days late</label>
          <input id="s-esc" type="number" min="1" max="30" value="${esc(cfg.escalate_after_days)}"></div>
      </div>
      <button class="btn primary wide" data-act="save-settings">Save settings</button>
    </div>
  </div>

  <div class="panel">
    <div class="panel-h"><span class="lbl">People</span>
      <span style="display:flex;gap:8px;align-items:center">
        <span class="mono" style="color:var(--dim)">${S.people.length}</span>
        <button class="btn small" data-act="new-person">Add person</button>
      </span>
    </div>
    <div class="panel-b flush">
      ${S.people.map(p => `<button class="row" data-act="person" data-id="${p.id}">
        <i class="tally ${p.blocked ? 'overdue' : 'ready'}"></i>
        ${personAvatar(p)}
        <span class="row-main">
          <span class="row-name">${esc(p.name || p.email)}${p.role === 'admin' ? ' · admin' : ''}</span>
          <span class="row-sub">${esc(p.email)}${p.blocked ? ` · blocked${p.blocked_reason ? ': ' + esc(p.blocked_reason) : ''}` : ''}</span>
        </span>
      </button>`).join('')}
    </div>
  </div>

  <div class="panel"><div class="panel-b">
    <div class="lbl" style="margin-bottom:8px">Audit log</div>
    <p style="color:var(--dim);font-size:13.5px;margin:0 0 12px">
      Every admin action and account change, in order — who deleted a kit,
      who overrode a block, who changed someone's role.</p>
    <button class="btn wide" data-act="audit-log">View audit log</button>
  </div></div>

  <div class="panel"><div class="panel-b">
    <div class="lbl" style="margin-bottom:8px">Usage report</div>
    <p style="color:var(--dim);font-size:13.5px;margin:0 0 12px">
      Checkouts and days out per item over a date range, plus how often
      something was wanted with nothing free to substitute.</p>
    <button class="btn wide" data-act="usage-report">View usage report</button>
  </div></div>

  <div class="panel"><div class="panel-b">
    <div class="lbl" style="margin-bottom:8px">Import from Cheqroom</div>
    <p style="color:var(--dim);font-size:13.5px;margin:0 0 12px">
      Bring over gear, then whatever's currently checked out or reserved. Column
      names are matched loosely, so most Cheqroom exports work untouched — you'll
      see a preview before anything is written.</p>
    <div class="btn-row">
      <button class="btn wide" data-act="import-items">Import gear</button>
      <button class="btn wide" data-act="import-orders">Import checkouts &amp; reservations</button>
    </div>
  </div></div>

  <div class="panel"><div class="panel-b">
    <div class="lbl" style="margin-bottom:8px">Reminders</div>
    <p style="color:var(--dim);font-size:13.5px;margin:0 0 12px">
      The daily batch runs at ${esc(cfg.reminder_hour)}:00 and is deduplicated, so triggering it by hand is safe.</p>
    <button class="btn wide" data-act="run-reminders">Send today's reminders now</button>
  </div></div>`;
}


/* Dates for the schedule list — short enough to scan, with the weekday, since
   "is it free on the Friday?" is the question people actually ask. */
const CAL_MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const CAL_WD  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function fmtDay(d) {
  const dt = new Date(d + 'T12:00:00Z');
  return `${CAL_WD[dt.getUTCDay()]} ${CAL_MON[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
}
const fmtSpan = (a, b) => (a === b ? fmtDay(a) : `${fmtDay(a)} → ${fmtDay(b)}`);

/**
 * Every date an item is booked or free, as a list rather than a picture.
 *
 * Bars are good for seeing shape and terrible for reading dates aloud, which
 * is what you're doing when someone asks whether they can have a camera next
 * week. Booked stretches and the gaps between them are interleaved in order,
 * so the answer reads straight down the column.
 */
function scheduleList(matches, bookings, from, to, { title, max = 12 } = {}) {
  if (!matches.length) {
    return `<div class="panel"><div class="empty">No gear matches these filters.</div></div>`;
  }

  const shown = matches.slice(0, max);
  const entries = itemSchedule({ items: shown, bookings, from, to });
  const show = CAL.listShow;

  const rows = entries.map(({ item: it, bookings: bs, gaps, days, freeDays, spanDays }) => {
    const st = statusOf(it.id);

    const booked = bs.map(b => {
      const late = b.kind === 'checkout' && !b.returned && b.due < today();
      const cls = b.kind === 'reservation' ? 'res' : b.returned ? 'done' : late ? 'late' : 'out';
      const verb = b.kind === 'reservation' ? 'Held for'
        : b.returned ? 'Was out with'
        : late ? 'Overdue with' : 'Out with';
      return {
        start: b.clippedStart,
        html: `<button class="sched-row" data-act="tl-open" data-kind="${b.kind}" data-id="${b.id}">
          <i class="tl-swatch ${cls}"></i>
          <span class="sched-when">${esc(fmtSpan(b.clippedStart, b.clippedEnd))}${
            b.runsInFrom ? ' <span class="sched-cont">(from earlier)</span>' : ''}${
            b.runsOnPast ? ' <span class="sched-cont">(continues)</span>' : ''}</span>
          <span class="sched-who">${esc(verb)} ${esc(b.person_name)}${
            bookingLabel(b) ? ` · ${esc(bookingLabel(b))}` : ''}</span>
          <span class="sched-len">${daysBetween(b.clippedStart, b.clippedEnd) + 1}d</span>
        </button>`
      };
    });

    const free = gaps.map(g => ({
      start: g.start,
      // Tapping a free stretch starts a reservation for exactly those dates.
      html: `<button class="sched-row free" data-act="res-from-gap" data-id="${it.id}"
                     data-start="${g.start}" data-end="${g.end}">
        <i class="tl-swatch ready"></i>
        <span class="sched-when">${esc(fmtSpan(g.start, g.end))}</span>
        <span class="sched-who">Free — tap to reserve</span>
        <span class="sched-len">${daysBetween(g.start, g.end) + 1}d</span>
      </button>`
    }));

    const lines = [
      ...(show === 'free' ? [] : booked),
      ...(show === 'booked' ? [] : free)
    ].sort((a, b) => a.start.localeCompare(b.start)).map(x => x.html).join('');

    return `<div class="sched-item">
      <button class="sched-head" data-act="item" data-id="${it.id}">
        <span class="gear-i ${st}">${gearVisual(it)}</span>
        <span class="row-main">
          <span class="row-name">${esc(it.name)}${flagTag(it)}</span>
          <span class="row-sub">${esc(it.code)} · ${esc(it.brand || it.category)}</span>
        </span>
        <span class="sched-total ${days ? '' : 'free'}">${days} booked · ${freeDays} free</span>
      </button>
      ${lines || `<div class="sched-none">Nothing to show with this filter.</div>`}
    </div>`;
  }).join('');

  return `
  <div class="panel sched">
    <div class="panel-h">
      <span class="lbl">${esc(title || "When it's spoken for")}</span>
      <span class="mono" style="color:var(--dim)">${from} → ${to} · ${daysBetween(from, to) + 1} days</span>
    </div>
    <div class="panel-b flush">${rows}</div>
    ${matches.length > max
      ? `<div class="sched-more">Showing ${max} of ${matches.length} items. Narrow by search or category to see the rest.</div>`
      : ''}
  </div>`;
}

/**
 * Day-column width, sized so the timeline fills the space it's given.
 *
 * Fixed sizes meant a 4K screen showed the same fortnight as a laptop with
 * two thirds of the window empty, while a month still scrolled sideways.
 * This measures what's actually available and divides it up, clamped at both
 * ends: never so narrow the date is unreadable, never so wide a single week
 * sprawls across a wall.
 */
function cellWidth() {
  const w = window.innerWidth;
  const narrow = w < 640;
  const month = CAL.span === 'month';

  const rail = w >= 1800 ? 212 : w >= 900 ? 186 : 0;
  const pad = (narrow ? 16 : w >= 2300 ? 32 : w >= 1500 ? 28 : 24) * 2;
  const nameCol = narrow ? 98 : 124;
  const days = CAL.days || (month ? 31 : 14);

  const ideal = Math.floor((w - rail - pad - nameCol) / days);
  const min = month ? (narrow ? 24 : 28) : (narrow ? 31 : 34);
  const max = month ? 54 : 76;
  return Math.max(min, Math.min(max, ideal));
}

/**
 * The resolved window. Month mode snaps to the 1st and runs the length of that
 * month, so "next" lands on the next month rather than 30 days later.
 */
function calWindow() {
  const anchor = CAL.from || S.today;
  if (CAL.span === 'month') {
    const first = startOfMonth(anchor);
    const [y, m] = first.split('-').map(Number);
    return { from: first, days: daysInMonth(y, m) };
  }
  return { from: anchor, days: CAL.span };
}

function view_calendar() {
  const { from, days } = calWindow();
  CAL.days = days;                       // loadCalendar pads around this
  const to = shiftDate(from, days - 1);

  const spans = [
    { v: 7,       label: '1 week' },
    { v: 14,      label: '2 weeks' },
    { v: 28,      label: '4 weeks' },
    { v: 'month', label: 'Month' }
  ];
  const scopes = [
    { v: 'booked', label: 'Booked' },
    { v: 'outnow', label: 'Out now' },
    { v: 'all',    label: 'Every item' }
  ];

  const live = S.items.filter(i => !i.retired);
  const cats = ['All', ...new Set(live.map(i => i.category))].sort((a, b) =>
    a === 'All' ? -1 : b === 'All' ? 1 : a.localeCompare(b));

  // Gear search narrows both boards and drives the schedule list below them.
  const gearQuery = CAL.gear.trim();
  const gearMatches = gearQuery ? searchItems(live, gearQuery) : null;
  const gearIds = gearMatches ? new Set(gearMatches.map(i => i.id)) : null;

  const itemFilter = i =>
    (CAL.cat === 'All' || i.category === CAL.cat) && (!gearIds || gearIds.has(i.id));
  const outNowIds = new Set(S.openCheckouts.flatMap(c => c.item_ids));
  const bookings = CAL.bookings || bookingsFromState(S);

  // The list reports over its own period, which defaults to everything loaded
  // rather than the fortnight on screen.
  const listFrom = CAL.rangeFrom || CAL.loadedFrom || from;
  const listTo = CAL.rangeTo || CAL.loadedTo || to;
  const listItems = live
    .filter(itemFilter)
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  /* Load layers — one strip per category, independent of each other.
     Kept separate rather than pooled on purpose: there are far more lighting
     items than cameras, so a single combined strip would let the lights mask
     a day where every body was already out. Each layer is scaled against its
     own category, so "half the cameras are gone" reads as half.

     Measured against the whole category, not the filtered view — "how tight
     is Thursday" is a question about the fleet, not about what's on screen. */
  const HEAT_LAYERS = [
    { key: 'cameras', label: 'Cameras' },
    { key: 'lighting', label: 'Lighting' }
  ];
  const heatDays = dayList(from, days);
  const allMaintenance = S.openMaintenance.concat(S.closedMaintenance || []);

  const heat = CAL.heat
    ? HEAT_LAYERS
        .filter(l => CAL.heatGroups[l.key])
        .map(l => ({ ...l, items: itemsInGroups(live, [l.key]) }))
        .filter(l => l.items.length)
        .map(l => ({
          label: l.label,
          load: dailyLoad({
            items: l.items, bookings, maintenance: allMaintenance, days: heatDays
          })
        }))
    : null;

  const body = CAL.loading
    ? `<div class="empty">Loading the board…</div>`
    : CAL.group === 'agenda'
      ? renderAgenda({ state: S, bookings, from, days, itemFilter })
    : CAL.group === 'list'
      ? scheduleList(
          gearMatches || listItems,
          bookings,
          listTo < listFrom ? listFrom : listFrom,
          listTo < listFrom ? listFrom : listTo,
          { title: 'Every item, booked and free', max: 40 }
        )
    : CAL.group === 'checkout'
      ? renderCheckoutBoard({
          state: S, bookings, from, days, cell: cellWidth(),
          itemFilter, highlight: CAL.hi, heat
        })
      : renderBoard({
          state: S, bookings, from, days, cell: cellWidth(),
          scope: CAL.scope, outNowIds, itemFilter, highlight: CAL.hi, heat
        });

  const title = CAL.span === 'month' ? monthLabel(from) : `${from} → ${to}`;
  const stepUnit = CAL.span === 'month' ? 'month' : 'days';

  return `
  <div class="lbl">What's out and when</div>
  <h2 style="margin:6px 0 14px">Calendar</h2>

  <div class="tl-bar-head">
    <div class="btn-row">
      <button class="btn small" data-act="cal-shift" data-by="-1" data-unit="${stepUnit}" aria-label="Previous">◀</button>
      <button class="btn small" data-act="cal-today">Today</button>
      <button class="btn small" data-act="cal-shift" data-by="1" data-unit="${stepUnit}" aria-label="Next">▶</button>
    </div>
    <span class="tl-range">${esc(title)}</span>
  </div>

  <div class="cal-searches">
    <div class="cal-find">
      <input id="cal-gear" type="search" placeholder="Search gear — pyxis, sigma, camera"
             value="${esc(CAL.gear)}" autocomplete="off" spellcheck="false">
      ${gearQuery ? `<button class="btn small" data-act="cal-gear-clear">Clear</button>` : ''}
    </div>
    <div class="cal-find">
      <input id="cal-find" type="search" placeholder="Jump to a day — friday, aug 14, aug 14 to aug 20"
             value="${esc(CAL.find)}" autocomplete="off" spellcheck="false">
      ${CAL.hi ? `<button class="btn small" data-act="cal-find-clear">Clear</button>` : ''}
    </div>
  </div>
  ${CAL.hi
    ? `<div class="cal-found">Showing <strong>${esc(CAL.hi.label)}</strong>${
        CAL.hi.start !== CAL.hi.end ? ` · ${daysBetween(CAL.hi.start, CAL.hi.end) + 1} days` : ''}</div>`
    : CAL.findErr
      ? `<div class="cal-found bad">Couldn't read that as a date. Try "friday", "aug 14", "8/14" or "aug 14 to aug 20".</div>`
      : ''}

  <div class="chips" style="margin:12px 0 8px">
    ${spans.map(s2 => `<button class="chip" data-act="cal-span" data-span="${s2.v}"
      aria-pressed="${String(CAL.span) === String(s2.v)}">${s2.label}</button>`).join('')}
  </div>

  <div class="chips" style="margin-bottom:8px">
    <button class="chip" data-act="cal-group" data-group="agenda"
      aria-pressed="${CAL.group === 'agenda'}">Agenda</button>
    <button class="chip" data-act="cal-group" data-group="checkout"
      aria-pressed="${CAL.group === 'checkout'}">By checkout</button>
    <button class="chip" data-act="cal-group" data-group="item"
      aria-pressed="${CAL.group === 'item'}">By item</button>
    <button class="chip" data-act="cal-group" data-group="list"
      aria-pressed="${CAL.group === 'list'}">List</button>
    ${CAL.group === 'item' ? scopes.map(s2 => `<button class="chip sep" data-act="cal-scope" data-scope="${s2.v}"
      aria-pressed="${CAL.scope === s2.v}">${s2.label}</button>`).join('') : ''}
    ${CAL.group === 'list' ? [
      { v: 'both', label: 'Booked + free' },
      { v: 'booked', label: 'Booked only' },
      { v: 'free', label: 'Free only' }
    ].map(s2 => `<button class="chip sep" data-act="cal-listshow" data-show="${s2.v}"
      aria-pressed="${CAL.listShow === s2.v}">${s2.label}</button>`).join('') : ''}
  </div>

  ${CAL.group === 'list' ? `
  <div class="cal-range">
    <span class="lbl">Dates</span>
    <input id="cal-from" type="date" value="${esc(listFrom)}" max="${esc(listTo)}">
    <span class="cal-range-arrow">→</span>
    <input id="cal-to" type="date" value="${esc(listTo)}" min="${esc(listFrom)}">
    ${(CAL.rangeFrom || CAL.rangeTo)
      ? `<button class="btn small" data-act="cal-range-clear">Reset</button>`
      : `<span class="cal-range-hint">everything loaded</span>`}
  </div>` : ''}

  <div class="chips" style="margin-bottom:12px">
    ${cats.map(c => `<button class="chip" data-act="cal-cat" data-cat="${esc(c)}"
      aria-pressed="${CAL.cat === c}">${esc(c)}</button>`).join('')}
  </div>

  ${CAL.group === 'agenda' ? '' : `
  <div class="chips" style="margin-bottom:12px">
    <button class="chip" data-act="cal-heat" aria-pressed="${CAL.heat}">How busy</button>
    ${CAL.heat ? `
      <button class="chip sep" data-act="cal-heat-group" data-group="cameras"
        aria-pressed="${CAL.heatGroups.cameras}">Cameras</button>
      <button class="chip" data-act="cal-heat-group" data-group="lighting"
        aria-pressed="${CAL.heatGroups.lighting}">Lighting</button>` : ''}
  </div>
  ${CAL.heat && heat && !heat.length ? `<div class="cal-found bad">
    Turn on Cameras or Lighting to see how busy each day is.</div>` : ''}
  ${heat?.length ? `<div class="heat-key">
    <span class="lbl">Free per day</span>
    <span class="heat-scale">
      <i class="heat-sw free"></i><i class="heat-sw easy"></i><i class="heat-sw moderate"></i><i class="heat-sw busy"></i><i class="heat-sw tight"></i>
    </span>
    <span class="row-sub">all free → very tight · each layer scaled to its own category</span>
  </div>` : ''}`}

  ${gearQuery && !CAL.loading && CAL.group !== 'list'
    ? scheduleList(gearMatches, bookings, listFrom, listTo)
    : ''}

  ${body}

  <div class="tl-legend">
    <span><i class="tl-swatch out"></i>Out on set</span>
    <span><i class="tl-swatch late"></i>Overdue</span>
    <span><i class="tl-swatch res"></i>Reserved</span>
    <span><i class="tl-swatch done"></i>Returned</span>
  </div>`;
}

async function loadCalendar() {
  const { from, days } = calWindow();
  // Pull a wider range than shown so paging left or right is instant.
  const pad = Math.max(days, 31);
  let loadFrom = shiftDate(from, -pad);
  let loadTo = shiftDate(from, days + pad);

  // The list can be pointed at any period. Widen the fetch to cover it, or it
  // would report days as free purely because nothing was loaded for them.
  if (CAL.rangeFrom && CAL.rangeFrom < loadFrom) loadFrom = CAL.rangeFrom;
  if (CAL.rangeTo && CAL.rangeTo > loadTo) loadTo = CAL.rangeTo;
  CAL.loading = !CAL.bookings;
  try {
    const r = await GET(`/api/calendar?from=${loadFrom}&to=${loadTo}`);
    CAL.bookings = r.bookings;
    CAL.loadedFrom = loadFrom;
    CAL.loadedTo = loadTo;
  } catch (err) {
    toast(err.message, true);
    CAL.bookings = bookingsFromState(S);
  }
  CAL.loading = false;
  if (TAB === 'calendar') render();
}

/** Move the window so a searched day or range is visible. */
function focusRange(range) {
  const { days } = calWindow();
  if (CAL.span === 'month') { CAL.from = startOfMonth(range.start); return; }
  const span = daysBetween(range.start, range.end) + 1;
  // Centre a short range; for a long one just start at its first day.
  CAL.from = span >= days ? range.start : shiftDate(range.start, -Math.floor((days - span) / 2));
}

/**
 * A chip row (category filters, status filters, the Available/Everything
 * toggle) can overflow horizontally on a narrow screen, and a row cut off
 * mid-chip reads as clipped rather than "swipe for more" — nothing on
 * screen says there's anything past the edge. A right-edge fade appears
 * only when a row actually has more to scroll to, and clears once you've
 * scrolled to the end, so a row that already shows everything is never
 * faded for no reason.
 */
function updateChipHint(el) {
  const more = el.scrollWidth > el.clientWidth + 1 &&
    el.scrollLeft < el.scrollWidth - el.clientWidth - 1;
  el.classList.toggle('has-more', more);
}
function paintChipScrollHints() {
  $$('.chips').forEach(el => {
    updateChipHint(el);
    if (el._scrollHintBound) return;
    el._scrollHintBound = true;
    el.addEventListener('scroll', () => updateChipHint(el), { passive: true });
  });
}
window.addEventListener('resize', () => paintChipScrollHints());

/* ================================ sheets ================================ */

function openSheet(html) {
  $('#sheet').innerHTML = html;
  $('#sheet').classList.add('open');
  $('#scrim').classList.add('open');
  $('#sheet').scrollTop = 0;
  paintChipScrollHints();
}
function closeSheet() {
  $('#sheet').classList.remove('open');
  $('#scrim').classList.remove('open');
  SHEET_BOOKING = null;
  /* Closing ends the interaction, so the panels start shut next time —
     otherwise an open swap picker follows you onto the next booking. */
  ADD_OPEN = false; ASK_OPEN = false; SWAP_OPEN = false; ADD_Q = '';
  stopCam();
}

function blockList(blocks, kind = '') {
  if (!blocks?.length) return '';
  return blocks.map(b => `<div class="alert ${b.overridden ? 'warn' : ''}"><div>
    <div class="lbl">${b.overridden ? 'Overridden' : (kind || 'Blocked')}</div>${esc(b.message)}</div></div>`).join('');
}

async function sheet_item(id) {
  const it = item(id);
  if (!it) return;
  const st = statusOf(it.id);
  const c = openOut(it.id);
  const m = downFor(it.id);
  const holds = S.reservations.filter(r => r.item_ids.includes(it.id) && r.end_on >= today());

  openSheet(`
    <div class="sheet-h">
      <span style="display:flex;align-items:center;gap:12px;min-width:0">
        <span class="gear-i large ${st}">${gearVisual(it)}</span>
        <div><div class="lbl">${esc(it.category)}</div>
        <h2>${esc(it.name)}</h2>
        <div class="mono" style="color:var(--dim)">${esc(it.code)}${it.serial ? ' · ' + esc(it.serial) : ''}</div></div>
      </span>
      <button class="btn small" data-act="close-sheet">Close</button>
    </div>

    <div class="alert ${st === 'ready' ? 'ok' : st === 'repair' || st === 'overdue' ? '' : 'warn'}">
      <div><div class="lbl">${STATUS_TEXT[st]}</div>
      ${c ? `${esc(c.holder_name || c.holder_email)} · due ${c.due_on}`
        : m ? `${esc(m.kind)}${m.notes ? ' · ' + esc(m.notes) : ''}`
        : st === 'held' ? `Held for ${esc(heldNow(it.id).person_name)}`
        : 'Ready to go out'}</div>
    </div>

    <div class="btn-row" style="margin-bottom:14px">
      ${!c && !m ? `<button class="btn primary" data-act="cart-add" data-id="${it.id}">${
        cartHas(CART, it.id) ? 'In your checkout' : 'Add to checkout'}</button>` : ''}
      ${!c && !m ? `<button class="btn" data-act="new-checkout" data-id="${it.id}">Check out now</button>` : ''}
      ${c ? `<button class="btn primary" data-act="checkout" data-id="${c.id}">Check in / extend</button>` : ''}
      <button class="btn" data-act="new-res" data-id="${it.id}">Reserve</button>
      ${m ? `<button class="btn" data-act="close-maint" data-id="${m.id}">Mark fixed</button>`
          : `<button class="btn" data-act="new-maint" data-id="${it.id}">Log a problem</button>`}
      ${st !== 'ready' ? `<button class="btn ${it.watching ? 'primary' : ''}" data-act="toggle-watch" data-id="${it.id}">${
        it.watching ? 'Watching — stop' : "Notify me when it's free"}</button>` : ''}
    </div>

    <dl style="margin:0 0 14px">
      <div class="kv"><dt>Brand</dt><dd>${esc(it.brand || '—')}</dd></div>
      ${it.model ? `<div class="kv"><dt>Model</dt><dd>${esc(it.model)}</dd></div>` : ''}
      <div class="kv"><dt>Serial</dt><dd>${esc(it.serial || '—')}</dd></div>
      <div class="kv"><dt>Code</dt><dd>${esc(it.code)}</dd></div>
      ${it.notes ? `<div class="kv"><dt>Notes</dt><dd>${esc(it.notes)}</dd></div>` : ''}
    </dl>

    ${holds.length ? `<div class="lbl">Upcoming holds</div>
      <div class="panel"><div class="panel-b flush">${holds.map(r =>
        `<div class="row static"><span class="row-main">
          <span class="row-name">${esc(r.person_name || r.person_email)}</span>
          <span class="row-sub">${r.start_on} → ${r.end_on}${
            bookingLabel(r) ? ' · ' + esc(bookingLabel(r)) : ''}</span>
        </span></div>`).join('')}</div></div>` : ''}

    <div class="lbl">Trip history</div>
    <div class="panel"><div class="panel-b flush" id="hist"><div class="empty">Loading…</div></div></div>

    ${isAdmin() ? `<div class="btn-row">
      <button class="btn" data-act="edit-item" data-id="${it.id}">Edit</button>
      <button class="btn danger" data-act="retire-item" data-id="${it.id}">Retire</button>
    </div>` : ''}`);

  try {
    const { history } = await GET(`/api/history/${it.id}`);
    const box = $('#hist');
    if (!box) return;
    box.innerHTML = history.length ? history.map(h => `<div class="row static">
      <span class="row-main"><span class="row-name">${esc(h.name || h.email)}</span>
      <span class="row-sub">${h.out_at} → ${h.returned_at || 'still out'}${
        bookingLabel(h) ? ' · ' + esc(bookingLabel(h)) : ''}</span></span>
    </div>`).join('') : `<div class="empty">Never been out.</div>`;
  } catch { /* sheet may have closed */ }
}

function pickRows(ids, preselect = []) {
  return ids.map(id => {
    const it = item(id);
    if (!it) return '';
    const st = statusOf(id);
    const blocked = st !== 'ready';
    return `<label class="check ${blocked ? 'blocked' : ''}">
      <input type="checkbox" class="pick" value="${id}" ${preselect.includes(id) ? 'checked' : ''}>
      <span class="gear-i ${st}">${gearVisual(it)}</span>
      <span class="n">${esc(it.name)}${flagTag(it)}<span class="row-sub">${esc(it.code)}${blocked ? ' · ' + STATUS_TEXT[st] : ''}</span></span>
      <i class="tally ${st}"></i>
    </label>`;
  }).join('');
}
const picked = () => $$('.pick').filter(c => c.checked).map(c => Number(c.value));

/**
 * A second, lighter picker for adding gear to something that already
 * exists (an open checkout, a live hold) — deliberately not the create-flow
 * PICK machinery above, which assumes it owns the whole sheet's dates and
 * holder fields. This only ever needs "what else should join this", so it
 * gets its own small search + checklist using a different class (.add-pick)
 * so it can't be confused with the create-flow's own .pick boxes if both
 * ever ended up on screen at once.
 */
let ADD_Q = '';
let ADD_OPEN = false;   // is the add-gear list unrolled?
let ASK_OPEN = false;   // is the ask-to-add picker unrolled?
let SWAP_OPEN = false;  // is the swap-offer picker unrolled?
let SWAP_SRC = 'mine';  // 'mine' | 'free' — where the offered half comes from
let SWAP_Q = '';        // search, when offering free gear
/* Which conflicting item (if any) has its "choose a different item" search
   open — one at a time, an accordion rather than one per clash. Falls back
   to any free item when swapCandidates finds nothing close enough. */
let CUSTOM_SWAP_FOR = null;
let CUSTOM_SWAP_Q = '';
/* Items swapped away from while building this checkout/reservation. They
   never end up in the final item_ids — that's the point of a swap — so the
   server's own "was this blocked?" check never sees them and never gets a
   chance to log the demand they represent. Sent alongside the submit so the
   server can check the *original* item's availability independently of
   whatever the swapped-in replacement's fate turns out to be. */
let SWAPPED_OUT = [];
/* Which item a maintenance ticket is being logged against, and what's typed
   into the search box while it's still unpicked — search-then-pick, the
   same pattern the swap picker above uses, rather than a single <select>
   holding one <option> per item in the whole cage. */
let MAINT_ITEM_ID = null;
let MAINT_ITEM_Q = '';
let NEW_RES_CREW = [];  // teammates picked while building a reservation
/* Which kit started this reservation, first one wins — same rule as
   setCartKit(), just without a persisted cart to carry it in. */
let NEW_RES_KIT_ID = null;
/* Set while re-rendering a sheet in place. Without it, redrawing to show a
   panel resets the very flag that asked for it — which has now bitten three
   separate toggles. */
let SHEET_REDRAW = false;
let SHEET_BOOKING = null;   // {kind, id} of the booking the open sheet shows
/* Whether a booking's item list is unrolled — collapsed by default when it
   started from a kit or package, so "Gimbal Rig" is what you see rather
   than five names you'd have to scroll past to find the one you came for. */
let BOOKING_ITEMS_OPEN = false;

/* The running checkout. Holds intentions, not bookings — nothing here takes
   gear off the shelf until the checkout is confirmed and the server re-checks
   the lot. Persisted per person so going to look at whoever you're clashing
   with doesn't cost you the list you were building. */
let CART = emptyCart();

function cartSave() {
  CART = saveCart(S.me?.id, CART);
  paintCart();
}

function paintCart() {
  const btn = $('#hdr-cart');
  const n = $('#hdr-cart-n');
  if (!btn || !n) return;
  const count = cartCount(CART);
  /* Always there, so the way to a checkout doesn't appear out of nowhere —
     but it only lights up once it holds something. An empty cart shouting in
     the accent colour is a call to action with nothing behind it. */
  btn.classList.toggle('has-items', count > 0);
  n.hidden = count === 0;
  n.textContent = String(count);
  btn.title = count
    ? `${count} item${count === 1 ? '' : 's'} ready to check out`
    : 'Your checkout is empty';
}

/** Add gear from anywhere, and say so — the button is in the header, not here. */
function cartAdd(ids, label) {
  const before = cartCount(CART);
  CART = addToCart(CART, ids);
  cartSave();
  const added = cartCount(CART) - before;
  if (!added) return toast(`${label || 'That'} is already in your checkout`);
  toast(`Added ${label || `${added} item${added === 1 ? '' : 's'}`} — ${cartCount(CART)} in your checkout`);
}

/**
 * Pull the picker's current state into the cart. Anything that changes what's
 * ticked without the browser's own checkbox-click event firing — the kit and
 * package dropdowns being the case that actually happens — has to call this
 * itself, or the cart silently falls behind what's on screen until the next
 * real click on a checkbox catches it up. On the review screen there are no
 * tick boxes — the list *is* the cart — so only the picker rewrites items.
 * Both screens own the dates.
 */
function syncCartFromPicker() {
  const onPicker = Boolean($('#pick-list'));
  CART = {
    ...CART,
    items: onPicker ? picked() : CART.items,
    due: $('#co-due')?.value || '',
    shoot: $('#co-shoot')?.value || '',
    project: $('#co-project')?.value || ''
  };
  cartSave();
}
let ADD_EXCLUDE = [];   // gear already on whatever's being edited, set before paintAddList's first call
const pickedAdd = () => $$('.add-pick').filter(c => c.checked).map(c => Number(c.value));

/** Static shell — search box plus an empty list `paintAddList` fills in. */
/* Closed by default: the whole inventory unrolled under every booking you
   opened, so reading what went out on Thursday meant scrolling past 459 rows
   you weren't there to change.
   Its own element, so opening it swaps this block alone — redrawing the whole
   sheet would reset the very flag the toggle had just set. */
function addGearBlock(addAction, addId) {
  return `<div id="add-gear-block">${addGearInner(addAction, addId)}</div>`;
}

function addGearInner(addAction, addId) {
  if (!ADD_OPEN) {
    return `<button class="btn wide" data-act="add-gear-open" style="margin:14px 0 4px">Add gear</button>`;
  }
  return `
    <div class="pick-h" style="margin:14px 0 4px">
      <span class="lbl">Add gear</span>
      <button class="btn small" data-act="add-gear-open">Close</button>
    </div>
    ${addAction ? `<button class="btn primary wide" data-act="${addAction}" data-id="${addId}"
      style="margin-bottom:8px">Add<span id="ask-count"></span></button>` : ''}
    <input id="add-q" type="search" class="pick-q"
      placeholder="Search gear — name, brand, code" value="${esc(ADD_Q)}" autocomplete="off">
    <div id="add-list" style="max-height:30vh;overflow-y:auto;margin:8px 0 4px"></div>`;
}

/**
 * `excludeIds` — gear already on this checkout/hold, left off the list
 * (adding something already there is a no-op, not a choice to make).
 * Ticked items stay ticked across a search the same way the create-flow
 * picker does — see paintPickList's `keep`.
 */
function paintAddList(excludeIds, preselect = null) {
  const box = $('#add-list');
  if (!box) return;
  const keep = preselect ?? pickedAdd();
  const q = ADD_Q.trim();
  const candidates = S.items.filter(i => !i.retired && !excludeIds.includes(i.id));
  const matched = q ? searchItems(candidates, q) : candidates;
  const shown = new Set(matched.map(i => i.id));
  const extras = candidates.filter(i => keep.includes(i.id) && !shown.has(i.id));
  const list = [...matched, ...extras];

  box.innerHTML = list.length ? list.map(i => {
    const st = statusOf(i.id);
    return `<label class="check">
      <input type="checkbox" class="add-pick" value="${i.id}" ${keep.includes(i.id) ? 'checked' : ''}>
      <span class="gear-i ${st}">${gearVisual(i)}</span>
      <span class="n">${esc(i.name)}${flagTag(i)}<span class="row-sub">${esc(i.code)}${st !== 'ready' ? ' · ' + STATUS_TEXT[st] : ''}</span></span>
      <i class="tally ${st}"></i>
    </label>`;
  }).join('') : `<div class="empty">${q ? `Nothing matches “${esc(q)}”.` : 'Nothing else in the cage.'}</div>`;
}

/* ------------------------------------------------- the gear picker's filter */

/** The window the sheet is currently asking about. */
function pickWindow() {
  const rStart = $('#r-start')?.value, rEnd = $('#r-end')?.value;
  if (rStart && rEnd) return [rStart, rEnd];
  const due = $('#co-due')?.value || today();
  return [today(), due < today() ? today() : due];
}

/**
 * Whether an item is free, which means something different depending on what's
 * being asked. A checkout starts now, so anything already out blocks it
 * whatever its due date. A reservation is for a future window, so gear that's
 * out but back in time is fair game.
 *
 * Overdue gear blocks both: there's no honest return date to book around.
 *
 * Advisory only — src/policy.js on the server is what actually decides.
 */
function availabilityTest(start, end, holderId) {
  const bookings = bookingsFromState(S);
  return id => {
    if (downFor(id)) return false;
    const loan = openOut(id);
    if (loan && loan.due_on < today()) return false;
    if (PICK_CTX === 'checkout' && loan) return false;
    return !collisions({ itemIds: [id], start, end, bookings })
      // Your own hold isn't a clash — collecting it is the point.
      .some(b => !(b.kind === 'reservation' && b.person_id === holderId));
  };
}

/** <option> markup shared by the picker's package and kit quick-add
    dropdowns. */
function quickKitOptions(kits) {
  return kits.map(k => {
    const ids = k.item_ids.filter(i => item(i));
    const blocked = ids.filter(i => statusOf(i) !== 'ready').length;
    return `<option value="${k.id}">${esc(k.name)} — ${ids.length} item${ids.length === 1 ? '' : 's'}${
      blocked ? ` · ${blocked} unavailable` : ''}</option>`;
  }).join('');
}

/**
 * Curated presets, broken out from the physical kits below them — a shoot is
 * more often "start from the interview package" than "start from a case of
 * gear", so this comes first. A dropdown and an Add button, the same shape
 * as the "Share with" control below — pick one, tap Add, it stacks onto
 * whatever is already ticked, same as before.
 */
function packagePickSection() {
  const packages = S.kits.filter(k => k.type === 'package').slice()
    .sort((a, b) => (kitIsMine(b) - kitIsMine(a)) || a.name.localeCompare(b.name));
  if (!packages.length) return '';
  return `
    <div class="pick-h" style="margin:0 0 4px"><span class="lbl">Start from a package</span></div>
    <div class="kit-add-row" style="margin-bottom:14px">
      <select id="pkg-start-pick">
        <option value="">Choose a package…</option>
        ${quickKitOptions(packages)}
      </select>
      <button class="btn primary" id="pkg-start-add" data-act="add-kit" disabled>Add</button>
    </div>`;
}

/** Physical kits — no personal owner, so no "yours first" sort, just name. */
function kitPickSection() {
  const kits = S.kits.filter(k => k.type === 'kit').slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!kits.length) return '';
  return `
    <div class="pick-h" style="margin:0 0 4px"><span class="lbl">Kits</span></div>
    <div class="kit-add-row" style="margin-bottom:14px">
      <select id="kit-start-pick">
        <option value="">Choose a kit…</option>
        ${quickKitOptions(kits)}
      </select>
      <button class="btn primary" id="kit-start-add" data-act="add-kit" disabled>Add</button>
    </div>`;
}

function pickListBlock() {
  return `
    ${packagePickSection()}
    ${kitPickSection()}
    <div id="pick-selected"></div>
    <div class="pick-h">
      <span class="lbl">Gear</span>
      <span class="chips tight">
        <button class="chip" data-act="pick-avail" data-avail="free">Available</button>
        <button class="chip" data-act="pick-avail" data-avail="all">Everything</button>
      </span>
    </div>
    <input id="pick-q" type="search" class="pick-q"
      placeholder="Search gear — name, brand, code" value="${esc(PICK_Q)}" autocomplete="off">
    <div id="pick-meta" class="pick-meta"></div>
    <div id="pick-list" class="pick-list"></div>
    <div id="swaps"></div>`;
}

/**
 * What you've actually got so far, above the 459-row haystack it came from.
 * Ticking something off in the big list works fine when it's on screen, but
 * gear added via a kit or an earlier search scrolls out of view — this is
 * the one place you can always find it and take it back off, conflict or
 * not. Reuses `drop-item`: removing a clashing item and removing a fine one
 * are the same action from the cart's point of view.
 */
function paintSelected(keep) {
  const box = $('#pick-selected');
  if (!box) return;
  if (!keep.length) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="lbl" style="margin:10px 0 6px">${keep.length} selected</div>
    <div class="panel" style="margin-bottom:10px"><div class="panel-b flush">${keep.map(id => {
      const it = item(id);
      if (!it) return '';
      const st = statusOf(id);
      return `<div class="row-wrap"><div class="row static">
        <i class="tally ${st}"></i>
        <span class="gear-i ${st}">${iconFor(it)}</span>
        <span class="row-main">
          <span class="row-name">${esc(it.name)}${flagTag(it)}</span>
          <span class="row-sub">${esc(it.code)}${st !== 'ready' ? ' · ' + STATUS_TEXT[st] : ''}</span>
        </span>
      </div>
      <button class="row-add" data-act="drop-item" data-id="${id}"
        title="Remove ${esc(it.name)}" aria-label="Remove ${esc(it.name)}">×</button></div>`;
    }).join('')}</div></div>`;
}

/**
 * Render the gear checklist. Re-run whenever the dates, the holder or the
 * filter change. Anything already ticked stays on screen even when it fails
 * the filter, so the list can never silently drop a selection.
 */
function paintPickList(preselect = null) {
  const box = $('#pick-list');
  if (!box) return;

  const keep = preselect ?? picked();
  const [start, end] = pickWindow();
  const holderId = Number($('#co-holder')?.value || $('#r-person')?.value) || S.me.id;
  const isFree = availabilityTest(start, end, holderId);

  const live = S.items.filter(i => !i.retired);
  const freeCount = live.filter(i => isFree(i.id)).length;

  const q = PICK_Q.trim();
  const matched = q ? searchItems(live, q) : live;
  const base = PICK_AVAIL === 'free'
    ? matched.filter(i => isFree(i.id) || keep.includes(i.id))
    : matched;
  /* Whatever is ticked stays on screen even when it fails the search or the
     filter — a list that quietly drops something out of your cart is worse
     than a list with an extra row in it. */
  const shown = new Set(base.map(i => i.id));
  const extras = live.filter(i => keep.includes(i.id) && !shown.has(i.id));
  const list = [...base, ...extras];

  box.innerHTML = list.length ? list.map(i => {
    const free = isFree(i.id);
    const st = statusOf(i.id);
    const loan = openOut(i.id);
    const why = free ? ''
      : downFor(i.id) ? `down · ${downFor(i.id).kind.toLowerCase()}`
      : loan ? `out with ${loan.holder_name || loan.holder_email} · due ${loan.due_on}`
      : PICK_CTX === 'reserve' ? 'booked over those dates' : 'held by someone else';
    /* Ticked *and* unavailable is the case worth shouting about: it's what
       stops the checkout, so it's red rather than merely dimmed. */
    const conflict = !free && keep.includes(i.id);
    return `<label class="check ${free ? '' : 'blocked'} ${conflict ? 'conflict' : ''}">
      <input type="checkbox" class="pick" value="${i.id}" ${keep.includes(i.id) ? 'checked' : ''}>
      <span class="gear-i ${st}">${gearVisual(i)}</span>
      <span class="n">${esc(i.name)}${flagTag(i)}<span class="row-sub">${esc(i.code)}${why ? ' · ' + esc(why) : ''}</span></span>
      <i class="tally ${st}"></i>
    </label>`;
  }).join('') : `<div class="empty">${q
    ? `Nothing matches “${esc(q)}”${PICK_AVAIL === 'free' ? ' and is free' : ''}.`
    : `Nothing is free ${PICK_CTX === 'reserve' ? 'for those dates' : 'right now'}.
       Switch to Everything to book over something, or try other dates.`}</div>`;

  const meta = $('#pick-meta');
  if (meta) {
    const parts = [`${freeCount} of ${live.length} free ${
      PICK_CTX === 'reserve' ? 'for these dates' : 'right now'}`];
    if (q) parts.push(`${base.length} match “${q}”`);
    if (extras.length) parts.push(`${extras.length} selected shown below`);
    meta.textContent = parts.join(' · ');
  }
  $$('[data-act="pick-avail"]').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.avail === PICK_AVAIL)));
  paintSelected(keep);
  paintSwaps(keep, isFree);
}

/**
 * For each thing you've ticked that isn't available, offer the identical unit
 * sitting on the shelf. "The C-stand you picked is out, but #7 is free" is the
 * answer people actually want — knowing there's a conflict is only half of it.
 */
/** Recompute the Conflicts panel alone, leaving the gear list where it is. */
function refreshSwaps() {
  if (!$('#swaps')) return;
  const [start, end] = pickWindow();
  const holderId = Number($('#co-holder')?.value || $('#r-person')?.value) || S.me.id;
  paintSwaps(picked(), availabilityTest(start, end, holderId));
}

function paintSwaps(keep, isFree) {
  const box = $('#swaps');
  if (!box) return;
  const stuck = keep.map(id => item(id)).filter(i => i && !isFree(i.id));
  SWAP_IDS = new Set(stuck.map(i => i.id));
  if (!stuck.length) { box.innerHTML = ''; return; }

  const live = S.items.filter(i => !i.retired);
  box.innerHTML = `<div class="lbl" style="margin:12px 0 6px">Conflicts</div>` + stuck.map(i => {
    const spares = swapCandidates(i, live, { isFree: c => isFree(c.id), limit: 3 });
    const loan = openOut(i.id);
    const why = downFor(i.id) ? `down · ${downFor(i.id).kind.toLowerCase()}`
      : loan ? `out with ${loan.holder_name || loan.holder_email} · due ${loan.due_on}`
      : PICK_CTX === 'reserve' ? 'booked over those dates' : 'held by someone else';
    return `<div class="swap">
      <div class="swap-h"><span class="row-name">${esc(i.name)}${flagTag(i)}</span>
        <span class="row-sub">${esc(i.code)} · ${esc(why)}</span></div>
      ${spares.length ? `<div class="swap-opts">${spares.map(s =>
        `<button class="btn small swap-opt" data-act="swap-item" data-id="${i.id}" data-to="${s.id}">
          <span class="gear-i ${statusOf(s.id)}">${gearVisual(s)}</span>
          <span class="swap-opt-n">${esc(s.name)}</span>
          <span class="swap-opt-a">Swap</span>
        </button>`).join('')}</div>`
        : `<div class="swap-none">No identical unit is free — nothing else in the cage
           matches it closely enough to offer as a spare.</div>
           ${customSwapBlock(i.id)}`}
      <button class="btn small" data-act="drop-item" data-id="${i.id}">Remove from list</button>
    </div>`;
  }).join('');
  paintCustomSwapResults();
}

/**
 * When swapCandidates finds nothing "close enough" (same category, brand and
 * base name), that's not necessarily the end of it — there might be a
 * perfectly good stand-in that just isn't the same model. This is the
 * fallback: search the whole cage instead of the one interchangeable family,
 * and swap in whatever's actually free. The action that performs the swap
 * (`swap-item` on the picker, `cart-swap` on the checkout review) is picked
 * at click time by `paintCustomSwapResults`, so this stays one code path for
 * both screens.
 */
function customSwapBlock(itemId) {
  if (CUSTOM_SWAP_FOR !== itemId) {
    return `<button class="btn small" data-act="custom-swap-open" data-id="${itemId}">Choose a different item</button>`;
  }
  return `
    <div class="pick-h" style="margin:8px 0 4px">
      <span class="lbl">Choose a different item</span>
      <button class="btn small" data-act="custom-swap-open" data-id="${itemId}">Cancel</button>
    </div>
    <input id="custom-swap-q" type="search" class="pick-q"
      placeholder="Search gear — name, brand, code" value="${esc(CUSTOM_SWAP_Q)}" autocomplete="off">
    <div id="custom-swap-list" style="max-height:30vh;overflow-y:auto;margin:8px 0 4px"></div>`;
}

/** The candidate list for the open custom-swap panel, if any. Its own
    function (rather than folded into paintSwaps/cartConflictCards) so
    typing in the search box can repaint just the results, leaving the input
    and its focus alone. */
function paintCustomSwapResults() {
  const box = $('#custom-swap-list');
  if (!box || CUSTOM_SWAP_FOR == null) return;
  const onPicker = Boolean($('#pick-list'));
  const swapAction = onPicker ? 'swap-item' : 'cart-swap';
  // Already spoken for on this booking, target included — it's about to be
  // replaced, not offered back to itself.
  const already = onPicker ? picked() : CART.items;
  const holderId = Number($('#co-holder')?.value || $('#r-person')?.value) || S.me.id;
  const [start, end] = onPicker ? pickWindow() : [today(), $('#co-due')?.value || today()];
  const isFree = availabilityTest(start, end, holderId);
  const free = S.items.filter(i => !i.retired && !already.includes(i.id) && isFree(i.id));
  const q = CUSTOM_SWAP_Q.trim();
  const matched = (q ? searchItems(free, q) : free).slice(0, 60);
  box.innerHTML = matched.length ? matched.map(sp => `<div class="swap-opts">
      <button class="btn small swap-opt" data-act="${swapAction}" data-id="${CUSTOM_SWAP_FOR}" data-to="${sp.id}">
        <span class="gear-i ${statusOf(sp.id)}">${iconFor(sp)}</span>
        <span class="swap-opt-n">${esc(sp.name)}</span>
        <span class="swap-opt-a">Swap</span>
      </button></div>`).join('')
    : `<div class="empty">${q ? `Nothing free matches “${esc(q)}”.` : 'Nothing else is free right now.'}</div>`;
}


/**
 * The confirmation screen: what you're about to take, and nothing else.
 *
 * The picker has to show all 459 items so you can find things, which makes it
 * useless for checking what you've actually got — you'd be scanning a long
 * list for ticks. This is the other half of that: your list, on its own, with
 * a way back to the picker when something's missing.
 */
function sheet_cart() {
  const pruned = pruneCart(CART, S.items);
  CART = pruned.cart;
  cartSave();
  if (pruned.dropped) toast(`${pruned.dropped} item(s) left your checkout — retired or removed since`, true);

  const days = Number(S.settings.default_loan_days || 3);
  const ids = CART.items;
  const dueValue = CART.due || shift(today(), days);
  const blocked = ids.filter(i => statusOf(i) !== 'ready');
  PICK_CTX = 'checkout';

  openSheet(`
    <div class="sheet-h">
      <div><div class="lbl">Your checkout</div>
      <h2>${ids.length} item${ids.length === 1 ? '' : 's'} ready to go</h2></div>
      <button class="btn small" data-act="close-sheet">Close</button>
    </div>

    ${ids.length ? `
      <div class="panel" style="margin-bottom:14px"><div class="panel-b flush">
        ${ids.map(id => {
          const it = item(id);
          const st = statusOf(id);
          return `<div class="row-wrap"><div class="row static">
            <i class="tally ${st}"></i>
            <span class="gear-i ${st}">${gearVisual(it)}</span>
            <span class="row-main">
              <span class="row-name">${esc(it.name)}${flagTag(it)}</span>
              <span class="row-sub">${esc(it.code)}${st !== 'ready' ? ' · ' + STATUS_TEXT[st] : ''}</span>
            </span>
          </div>
          <button class="row-add" data-act="cart-remove" data-id="${id}"
            title="Take out of this checkout" aria-label="Remove ${esc(it.name)}">×</button></div>`;
        }).join('')}
      </div></div>

      ${cartConflictCards(ids, dueValue)}

      ${labelFields('co', CART)}
      ${isAdmin() ? `<div class="field"><label class="lbl" for="co-holder">Who's taking it</label>
        <select id="co-holder">${S.people.map(p =>
          `<option value="${p.id}" ${p.id === S.me.id ? 'selected' : ''}>${esc(p.name || p.email)}</option>`).join('')}</select></div>`
        : `<input type="hidden" id="co-holder" value="${S.me.id}">`}
      <div class="field"><label class="lbl" for="co-due">Due back</label>
        <input id="co-due" type="date" value="${dueValue}" min="${today()}"></div>
      ${newCrewBlock('checkout')}
      <div id="flight"></div>
      ${isAdmin() ? `<label class="switch" style="border-bottom:0">
        <span class="t"><span class="row-name">Override blocks</span>
        <span class="d">Admin only. The reason is recorded in the audit log.</span></span>
        <input type="checkbox" id="co-override">
      </label>` : ''}
      <div class="btn-row" style="margin-top:8px">
        <button class="btn primary" style="flex:1" data-act="cart-confirm">Check out ${ids.length} item${ids.length === 1 ? '' : 's'}</button>
        <button class="btn" data-act="cart-more">Add more gear</button>
        <button class="btn danger" data-act="cart-clear">Empty</button>
      </div>`
    : `<div class="empty">Nothing in your checkout yet.</div>
       <button class="btn primary wide" data-act="cart-more">Add gear</button>`}`);

  if (ids.length) preflightCart();
  paintCustomSwapResults();
}


/**
 * Clashes, fixable where you find them.
 *
 * The review screen used to say "swap them on the previous screen", which
 * means leaving the summary, finding the row among 459, and coming back. The
 * same spare-finding that powers the picker's conflict cards works just as
 * well here, so the fix is one tap from the thing that told you about it.
 */
function cartConflictCards(ids, dueValue) {
  const isFree = availabilityTest(today(), dueValue, S.me.id);
  const stuck = ids.map(id => item(id)).filter(i => i && !isFree(i.id));
  if (!stuck.length) return '';

  const live = S.items.filter(i => !i.retired);
  return `<div class="lbl" style="margin:4px 0 6px">${stuck.length} clash${
    stuck.length === 1 ? '' : 'es'}</div>` + stuck.map(i => {
    const spares = swapCandidates(i, live, { isFree: c => isFree(c.id), limit: 3 });
    const loan = openOut(i.id);
    const why = downFor(i.id) ? `down · ${downFor(i.id).kind.toLowerCase()}`
      : loan ? `out with ${loan.holder_name || loan.holder_email} · due ${loan.due_on}`
      : 'held by someone else';
    return `<div class="swap">
      <div class="swap-h"><span class="row-name">${esc(i.name)}${flagTag(i)}</span>
        <span class="row-sub">${esc(i.code)} · ${esc(why)}</span></div>
      ${spares.length ? `<div class="swap-opts">${spares.map(sp =>
        `<button class="btn small swap-opt" data-act="cart-swap" data-id="${i.id}" data-to="${sp.id}">
          <span class="gear-i ${statusOf(sp.id)}">${gearVisual(sp)}</span>
          <span class="swap-opt-n">${esc(sp.name)}</span>
          <span class="swap-opt-a">Swap</span>
        </button>`).join('')}</div>`
        : `<div class="swap-none">No identical unit is free — nothing else in the cage
           matches it closely enough to offer as a spare.</div>
           ${customSwapBlock(i.id)}`}
      <div class="btn-row">
        <button class="btn small" data-act="cart-remove" data-id="${i.id}">Remove from checkout</button>
        ${loan ? `<button class="btn small" data-act="cart-trade" data-id="${loan.id}"
          data-item="${i.id}">Suggest trade</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

/** Same server dry-run as the picker, against the cart rather than the ticks. */
async function preflightCart() {
  const box = $('#flight');
  if (!box || !CART.items.length) return;
  try {
    const r = await POST('/api/checkouts/preflight', {
      item_ids: CART.items,
      due_on: $('#co-due')?.value,
      holder_id: Number($('#co-holder')?.value) || undefined,
      override: $('#co-override')?.checked || false
    });
    box.innerHTML = blockList(r.blocks) + blockList(r.warnings, 'Heads up');
    const btn = $('[data-act="cart-confirm"]');
    if (btn) btn.disabled = !r.allowed;
  } catch (err) {
    box.innerHTML = `<div class="alert"><div>${esc(err.message)}</div></div>`;
  }
}

/**
 * The checkout sheet is a view onto the cart, not a thing of its own.
 *
 * `preselect` merges rather than replaces, so "check out this kit now" adds to
 * whatever you'd already gathered instead of throwing it away. Closing the
 * sheet — to look at whoever you're clashing with, say — costs nothing,
 * because the list lives in the cart and the cart is on disk.
 */
function sheet_checkout(preselect = [], project = '', shoot = '', kitId = null) {
  const days = Number(S.settings.default_loan_days || 3);
  PICK_Q = ''; PICK_TL = 'conflicts';
  CUSTOM_SWAP_FOR = null; CUSTOM_SWAP_Q = ''; SWAPPED_OUT = [];
  const people = S.people;
  PICK_CTX = 'checkout';

  if (preselect.length) CART = addToCart(CART, preselect);
  if (project) CART.project = project;
  if (shoot) CART.shoot = shoot;
  if (kitId) CART = setCartKit(CART, kitId);
  const pruned = pruneCart(CART, S.items);
  CART = pruned.cart;
  cartSave();
  if (pruned.dropped) {
    toast(`${pruned.dropped} item(s) left your checkout — retired or removed since`, true);
  }
  const start = CART.items;
  const dueValue = CART.due || shift(today(), days);
  const projectValue = CART.project || '';
  const shootValue = CART.shoot || '';
  const crewCount = (CART.crew || []).length;
  // Closed by default, but the button itself carries whatever's already in
  // there — collapsing it shouldn't make a name or a shared teammate
  // disappear from view, only out of the way until it's wanted.
  const moreSummary = [shootValue, projectValue].filter(Boolean).join(' · ');
  const moreLabel = CO_MORE
    ? 'Hide project details'
    : (moreSummary || crewCount)
      ? `${moreSummary || 'Untitled'}${crewCount ? ` · shared with ${crewCount}` : ''}`
      : 'Add project name, description & share with a teammate';
  openSheet(`
    <div class="sheet-h">
      <div><div class="lbl">Check out</div><h2>Send gear out</h2></div>
      <button class="btn small" data-act="close-sheet">Close</button>
    </div>
    ${isAdmin() ? `<div class="field"><label class="lbl" for="co-holder">Who's taking it</label>
      <select id="co-holder">${people.map(p =>
        `<option value="${p.id}" ${p.id === S.me.id ? 'selected' : ''}>${esc(p.name || p.email)}</option>`).join('')}</select></div>`
      : `<input type="hidden" id="co-holder" value="${S.me.id}">`}
    <div class="field"><label class="lbl" for="co-due">Due back</label>
      <input id="co-due" type="date" value="${dueValue}" min="${today()}"></div>
    <button class="btn small wide" data-act="co-more" aria-expanded="${CO_MORE}"
      style="margin-bottom:12px;text-align:left">${esc(moreLabel)}</button>
    ${CO_MORE ? `${labelFields('co', { shoot: shootValue, project: projectValue })}
      ${newCrewBlock(PICK_CTX === 'reserve' ? 'reservation' : 'checkout')}` : ''}
    ${pickListBlock()}
    <div class="pick-h" style="margin:14px 0 6px">
      <span class="lbl">Availability <span id="picker-count" class="picker-count"></span></span>
      <span class="chips tight">
        <button class="chip" data-act="pick-tl" data-tl="conflicts">Clashes only</button>
        <button class="chip" data-act="pick-tl" data-tl="all">All gear</button>
      </span>
    </div>
    <div id="picker"></div>
    <div id="flight"></div>
    ${isAdmin() ? `<label class="switch" style="border-bottom:0">
      <span class="t"><span class="row-name">Override blocks</span>
      <span class="d">Admin only. The reason is recorded in the audit log.</span></span>
      <input type="checkbox" id="co-override">
    </label>` : ''}
    <div class="btn-row" style="margin-top:4px">
      <button class="btn primary" style="flex:1" data-act="cart-review">Go to checkout${
        cartCount(CART) ? ` · ${cartCount(CART)}` : ''}</button>
      <button class="btn" data-act="save-out">Check out now</button>
      ${cartCount(CART) ? `<button class="btn danger" data-act="cart-clear">Empty</button>` : ''}
    </div>`);
  paintPickList(start);
  syncDatesToPicker();
  paintPicker();
  preflight();
}

/** Ask the server what would happen, so blocks appear before they tap. */
async function preflight() {
  const box = $('#flight');
  if (!box) return;
  const ids = picked();
  if (!ids.length) { box.innerHTML = ''; return; }
  try {
    const r = await POST('/api/checkouts/preflight', {
      item_ids: ids,
      due_on: $('#co-due')?.value,
      holder_id: Number($('#co-holder')?.value) || undefined,
      override: $('#co-override')?.checked || false
    });
    const unhandled = r.blocks.filter(b => !(b.item_id && SWAP_IDS.has(b.item_id)));
    box.innerHTML = blockList(unhandled) + blockList(r.warnings, 'Heads up');
    const btn = $('[data-act="save-out"]');
    if (btn) btn.disabled = !r.allowed;
  } catch (err) {
    box.innerHTML = `<div class="alert"><div>${esc(err.message)}</div></div>`;
  }
}

/**
 * What to put in a checkout/reservation sheet's header versus its meta line.
 *
 * Leads with the Shoot Description (the `project` column) rather than the
 * Project Name (the `shoot` column) — backwards from what the field names
 * now suggest, but every Cheqroom import writes its label into `project`
 * (see scripts/import-orders.js) and the rename form's `shoot` field is
 * brand new, so on real data `shoot` is empty on nearly everything that
 * isn't a hand-typed test row. Leading with the empty field would mean most
 * bookings show a bare name as the header — exactly the problem this was
 * built to fix. Same preference order as bookingLabel() in calendar.js.
 * Whoever it's for moves down to the meta line instead of falling off
 * entirely, alongside the Project Name if one was given. Falls back to the
 * person when neither is set, same as before this existed.
 */
function bookingHeaderMeta(b, who) {
  const description = String(b.project || '').trim();
  const name = String(b.shoot || '').trim();
  return description
    ? { header: description, sub: name ? `${who} · ${name}` : who }
    : { header: who, sub: name };
}

function sheet_openCheckout(id) {
  const c = S.openCheckouts.find(x => x.id === Number(id));
  if (!c) return;
  SHEET_BOOKING = { kind: 'checkout', id: Number(id) };
  /* Someone else's loan is theirs. Not editable by anyone but the holder —
     admins included — because the only ways in are a request to add or an
     offer to swap, and both need their answer. */
  const mine = c.holder_id === S.me.id;
  const editable = mine;
  const canAdd = iCanAddTo(c);       // holder, or a named teammate
  const late = c.due_on < today();
  const hm = bookingHeaderMeta(c, c.holder_name || c.holder_email);
  if (!SHEET_REDRAW) { ADD_Q = ''; ADD_OPEN = false; ASK_OPEN = false; SWAP_OPEN = false; BOOKING_ITEMS_OPEN = false; }
  openSheet(`
    <div class="sheet-h">
      <div><div class="lbl">${late ? 'Overdue' : 'Out on set'}</div>
      <h2>${esc(hm.header)}</h2>
      <div class="mono" style="color:var(--dim)">${hm.sub ? esc(hm.sub) + ' · ' : ''}out ${c.out_at} · due ${c.due_on}</div></div>
      <button class="btn small" data-act="close-sheet">Close</button>
    </div>
    ${editable ? '' : `<div class="alert"><div>Out with ${esc(c.holder_name || c.holder_email)}.
      Only they can check this in or take anything off it.</div></div>`}

    ${renameBlock('checkout', c)}

    <div class="lbl" style="margin-bottom:4px">${c.item_ids.length} item${
      c.item_ids.length === 1 ? '' : 's'} ${editable ? 'out — tick to check in' : 'on this loan'}</div>

    <!-- Adding sits above the gear, not below it. A fourteen-item loan already
         needs scrolling to read; putting the way to add more underneath it
         means scrolling the whole thing to reach the one button you came for. -->
    ${crewBlock('checkout', c)}
    ${canAdd
      ? addGearBlock('checkout-add-items', c.id)
      : `<div class="btn-row" style="margin-bottom:10px">
           <button class="btn" data-act="ask-open">Add gear</button>
           <button class="btn" data-act="swap-open">Suggest trade</button>
         </div>
         ${askBlock('checkout', c.id, c.holder_name || c.holder_email)}
         ${swapBlock(c)}`}

    <div style="margin-bottom:14px">${bookingItemsBlock(c, editable
      ? pickRows(c.item_ids, c.item_ids)
      /* Only tickable while you're actually building a swap offer. A row that
         looks selectable when selecting does nothing is just a broken
         promise — and the gear icon alone reads as an empty checkbox. */
      : SWAP_OPEN
        ? c.item_ids.map(i => {
            const it = item(i); if (!it) return '';
            return `<label class="check">
              <input type="checkbox" class="their-pick" value="${i}">
              <span class="gear-i ${statusOf(i)}">${gearVisual(it)}</span>
              <span class="n">${esc(it.name)}${flagTag(it)}<span class="row-sub">${esc(it.code)}</span></span>
            </label>`;
          }).join('')
        : readOnlyRows(c.item_ids), c.item_ids.length)}</div>
    ${editable ? `
      <button class="btn primary wide" data-act="do-return" data-id="${c.id}" style="margin-bottom:14px">Check in selected</button>
      <div class="field"><label class="lbl" for="ex-due">Extend due date</label>
        <input id="ex-due" type="date" value="${c.due_on}" min="${today()}"></div>
      <button class="btn wide" data-act="do-extend" data-id="${c.id}">Extend</button>` : ''}
    <div id="flight" style="margin-top:12px"></div>`);
  if (canAdd) ADD_EXCLUDE = c.item_ids;
}

/**
 * Any booking on the calendar, on any day.
 *
 * An open checkout gets the full sheet with check-in and extend, a live hold
 * gets the editable one with add/remove gear. Everything else — a loan that
 * already came back, a hold that's been collected or cancelled — is
 * read-only, but still lists every item on it, which is the point: clicking
 * Thursday's order should tell you what went out on Thursday.
 */
/** Re-render the new-hold sheet, keeping the gear, dates and teammates. */
function redrawRes() {
  const keep = picked();
  const project = $('#r-project')?.value || '';
  const shoot = $('#r-shoot')?.value || '';
  const start = $('#r-start')?.value, end = $('#r-end')?.value;
  SHEET_REDRAW = true;
  try { sheet_res(keep, project, shoot); } finally { SHEET_REDRAW = false; }
  if (start) { const el = $('#r-start'); if (el) el.value = start; }
  if (end) { const el = $('#r-end'); if (el) el.value = end; }
}

/** Re-render the open sheet without resetting which panels are unrolled. */
function redrawSheet() {
  if (!SHEET_BOOKING) return;
  SHEET_REDRAW = true;
  try { sheet_booking(SHEET_BOOKING.kind, SHEET_BOOKING.id); }
  finally { SHEET_REDRAW = false; }
}

function sheet_booking(kind, id) {
  if (kind === 'checkout' && S.openCheckouts.some(c => c.id === id)) {
    return sheet_openCheckout(id);
  }
  if (kind === 'reservation' && S.reservations.some(r => r.id === id)) {
    return sheet_editReservation(id);
  }

  const bookings = CAL.bookings || bookingsFromState(S);
  const b = bookings.find(x => x.kind === kind && x.id === id);
  if (!b) return toast('That booking is no longer on the board', true);
  SHEET_BOOKING = { kind, id };
  if (!SHEET_REDRAW) BOOKING_ITEMS_OPEN = false;

  const isRes = kind === 'reservation';
  const label = isRes ? 'Hold — collected or released' : 'Returned';

  const rows = b.item_ids.map(itemId => {
    const it = item(itemId);
    if (!it) return `<div class="row static"><span class="row-main">
      <span class="row-name">Item ${itemId}</span>
      <span class="row-sub">no longer in the inventory</span></span></div>`;
    const st = statusOf(it.id);
    return `<button class="row" data-act="item" data-id="${it.id}">
      <i class="tally ${st}"></i>
      <span class="gear-i ${st}">${gearVisual(it)}</span>
      <span class="row-main">
        <span class="row-name">${esc(it.name)}${flagTag(it)}</span>
        <span class="row-sub">${esc(it.code)} · ${esc(it.brand || it.category)}</span>
      </span>
    </button>`;
  }).join('');

  const hm = bookingHeaderMeta(b, b.person_name);
  openSheet(`
    <div class="sheet-h">
      <div><div class="lbl">${esc(label)}</div>
      <h2>${esc(hm.header)}</h2>
      <div class="mono" style="color:var(--dim)">${hm.sub ? esc(hm.sub) + ' · ' : ''}${b.start} → ${b.end}</div></div>
      <button class="btn small" data-act="close-sheet">Close</button>
    </div>
    <div class="lbl" style="margin-bottom:4px">${b.item_ids.length} item${
      b.item_ids.length === 1 ? '' : 's'} on this ${isRes ? 'hold' : 'checkout'}</div>
    ${bookingItemsBlock(b, `<div class="panel"><div class="panel-b flush">${rows}</div></div>`, b.item_ids.length)}`);
}

/** A live hold — not yet collected or already ready to collect — with add/remove gear. */
function sheet_editReservation(id) {
  const r = S.reservations.find(x => x.id === Number(id));
  if (!r) return toast('That hold is no longer active', true);
  SHEET_BOOKING = { kind: 'reservation', id: Number(id) };
  // A hold belongs to whoever made it, same as a loan.
  const mine = r.person_id === S.me.id;
  const editable = mine;
  const canAdd = iCanAddTo(r);
  ADD_Q = '';
  if (!SHEET_REDRAW) BOOKING_ITEMS_OPEN = false;

  const rows = r.item_ids.map(itemId => {
    const it = item(itemId);
    if (!it) return `<div class="row static"><span class="row-main">
      <span class="row-name">Item ${itemId}</span>
      <span class="row-sub">no longer in the inventory</span></span></div>`;
    const st = statusOf(it.id);
    // Only the holder gets tick boxes, because only they can remove.
    if (!editable) return readOnlyRows([it.id]);
    return `<label class="check">
      <input type="checkbox" class="remove-pick" value="${it.id}">
      <span class="gear-i ${st}">${gearVisual(it)}</span>
      <span class="n">${esc(it.name)}${flagTag(it)}<span class="row-sub">${esc(it.code)}</span></span>
      <i class="tally ${st}"></i>
    </label>`;
  }).join('');

  const hm = bookingHeaderMeta(r, r.person_name || r.person_email);
  openSheet(`
    <div class="sheet-h">
      <div><div class="lbl">Hold — ${r.start_on > today() ? 'not collected yet' : 'ready to collect'}</div>
      <h2>${esc(hm.header)}</h2>
      <div class="mono" style="color:var(--dim)">${hm.sub ? esc(hm.sub) + ' · ' : ''}${r.start_on} → ${r.end_on}</div></div>
      <button class="btn small" data-act="close-sheet">Close</button>
    </div>
    ${editable ? '' : `<div class="alert"><div>Held for ${esc(r.person_name || r.person_email)}.
      Only they can collect or release it.</div></div>`}

    ${renameBlock('reservation', r)}

    <div class="lbl" style="margin-bottom:4px">${r.item_ids.length} item${
      r.item_ids.length === 1 ? '' : 's'} on this hold</div>

    <!-- Same reasoning as a loan: adding goes above the gear, so a long hold
         doesn't have to be scrolled past to reach it. -->
    ${crewBlock('reservation', r)}
    ${canAdd
      ? addGearBlock('res-add-items', r.id)
      : `<button class="btn wide" data-act="ask-open" style="margin-bottom:10px">Add gear</button>
         ${askBlock('reservation', r.id, r.person_name || r.person_email)}`}

    ${bookingItemsBlock(r, `<div class="panel"><div class="panel-b flush">${rows}</div></div>`, r.item_ids.length)}
    ${editable && r.series_id ? seriesBlock(r) : ''}
    ${editable ? `
      <button class="btn wide" data-act="res-remove-items" data-id="${r.id}" style="margin-top:10px">Remove selected</button>
      <div class="btn-row" style="margin-top:14px">
        <button class="btn primary" data-act="new-checkout-from-res" data-id="${r.id}">Check this gear out</button>
        <button class="btn" data-act="res" data-id="${r.id}">Release this hold</button>
      </div>` : ''}
    <div id="flight" style="margin-top:12px"></div>`);
  if (canAdd) ADD_EXCLUDE = r.item_ids;
}

/** How many other live occurrences share this hold's series, and a button to
    drop the rest at once — releasing each by hand is exactly the tedium a
    recurring hold exists to avoid. */
function seriesBlock(r) {
  const remaining = S.reservations.filter(x => x.series_id === r.series_id).length;
  return `<div class="alert" style="margin-top:10px">
    <div>Part of a repeating series — ${remaining} hold${remaining === 1 ? '' : 's'} still upcoming.</div>
    <button class="btn small" data-act="cancel-series" data-id="${esc(r.series_id)}" style="margin-top:8px">
      Cancel the rest of this series</button>
  </div>`;
}

function sheet_res(preselect = [], project = '', shoot = '', kitId = null) {
  /* A fresh hold starts with nobody on it. Re-rendering to show the picker
     must not wipe the list — and "nothing ticked yet" is not the same as "a
     new sheet", which is what SHEET_REDRAW is for. */
  if (!SHEET_REDRAW) { NEW_RES_CREW = []; NEW_RES_KIT_ID = kitId; SWAPPED_OUT = []; }
  PICK_Q = ''; PICK_TL = 'all';
  CUSTOM_SWAP_FOR = null; CUSTOM_SWAP_Q = '';
  PICK_CTX = 'reserve';
  openSheet(`
    <div class="sheet-h">
      <div><div class="lbl">Reservation</div><h2>Hold gear for a date</h2></div>
      <button class="btn small" data-act="close-sheet">Close</button>
    </div>
    ${labelFields('r', { shoot, project })}
    ${isAdmin() ? `<div class="field"><label class="lbl" for="r-person">Who for</label>
      <select id="r-person">${S.people.map(p =>
        `<option value="${p.id}" ${p.id === S.me.id ? 'selected' : ''}>${esc(p.name || p.email)}</option>`).join('')}</select></div>`
      : `<input type="hidden" id="r-person" value="${S.me.id}">`}
    <div class="two">
      <div class="field"><label class="lbl" for="r-start">From</label>
        <input id="r-start" type="date" value="${today()}" min="${today()}"></div>
      <div class="field"><label class="lbl" for="r-end">To</label>
        <input id="r-end" type="date" value="${shift(today(), 2)}" min="${today()}"></div>
    </div>
    <label class="switch">
      <span class="t"><span class="row-name">Repeat this hold</span>
      <span class="d">Makes a separate hold for each occurrence — a conflict on one week
        skips just that week, not the rest of the series.</span></span>
      <input type="checkbox" id="r-repeat">
    </label>
    <div id="r-repeat-fields" hidden>
      <div class="two">
        <div class="field"><label class="lbl" for="r-freq">Repeats</label>
          <select id="r-freq"><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></div>
        <div class="field"><label class="lbl" for="r-interval">Every</label>
          <input id="r-interval" type="number" min="1" max="12" value="1"></div>
      </div>
      <div class="field"><label class="lbl" for="r-until">Until</label>
        <input id="r-until" type="date" value="${shift(today(), 84)}" min="${today()}"></div>
    </div>
    ${newCrewBlock(PICK_CTX === 'reserve' ? 'reservation' : 'checkout')}
    ${pickListBlock()}
    <div class="pick-h" style="margin:14px 0 6px">
      <span class="lbl">Availability <span id="picker-count" class="picker-count"></span></span>
      <span class="chips tight">
        <button class="chip" data-act="pick-tl" data-tl="conflicts">Clashes only</button>
        <button class="chip" data-act="pick-tl" data-tl="all">All gear</button>
      </span>
    </div>
    <div id="picker"></div>
    <div id="flight"></div>
    <button class="btn primary wide" data-act="save-res">Check availability and hold</button>`);
  paintPickList(preselect);
  syncDatesToPicker();
  paintPicker();
}

/**
 * Search-then-pick for the gear a maintenance ticket is against, instead of
 * one <select> holding an <option> per item in the whole cage. Its own
 * function, keyed to #maint-item-field, so picking or changing repaints
 * just this one field rather than the whole sheet — the notes textarea and
 * whatever's already typed into it survive.
 */
function maintItemPickBlock() {
  const chosen = MAINT_ITEM_ID ? item(MAINT_ITEM_ID) : null;
  if (chosen) {
    return `<button class="row" data-act="maint-item-change" style="border:1px solid var(--rule);border-radius:3px">
      <span class="gear-i ${statusOf(chosen.id)}">${gearVisual(chosen)}</span>
      <span class="row-main">
        <span class="row-name">${esc(chosen.name)}${flagTag(chosen)}</span>
        <span class="row-sub">${esc(chosen.code)}</span>
      </span>
      <span class="lbl">Change</span>
    </button>`;
  }
  return `
    <input id="maint-item-q" type="search" class="pick-q" placeholder="Search gear — name, brand, code"
      value="${esc(MAINT_ITEM_Q)}" autocomplete="off">
    <div id="maint-item-list" style="max-height:34vh;overflow-y:auto;margin-top:6px"></div>`;
}

function paintMaintItemResults() {
  const box = $('#maint-item-list');
  if (!box) return;
  const live = S.items.filter(i => !i.retired);
  const q = MAINT_ITEM_Q.trim();
  const matched = (q ? searchItems(live, q) : live).slice(0, 60);
  box.innerHTML = matched.length ? matched.map(i => `<button class="row" data-act="maint-item-pick" data-id="${i.id}">
      <span class="gear-i ${statusOf(i.id)}">${gearVisual(i)}</span>
      <span class="row-main">
        <span class="row-name">${esc(i.name)}${flagTag(i)}</span>
        <span class="row-sub">${esc(i.code)}</span>
      </span>
    </button>`).join('')
    : `<div class="empty">Nothing matches “${esc(q)}”.</div>`;
}

function sheet_maint(itemId) {
  MAINT_ITEM_ID = itemId ? Number(itemId) : null;
  MAINT_ITEM_Q = '';
  openSheet(`
    <div class="sheet-h">
      <div><div class="lbl">Service</div><h2>Log a problem</h2></div>
      <button class="btn small" data-act="close-sheet">Close</button>
    </div>
    <div class="field"><label class="lbl">Gear</label>
      <div id="maint-item-field">${maintItemPickBlock()}</div>
    </div>
    <div class="field"><label class="lbl" for="m-kind">Type</label>
      <select id="m-kind"><option>Repair</option><option>Damage</option><option>Missing part</option><option>Firmware</option><option>Routine service</option></select></div>
    <div class="field"><label class="lbl" for="m-notes">What's wrong</label>
      <textarea id="m-notes" placeholder="Symptoms, where it happened, who it's going to"></textarea></div>
    <div class="alert warn"><div>This marks the item unavailable until the ticket is closed.</div></div>
    <button class="btn primary wide" data-act="save-maint">Log it</button>`);
  paintMaintItemResults();
}

function sheet_editItem(id) {
  const it = id ? item(id) : { name:'', category:'', brand:'', model:'', serial:'', code:'', notes:'', flag:'' };
  const next = 'LC-' + (S.items.reduce((m, i) =>
    Math.max(m, parseInt(String(i.code).replace(/\D/g, ''), 10) || 100), 100) + 1);
  const flags = [...new Set(S.items.map(i => i.flag).filter(Boolean))];
  PENDING_PHOTO = null;
  openSheet(`
    <div class="sheet-h">
      <div><div class="lbl">${id ? 'Edit' : 'New'}</div><h2>${id ? 'Edit gear' : 'Add gear'}</h2></div>
      <button class="btn small" data-act="close-sheet">Close</button>
    </div>
    ${photoField('item', id, photoWrapper('item', gearVisual(it)), Boolean(it.has_image))}
    <div class="field"><label class="lbl" for="e-name">Name</label><input id="e-name" value="${esc(it.name)}"></div>
    <div class="two">
      <div class="field"><label class="lbl" for="e-cat">Category</label>
        <input id="e-cat" list="cats" value="${esc(it.category)}">
        <datalist id="cats">${[...new Set(S.items.map(i => i.category))].map(c => `<option>${esc(c)}</option>`).join('')}</datalist></div>
      <div class="field"><label class="lbl" for="e-brand">Brand</label><input id="e-brand" value="${esc(it.brand)}"></div>
    </div>
    <div class="two">
      <div class="field"><label class="lbl" for="e-model">Model</label><input id="e-model" value="${esc(it.model)}"></div>
      <div class="field"><label class="lbl" for="e-serial">Serial</label><input id="e-serial" value="${esc(it.serial)}"></div>
    </div>
    <div class="two">
      <div class="field"><label class="lbl" for="e-code">Code</label><input id="e-code" value="${esc(it.code || next)}"></div>
      <div class="field"><label class="lbl" for="e-flag">Owned by</label>
        <input id="e-flag" list="flags" value="${esc(it.flag)}" placeholder="e.g. FLMKR, GAT">
        <datalist id="flags">${flags.map(f => `<option>${esc(f)}</option>`).join('')}</datalist></div>
    </div>
    <div class="field"><label class="lbl" for="e-notes">Notes</label><textarea id="e-notes">${esc(it.notes)}</textarea></div>
    <button class="btn primary wide" data-act="save-item" data-id="${id || ''}">Save</button>`);
}

/**
 * Create or edit either kind of kit. Creating is always a package — the only
 * button that opens this with no id is "Build a package" on the Packages
 * tab, physical kits only ever come from scripts/import-kits.js. Editing
 * works on either; a physical kit just doesn't get the sharing control,
 * since it has no personal owner for "shared" to mean anything relative to.
 */
function sheet_kit(id) {
  const k = id ? S.kits.find(x => x.id === Number(id)) : null;
  const isKit = k?.type === 'kit';
  /* Gear that's retired since the kit was built would silently vanish on the
     next save, so keep it listed and ticked — dropping it should be a choice. */
  const live = S.items.filter(i => !i.retired).map(i => i.id);
  const listed = [...new Set([...live, ...(k?.item_ids || [])])];
  PENDING_PHOTO = null;
  openSheet(`
    <div class="sheet-h">
      <div><div class="lbl">${isKit ? 'Kit' : 'Package'}</div>
        <h2>${k ? `Edit ${isKit ? 'kit' : 'package'}` : 'Build a package'}</h2></div>
      <button class="btn small" data-act="close-sheet">Close</button>
    </div>
    ${photoField('kit', id, photoWrapper('kit', kitVisual(k || {})), Boolean(k?.has_image))}
    <div class="field"><label class="lbl" for="k-name">${isKit ? 'Kit' : 'Package'} name</label>
      <input id="k-name" value="${esc(k?.name || '')}" placeholder="e.g. Interview A-cam package"></div>
    <div class="field"><label class="lbl" for="k-notes">Notes <span style="color:var(--dim)">optional</span></label>
      <input id="k-notes" value="${esc(k?.notes || '')}" placeholder="What it's for, what to watch out for"></div>
    ${isKit ? '' : `<label class="switch">
      <span class="t"><span class="row-name">Share with the team</span>
      <span class="d">Everyone can see it and copy it. Only you can change it.</span></span>
      <input type="checkbox" id="k-shared" ${k?.shared ? 'checked' : ''}>
    </label>`}
    <div class="lbl" style="margin:14px 0 4px">Gear</div>
    <input id="kit-pick-q" type="search" class="pick-q"
      placeholder="Search gear — name, brand, code" autocomplete="off">
    <div id="kit-pick-meta" class="pick-meta"></div>
    <div id="kit-pick-list" style="max-height:44vh;overflow-y:auto;margin-bottom:14px"></div>
    <button class="btn primary wide" data-act="save-kit" data-id="${id || ''}">Save ${isKit ? 'kit' : 'package'}</button>`);
  KIT_PICK_Q = '';
  paintKitPickList(k?.item_ids || [], listed);
}

/**
 * The kit editor's gear list. Scrolling 459 items to build a kit is the same
 * problem the checkout sheet had, so it gets the same search — and the same
 * rule that anything ticked stays on screen even when it doesn't match, so a
 * search can never quietly drop something out of the kit you're building.
 */
function paintKitPickList(preselect = null, listed = null) {
  const box = $('#kit-pick-list');
  if (!box) return;
  const keep = preselect ?? picked();
  const all = listed ?? [...new Set([
    ...S.items.filter(i => !i.retired).map(i => i.id), ...keep
  ])];

  const q = KIT_PICK_Q.trim();
  const pool = all.map(id => item(id)).filter(Boolean);
  const matched = q ? searchItems(pool, q) : pool;
  const shown = new Set(matched.map(i => i.id));
  const extras = pool.filter(i => keep.includes(i.id) && !shown.has(i.id));
  const list = [...matched, ...extras];

  box.innerHTML = list.length
    ? pickRows(list.map(i => i.id), keep)
    : `<div class="empty">Nothing matches “${esc(q)}”.</div>`;

  const meta = $('#kit-pick-meta');
  if (meta) {
    const parts = [`${keep.length} selected`];
    if (q) parts.push(`${matched.length} match “${q}”`);
    if (extras.length) parts.push(`${extras.length} selected shown below`);
    meta.textContent = parts.join(' · ');
  }
}



/**
 * Sharing a booking before it exists.
 *
 * The teammates panel on an existing booking is the wrong moment for a shoot
 * that was always going to be two people — you'd make the checkout, then go
 * back into it to add them. This is the same list, chosen up front, written
 * in the same transaction as the booking.
 *
 * Checkout choices ride in the cart, so they survive a reload like the gear
 * does. A reservation is built in one sitting, so its list is just state.
 */
/**
 * What a booking is called: a Project Name, and a Shoot Description.
 *
 * Two fields rather than one because a single label was doing both jobs — a
 * loan called "Christmas" told you nothing about which of the nine Christmas
 * shoots it was for. Shoot Description is the one that shows up in lists and
 * sheet headers by default (bookingLabel() in calendar.js and
 * bookingHeaderMeta() above both prefer it, over what the field names alone
 * would suggest) — every import writes its label into the `project` column,
 * so on real data that's the field that's actually filled in.
 */
function labelFields(prefix, { shoot = '', project = '' } = {}) {
  return `<div class="two">
    <div class="field"><label class="lbl" for="${prefix}-shoot">Project Name</label>
      <input id="${prefix}-shoot" placeholder="Sunday 9am service" value="${esc(shoot)}" maxlength="120"></div>
    <div class="field"><label class="lbl" for="${prefix}-project">Shoot Description</label>
      <input id="${prefix}-project" placeholder="Christmas campaign" value="${esc(project)}" maxlength="120"></div>
  </div>`;
}

/**
 * The two labels on a booking that already exists.
 *
 * The one thing about a loan that never stops being editable, and only by the
 * person who made it: shoots get retitled halfway through the week, usually
 * after the gear has already gone out. Everyone else sees what it's called
 * but has nothing to type into.
 */
function renameBlock(kind, b) {
  const mine = (b.holder_id ?? b.person_id) === S.me.id;
  const path = kind === 'checkout' ? 'checkouts' : 'reservations';
  if (!mine) {
    const label = [b.shoot, b.project].filter(Boolean);
    return label.length
      ? `<div class="lbl" style="margin-bottom:10px">${label.map(esc).join(' · ')}</div>`
      : '';
  }
  return `${labelFields('rn', b)}
    <button class="btn wide" data-act="rename-booking" data-kind="${path}" data-id="${b.id}"
      style="margin-bottom:14px">Save names</button>`;
}

function newCrewBlock(kind) {
  const chosen = kind === 'checkout' ? (CART.crew || []) : NEW_RES_CREW;
  const spare = S.people.filter(p => p.id !== S.me.id && !chosen.includes(p.id));
  return `
    <div class="pick-h" style="margin:12px 0 4px">
      <span class="lbl">Share with</span>
      <span class="row-sub">${chosen.length ? `${chosen.length} teammate${chosen.length === 1 ? '' : 's'}` : 'optional'}</span>
    </div>
    ${chosen.length ? `<div class="panel" style="margin-bottom:8px"><div class="panel-b flush">
      ${chosen.map(pid => {
        const who = S.people.find(x => x.id === pid);
        return `<div class="row-wrap"><div class="row static">
          <span class="row-main"><span class="row-name">${esc(who?.name || who?.email || `Person ${pid}`)}</span>
          <span class="row-sub">can add gear to this</span></span></div>
          <button class="row-add" data-act="newcrew-remove" data-kind="${kind}" data-person="${pid}"
            title="Take them off" aria-label="Remove teammate">×</button></div>`;
      }).join('')}
    </div></div>` : ''}
    ${spare.length ? `<div class="kit-add-row" style="margin-bottom:6px">
      <select id="newcrew-pick">
        <option value="">Choose a teammate…</option>
        ${spare.map(p => `<option value="${p.id}">${esc(p.name || p.email)}</option>`).join('')}
      </select>
      <button class="btn" id="newcrew-btn" data-act="newcrew-add" data-kind="${kind}" disabled>Add</button>
    </div>
    <div class="hint">They'll be able to add gear to it without asking. Only you
      can check it in, extend it or take gear off.</div>` : ''}`;
}

/** Gear you can look at but not select — no checkbox, no false affordance. */
function readOnlyRows(ids) {
  return ids.map(id => {
    const it = item(id);
    if (!it) return `<div class="row static"><span class="row-main">
      <span class="row-name">Item ${id}</span>
      <span class="row-sub">no longer in the inventory</span></span></div>`;
    const st = statusOf(it.id);
    return `<div class="row static">
      <span class="gear-i ${st}">${gearVisual(it)}</span>
      <span class="row-main"><span class="row-name">${esc(it.name)}${flagTag(it)}</span>
      <span class="row-sub">${esc(it.code)}</span></span>
      <i class="tally ${st}"></i>
    </div>`;
  }).join('');
}

/* Who's on a booking besides the person who made it. */
const contributorsOf = b => (b?.contributor_ids || []).map(Number);
const iCanAddTo = b => {
  const owner = b?.holder_id ?? b?.person_id;
  return owner === S.me.id || contributorsOf(b).includes(S.me.id);
};

/**
 * The teammates panel. Naming someone lets them add gear to this booking
 * without asking each time; it does not let them end it — check-in, extend,
 * remove and release stay with whoever made the booking.
 */
function crewBlock(kind, b) {
  const owner = b.holder_id ?? b.person_id;
  const isOwner = owner === S.me.id;
  const crew = contributorsOf(b);
  const path = kind === 'checkout' ? 'checkouts' : 'reservations';
  const spare = S.people.filter(p => p.id !== owner && !crew.includes(p.id));

  if (!isOwner && !crew.length) return '';
  return `
    <div class="pick-h" style="margin:14px 0 4px"><span class="lbl">Teammates</span></div>
    ${crew.length ? `<div class="panel" style="margin-bottom:8px"><div class="panel-b flush">
      ${crew.map(pid => {
        const who = S.people.find(x => x.id === pid);
        return `<div class="row-wrap"><div class="row static">
          <span class="row-main"><span class="row-name">${esc(who?.name || who?.email || `Person ${pid}`)}</span>
          <span class="row-sub">can add gear</span></span></div>
          ${isOwner || pid === S.me.id
            ? `<button class="row-add" data-act="crew-remove" data-kind="${path}" data-id="${b.id}"
                data-person="${pid}" title="Take them off" aria-label="Remove teammate">×</button>`
            : ''}</div>`;
      }).join('')}
    </div></div>`
    : `<div class="hint">Just you on this one.</div>`}
    ${isOwner && spare.length ? `<div class="kit-add-row" style="margin-bottom:4px">
      <!-- A placeholder rather than the first name: a select that opens on
           "Camden Goff" reads as though Camden is already on the booking. -->
      <select id="crew-pick">
        <option value="">Choose a teammate…</option>
        ${spare.map(p => `<option value="${p.id}">${esc(p.name || p.email)}</option>`).join('')}
      </select>
      <button class="btn" id="crew-add-btn" data-act="crew-add" data-kind="${path}"
        data-id="${b.id}" disabled>Add teammate</button>
    </div>
    <div class="hint">They can add gear to this
      ${kind === 'checkout' ? 'checkout' : 'hold'} without asking. Only you can
      check it in, extend it or take gear off.</div>` : ''}`;
}

/* -------------------------------------------------- kits shared by link */

/** The kit currently being offered by a link, so Save has something to save. */
let INCOMING = null;

function openSharedKitFromUrl() {
  const payload = kitPayloadFromHash(location.hash);
  if (!payload) return;
  /* Clear the hash first: a failed decode shouldn't leave a link that
     re-offers itself on every refresh, and a saved kit shouldn't re-offer
     either. */
  history.replaceState({}, '', location.pathname + location.search);

  const shared = decodeKit(payload);
  if (!shared) return toast("That kit link is damaged — ask them to send it again", true);
  INCOMING = resolveKit(shared, S.items);
  sheet_sharedKit();
}

function sheet_sharedKit() {
  const k = INCOMING;
  if (!k) return;
  const names = S.kits.filter(kitIsMine).map(x => x.name);
  /* Prefill clear of your existing kits so saving twice doesn't leave two
     identically named rows you then can't tell apart. */
  const suggested = uniqueKitName(k.name, names);
  openSheet(`
    <div class="sheet-h">
      <div><div class="lbl">${k.from ? `${esc(k.from)} shared a kit` : 'Shared kit'}</div>
      <h2>${esc(k.name)}</h2></div>
      <button class="btn small" data-act="close-sheet">Close</button>
    </div>
    ${k.notes ? `<div class="row-sub" style="margin-bottom:12px">${esc(k.notes)}</div>` : ''}
    ${k.found.length ? '' : `<div class="alert"><div>None of this gear is in your cage.
      The codes came from a different inventory.</div></div>`}
    ${k.missing.length && k.found.length ? `<div class="alert"><div>
      ${k.missing.length} item${k.missing.length === 1 ? '' : 's'} in this kit
      ${k.missing.length === 1 ? "isn't" : "aren't"} in your cage and will be left out:
      <span class="mono">${k.missing.map(esc).join(', ')}</span></div></div>` : ''}
    ${k.found.length ? `
      <div class="field"><label class="lbl" for="sk-name">Save it as</label>
        <input id="sk-name" value="${esc(suggested)}"></div>
      <div class="lbl" style="margin-bottom:4px">${k.found.length} item${k.found.length === 1 ? '' : 's'}</div>
      <div style="max-height:40vh;overflow-y:auto;margin-bottom:14px">${
        pickRows(k.found.map(i => i.id), k.found.map(i => i.id))}</div>
      <button class="btn primary wide" data-act="save-shared-kit">Save to my kits</button>
      <div class="row-sub" style="margin-top:8px">It's yours and private. Share it on
        yourself if the rest of the team should see it.</div>` : ''}`);
}

/**
 * Hand a kit to someone as a link. Uses the native share sheet where there is
 * one — on a phone that's the actual "send it as a text" the request was
 * about — and falls back to the clipboard everywhere else.
 */
async function shareKitLink(id) {
  const k = S.kits.find(x => x.id === Number(id));
  if (!k) return;
  const codes = k.item_ids.map(i => item(i)?.code).filter(Boolean);
  if (!codes.length) return toast('That kit has no gear in it to share', true);

  let url;
  try {
    url = kitShareUrl(location.href, k, codes, S.me.name || S.me.email || '');
  } catch (err) {
    return toast(err.message, true);
  }

  /* A file:// link is only openable by someone who already has the same file,
     so say so rather than letting them text a dead link. */
  const local = location.protocol === 'file:';

  if (!local && navigator.share) {
    try {
      await navigator.share({ title: k.name, text: `${k.name} — a kit from The Cage`, url });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;   // they closed the share sheet
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast(local
      ? 'Link copied — only opens for someone with this same file'
      : 'Link copied — paste it into a text');
  } catch {
    sheet_kitLink(k.name, url, local);          // clipboard blocked; show it
  }
}

function sheet_kitLink(name, url, local) {
  openSheet(`
    <div class="sheet-h">
      <div><div class="lbl">Share</div><h2>${esc(name)}</h2></div>
      <button class="btn small" data-act="close-sheet">Close</button>
    </div>
    <div class="field"><label class="lbl" for="kl-url">Copy this link</label>
      <input id="kl-url" value="${esc(url)}" readonly></div>
    ${local ? `<div class="alert"><div>This is a local file, so the link only opens
      for someone who has the same file. From a hosted cage it works for anyone.</div></div>` : ''}
    <div class="row-sub">Whoever opens it can save the kit to their own. It's a
      snapshot — changing your kit later won't change a link you already sent.</div>`);
}




/**
 * Offering a trade. You've ticked gear on their loan above; this is the other
 * half — what goes back the other way, drawn only from your own open
 * checkouts, because you can't give away what you don't hold.
 */
function swapBlock(c) {
  return `<div id="swap-block">${swapInner(c)}</div>`;
}

function swapInner(c) {
  if (!SWAP_OPEN) return '';
  const mineHeld = myOfferableGear();
  const whose = c.holder_name || c.person_name || c.holder_email || c.person_email;
  const hasSomewhere = S.openCheckouts.some(x => x.holder_id === S.me.id)
    || S.reservations.some(x => x.person_id === S.me.id);
  if (!hasSomewhere) {
    return `<div class="alert warn"><div>Their gear needs somewhere to land, so
      check something out or make a hold first — then you can trade.</div></div>`;
  }
  return `
    <div class="pick-h" style="margin:14px 0 4px">
      <span class="lbl">Suggest a trade</span>
      <button class="btn small" data-act="swap-open">Cancel</button>
    </div>
    <button class="btn primary wide" data-act="swap-send" data-id="${c.id}"
      style="margin-bottom:8px">Send trade to ${esc(whose)}</button>
    <div class="hint">Nothing moves until they accept. Then both halves change
      hands at once, and they get an email either way.</div>
    <div class="field"><label class="lbl" for="swap-note">Why (optional)</label>
      <input id="swap-note" placeholder="You'd get the wider zoom"></div>
    <div class="hint">Tick what you want from their booking below, then pick what
      goes back — yours, or anything free.</div>
    <div class="chips tight" style="margin-bottom:6px">
      <button class="chip" data-act="swap-src" data-src="mine" aria-pressed="${SWAP_SRC === 'mine'}">What I hold${
        mineHeld.length ? ` · ${mineHeld.length}` : ''}</button>
      <button class="chip" data-act="swap-src" data-src="free" aria-pressed="${SWAP_SRC === 'free'}">Anything free</button>
    </div>
    ${SWAP_SRC === 'free' ? `<input id="swap-q" type="search" class="pick-q"
      placeholder="Search free gear — name, brand, code" value="${esc(SWAP_Q)}" autocomplete="off">` : ''}
    <div id="swap-list" style="max-height:30vh;overflow-y:auto;margin-bottom:10px"></div>`;
}

/** Everything on a live booking of mine — a loan or a hold. */
function myOfferableGear() {
  return [...new Set([
    ...S.openCheckouts.filter(x => x.holder_id === S.me.id).flatMap(x => x.item_ids),
    ...S.reservations.filter(x => x.person_id === S.me.id).flatMap(x => x.item_ids)
  ])];
}

/** The offer list: gear I hold, or free gear I'm suggesting they take instead. */
function paintSwapList(keep = null) {
  const box = $('#swap-list');
  if (!box) return;
  const chosen = keep ?? $$('.mine-pick').filter(x => x.checked).map(x => Number(x.value));
  let ids;
  if (SWAP_SRC === 'mine') {
    ids = myOfferableGear();
  } else {
    const spoken = new Set([
      ...S.openCheckouts.flatMap(c => c.item_ids),
      ...S.reservations.flatMap(r => r.item_ids)
    ]);
    const free = S.items.filter(i => !i.retired && !spoken.has(i.id) && !downFor(i.id));
    const q = SWAP_Q.trim();
    ids = (q ? searchItems(free, q) : free).slice(0, 60).map(i => i.id);
  }
  const shown = [...new Set([...ids, ...chosen])];
  box.innerHTML = shown.length ? shown.map(id => {
    const it = item(id); if (!it) return '';
    return `<label class="check">
      <input type="checkbox" class="mine-pick" value="${id}" ${chosen.includes(id) ? 'checked' : ''}>
      <span class="gear-i ${statusOf(id)}">${gearVisual(it)}</span>
      <span class="n">${esc(it.name)}${flagTag(it)}<span class="row-sub">${esc(it.code)}</span></span>
    </label>`;
  }).join('') : `<div class="empty">${SWAP_SRC === 'mine'
    ? "You've nothing out to offer — try Anything free."
    : `Nothing free matches “${esc(SWAP_Q)}”.`}</div>`;
}

/**
 * Asking someone to add gear to their booking.
 *
 * Same picker as the direct add, because it's the same question — the only
 * difference is who gets to answer it. Nothing is held while it's pending.
 */
function askBlock(kind, id, holderName) {
  return `<div id="ask-block">${askInner(kind, id, holderName)}</div>`;
}

/* Its own element for the same reason the add-gear block has one: redrawing
   the whole sheet to show the picker resets the flag that asked for it. */
function askInner(kind, id, holderName) {
  if (!ASK_OPEN) return '';
  /* The action sits under the heading, not under 459 rows of inventory. The
     list is the long part; burying the button below it means scrolling past
     the whole cage to do the thing you opened the panel for. */
  return `
    <div class="pick-h" style="margin:14px 0 4px">
      <span class="lbl">Add gear</span>
      <button class="btn small" data-act="ask-open">Cancel</button>
    </div>
    <button class="btn primary wide" data-act="ask-send" data-kind="${kind}" data-id="${id}"
      style="margin-bottom:8px">Suggest<span id="ask-count"></span> to ${esc(holderName)}</button>
    <div class="row-sub" style="margin-bottom:10px">A suggestion, not a change —
      ${esc(holderName)} confirms before anything is added. Nothing is held meanwhile.</div>
    <div class="field"><label class="lbl" for="ask-note">Why (optional)</label>
      <input id="ask-note" placeholder="Swapping in for a dead battery"></div>
    <input id="add-q" type="search" class="pick-q"
      placeholder="Search gear — name, brand, code" value="${esc(ADD_Q)}" autocomplete="off">
    <div id="add-list" style="max-height:30vh;overflow-y:auto;margin:8px 0 8px"></div>`;
}

/* ---------------------------------------------------------------- appearance */

/**
 * Theme, type scale and weight, kept in localStorage and applied to <html>.
 *
 * Applied before first paint by a snippet in index.html — reading it here and
 * setting it after boot would flash the dark theme at someone who chose light.
 */
const APPEARANCE_KEY = 'the-cage-appearance';
const TEXT_SCALE = { small: 0.85, normal: 1, large: 1.18, xlarge: 1.4 };

/* Per person, like the cart — two people sharing the gear-room laptop
   shouldn't inherit each other's theme.
   `:last` records whose settings were applied most recently, because the
   pre-paint snippet in index.html has to choose a theme before the app has
   asked the server who's signed in. Getting it wrong for one frame is what a
   flash of the wrong theme is, so the last person is the best available
   guess and boot corrects it if they've changed. */
const appearanceKey = personId => `${APPEARANCE_KEY}:${personId ?? 'anon'}`;

function readAppearance(personId) {
  try {
    const own = localStorage.getItem(appearanceKey(personId));
    /* Adopt the old browser-wide setting the first time someone signs in
       after this change, rather than silently resetting them to dark. */
    const saved = JSON.parse(own || localStorage.getItem(APPEARANCE_KEY) || '{}');
    return {
      theme: saved.theme === 'light' ? 'light' : 'dark',
      text: TEXT_SCALE[saved.text] ? saved.text : 'normal',
      bold: Boolean(saved.bold)
    };
  } catch { return { theme: 'dark', text: 'normal', bold: false }; }
}

let APPEARANCE = readAppearance();

function applyAppearance() {
  const el = document.documentElement;
  el.dataset.theme = APPEARANCE.theme;
  el.style.setProperty('--fs', String(TEXT_SCALE[APPEARANCE.text]));
  /* Bold lifts the three weights together rather than shouting one of them:
     body text carries most of the legibility, and headings that were already
     600 have nowhere useful to go past 700. */
  el.style.setProperty('--fw', APPEARANCE.bold ? '600' : '400');
  el.style.setProperty('--fw-mid', APPEARANCE.bold ? '700' : '500');
  el.style.setProperty('--fw-bold', APPEARANCE.bold ? '700' : '600');
  try {
    const id = S?.me?.id;
    localStorage.setItem(appearanceKey(id), JSON.stringify(APPEARANCE));
    if (id != null) localStorage.setItem(`${APPEARANCE_KEY}:last`, String(id));
  } catch { /* private mode — the choice still applies for this session */ }
}

function sheet_appearance() {
  const pick = (key, value, label) =>
    `<button class="chip" data-act="set-appearance" data-key="${key}" data-value="${value}"
      aria-pressed="${String(APPEARANCE[key]) === String(value)}">${label}</button>`;
  openSheet(`
    <div class="sheet-h">
      <div><div class="lbl">Appearance</div><h2>How this looks</h2></div>
      <button class="btn small" data-act="close-sheet">Close</button>
    </div>
    <div class="appearance-row">
      <span><span class="row-name">Theme</span>
        <span class="row-sub">Light is easier in a bright gear room</span></span>
      <span class="chips tight">${pick('theme', 'dark', 'Dark')}${pick('theme', 'light', 'Light')}</span>
    </div>
    <div class="appearance-row">
      <span><span class="row-name">Text size</span>
        <span class="row-sub">Scales the whole interface, not just body text</span></span>
      <span class="chips tight">${pick('text', 'small', 'S')}${pick('text', 'normal', 'M')}${
        pick('text', 'large', 'L')}${pick('text', 'xlarge', 'XL')}</span>
    </div>
    <div class="appearance-row">
      <span><span class="row-name">Heavier text</span>
        <span class="row-sub">Thicker strokes, for glare or a long day</span></span>
      <span class="chips tight">${pick('bold', false, 'Normal')}${pick('bold', true, 'Bold')}</span>
    </div>
    <div class="row-sub" style="margin-top:14px">Kept on this device.</div>`);
}

/**
 * The nav's overflow on a phone. Four destinations fit the bottom bar
 * without shrinking every label to fit an eighth of the screen; the rest
 * open here instead of a fifth, sixth, seventh, eighth tab squeezed in.
 * Admin only appears for an admin, same as the tab itself.
 */
function sheet_moreNav() {
  const items = MORE_TABS.filter(t => !t.adminOnly || isAdmin());
  openSheet(`
    <div class="sheet-h">
      <div><div class="lbl">More</div><h2>Everything else</h2></div>
      <button class="btn small" data-act="close-sheet">Close</button>
    </div>
    <div class="panel"><div class="panel-b flush">
      ${items.map(t => `<button class="row" data-act="go-tab" data-tab="${t.tab}">
        <span class="row-main">
          <span class="row-name">${esc(t.label)}</span>
          <span class="row-sub">${esc(t.desc)}</span>
        </span>
      </button>`).join('')}
    </div></div>`);
}

/* ---------------------------------------------------------------- csv import */

function columnsSummary(columns) {
  return columns.map(c => `${c.field}: ${c.header ? `"${esc(c.header)}"` : '— not found'}`).join('  ·  ');
}

function sheet_importItems() {
  const r = IMPORT_ITEMS.result;
  openSheet(`
    <div class="sheet-h">
      <div><div class="lbl">Cheqroom export</div><h2>Import gear</h2></div>
      <button class="btn small" data-act="close-sheet">Close</button>
    </div>
    <p style="color:var(--dim);font-size:13.5px;margin:0 0 14px">
      Export your inventory from Cheqroom as CSV. Column names are matched loosely,
      so most exports work untouched. Re-running an import later updates existing
      gear — matched by code, then serial — rather than duplicating it.</p>
    <div class="field"><label class="lbl" for="imp-items-file">CSV file</label>
      <input type="file" id="imp-items-file" accept=".csv,text/csv"></div>
    <label class="switch">
      <span class="t"><span class="row-name">Fetch photos</span>
        <span class="d">Download each item's photo once and keep it here, rather than linking back to
          Cheqroom — a re-import only re-fetches ones the export changed.</span></span>
      <input type="checkbox" id="imp-items-images" ${IMPORT_ITEMS.fetchImages ? 'checked' : ''}>
    </label>
    ${r ? `
      <div class="tl-status ${r.dry ? '' : 'ok'}" style="margin-bottom:10px">
        <div class="lbl">${r.dry ? 'Preview — nothing written yet' : 'Imported'}</div>
        ${r.created} new, ${r.updated} updated, ${r.skipped} skipped (no name)${r.auto ? `, ${r.auto} auto-coded` : ''}.
        ${r.dry && r.imagesFound ? `<br>${r.imagesFound} row(s) have a photo — fetched on a real run.` : ''}
        ${!r.dry && r.imagesFetched ? `<br>Fetched ${r.imagesFetched} new or changed photo(s).` : ''}
        ${!r.dry && r.imagesFailed ? `<br>${r.imagesFailed} photo(s) failed to download — the item still imported.` : ''}
      </div>
      <div class="mono" style="color:var(--dim);font-size:11px;margin-bottom:10px">${esc(columnsSummary(r.columns))}</div>
      ${r.problems?.length ? `<div class="alert warn"><div><div class="lbl">Issues (${r.problems.length})</div>
        <div style="max-height:18vh;overflow-y:auto;font-size:13px;margin-top:4px">
          ${r.problems.slice(0, 40).map(p => `<div>${esc(p)}</div>`).join('')}
        </div></div></div>` : ''}
      ${r.preview?.length ? `<div class="lbl" style="margin-bottom:4px">
          ${r.created > r.preview.length
            ? `Showing ${r.preview.length} of ${r.created} — ${r.dry ? 'the rest will import too' : 'the rest were imported too'}, just not listed here`
            : `${r.dry ? 'Would import' : 'Imported'} all ${r.preview.length}`}
        </div>
        <div style="max-height:26vh;overflow-y:auto;margin-bottom:10px">
          ${r.preview.map(p => `<div class="kv"><dt class="mono">${esc(p.code)}</dt><dd>${esc(p.name)}</dd></div>`).join('')}
        </div>` : ''}
    ` : ''}
    <div class="btn-row">
      <button class="btn primary" data-act="import-items-preview">Preview</button>
      ${r?.dry ? `<button class="btn" data-act="import-items-confirm">Confirm import</button>` : ''}
    </div>`);
}

function sheet_importOrders() {
  const r = IMPORT_ORDERS.result;
  const kind = IMPORT_ORDERS.kind || 'checkout';
  openSheet(`
    <div class="sheet-h">
      <div><div class="lbl">Cheqroom export</div><h2>Import checkouts &amp; reservations</h2></div>
      <button class="btn small" data-act="close-sheet">Close</button>
    </div>
    <p style="color:var(--dim);font-size:13.5px;margin:0 0 14px">
      Carries over gear that's already out the door, or already booked, so the
      switchover doesn't lose track of it. Import gear first — an order
      referring to unknown gear is reported, not invented. Re-running is safe;
      each row is matched by its source reference and skipped if already here.</p>
    <div class="two">
      <div class="field"><label class="lbl" for="imp-ord-kind">This file contains</label>
        <select id="imp-ord-kind">
          <option value="checkout" ${kind === 'checkout' ? 'selected' : ''}>Checkouts (gear out now)</option>
          <option value="reservation" ${kind === 'reservation' ? 'selected' : ''}>Reservations (booked for later)</option>
        </select></div>
      <div class="field"><label class="lbl" for="imp-ord-file">CSV file</label>
        <input type="file" id="imp-ord-file" accept=".csv,text/csv"></div>
    </div>
    <label class="switch">
      <span class="t"><span class="row-name">Create placeholder people</span>
        <span class="d">For names that don't match anyone and have no email — they can't sign in until corrected.</span></span>
      <input type="checkbox" id="imp-ord-stubs" ${IMPORT_ORDERS.allowPlaceholders ? 'checked' : ''}>
    </label>
    <label class="switch">
      <span class="t"><span class="row-name">Send reminders for these immediately</span>
        <span class="d">Off by default, so nobody gets an overdue notice the day of the switchover.</span></span>
      <input type="checkbox" id="imp-ord-notify" ${IMPORT_ORDERS.notifyImmediately ? 'checked' : ''}>
    </label>
    <div class="field"><label class="lbl" for="imp-ord-map">Name/email → real email (optional)</label>
      <textarea id="imp-ord-map" rows="3" placeholder="Jordan West,jordan.west@life.church&#10;one pair per line, comma separated">${esc(IMPORT_ORDERS.peopleMap)}</textarea></div>
    ${r ? `
      <div class="tl-status ${r.dry ? '' : 'ok'}" style="margin-bottom:10px">
        <div class="lbl">${r.dry ? 'Preview — nothing written yet' : 'Imported'}</div>
        Found ${r.groupCount} in the file, ${r.dry ? `${r.readyCount} ready to import` : `imported ${r.created}, ${r.skipped} already present`}.
        ${!r.dry && r.stubs ? `<br>${r.stubs} placeholder account(s) created.` : ''}
        ${!r.dry && r.invited ? `<br>${r.invited} account(s) created from real addresses in the file.` : ''}
      </div>
      <div class="mono" style="color:var(--dim);font-size:11px;margin-bottom:10px">${esc(columnsSummary(r.columns))}</div>
      ${r.problems?.length ? `<div class="alert warn"><div><div class="lbl">Issues (${r.problems.length})</div>
        <div style="max-height:18vh;overflow-y:auto;font-size:13px;margin-top:4px">
          ${r.problems.slice(0, 40).map(p => `<div>${esc(p)}</div>`).join('')}
        </div></div></div>` : ''}
      ${r.unmatchedPeople?.length ? `<div class="alert warn"><div><div class="lbl">Unrecognised people (${r.unmatchedPeople.length})</div>
        ${r.unmatchedPeople.map(p => esc(p)).join(', ')} — map them above, or allow placeholders.</div></div>` : ''}
      ${r.unmatchedItems?.length ? `<div class="alert warn"><div><div class="lbl">Unrecognised gear (${r.unmatchedItems.length})</div>
        ${r.unmatchedItems.slice(0, 25).map(i => esc(i)).join(', ')} — import gear first.</div></div>` : ''}
      ${r.preview?.length ? (() => {
        const total = r.dry ? r.readyCount : r.created;
        const label = total > r.preview.length
          ? `Showing ${r.preview.length} of ${total} — ${r.dry ? 'the rest will import too' : 'the rest were imported too'}, just not listed here`
          : `${r.dry ? 'Ready to import' : 'Imported'} all ${r.preview.length}`;
        return `<div class="lbl" style="margin:10px 0 4px">${label}</div>
        <div style="max-height:22vh;overflow-y:auto;margin-bottom:10px">
          ${r.preview.map(p => `<div class="kv"><dt>${esc(p.person)}</dt><dd>${p.itemCount} item(s) · ${p.start} → ${p.due}</dd></div>`).join('')}
        </div>`;
      })() : ''}
    ` : ''}
    <div class="btn-row">
      <button class="btn primary" data-act="import-orders-preview">Preview</button>
      ${r?.dry ? `<button class="btn" data-act="import-orders-confirm">Confirm import</button>` : ''}
    </div>`);
}

function sheet_person(id) {
  PENDING_PHOTO = null;
  if (!id) {
    openSheet(`
      <div class="sheet-h">
        <div><div class="lbl">New</div><h2>Add person</h2></div>
        <button class="btn small" data-act="close-sheet">Close</button>
      </div>
      ${photoField('person', null, personAvatar({}, { large: true }), false)}
      <div class="field"><label class="lbl" for="p-email">Email</label>
        <input id="p-email" type="email" placeholder="name@life.church" autocomplete="off"></div>
      <div class="field"><label class="lbl" for="p-name">Display name</label>
        <input id="p-name" placeholder="Optional — guessed from their email otherwise"></div>
      <label class="switch">
        <span class="t"><span class="row-name">Admin</span>
          <span class="d">Can manage gear, people, and settings.</span></span>
        <input type="checkbox" id="p-role">
      </label>
      <button class="btn primary wide" data-act="save-person" style="margin-top:14px">Add person</button>`);
    return;
  }
  const p = S.people.find(x => x.id === Number(id));
  if (!p) return;
  const theirs = S.openCheckouts.filter(c => c.holder_id === p.id);
  const late = theirs.filter(c => c.due_on < today());
  openSheet(`
    <div class="sheet-h">
      <div><div class="lbl">${p.role === 'admin' ? 'Admin' : 'Member'}</div>
      <h2>${esc(p.name || p.email)}</h2>
      <div class="mono" style="color:var(--dim)">${esc(p.email)}</div></div>
      <button class="btn small" data-act="close-sheet">Close</button>
    </div>
    ${photoField('person', p.id, personAvatar(p, { large: true }), Boolean(p.has_image))}
    ${late.length ? `<div class="alert"><div><div class="lbl">Overdue</div>
      Holding ${late.reduce((n, c) => n + c.item_ids.length, 0)} item(s) past due.</div></div>` : ''}
    <dl style="margin:0 0 14px">
      <div class="kv"><dt>Out now</dt><dd>${theirs.reduce((n, c) => n + c.item_ids.length, 0)} item(s)</dd></div>
      <div class="kv"><dt>Last seen</dt><dd>${p.last_seen_at ? String(p.last_seen_at).slice(0, 10) : 'never'}</dd></div>
      <div class="kv"><dt>Checkout status</dt><dd>${p.blocked ? 'blocked' : 'allowed'}</dd></div>
    </dl>
    <div class="field"><label class="lbl" for="p-name">Display name</label><input id="p-name" value="${esc(p.name)}"></div>
    <div class="field"><label class="lbl" for="p-reason">Block reason (leave blank to allow)</label>
      <input id="p-reason" value="${esc(p.blocked_reason || '')}" placeholder="e.g. unreturned gear from July"></div>
    <div class="btn-row">
      <button class="btn primary" data-act="save-person" data-id="${p.id}">Save</button>
      <button class="btn ${p.blocked ? '' : 'danger'}" data-act="toggle-block" data-id="${p.id}">
        ${p.blocked ? 'Allow checkouts' : 'Block checkouts'}</button>
      <button class="btn" data-act="toggle-role" data-id="${p.id}">
        ${p.role === 'admin' ? 'Make member' : 'Make admin'}</button>
    </div>`);
}

/* -------------------------------------------------------------- audit log */

let AUDIT_Q = '';
let AUDIT_PERSON = 'all';
let AUDIT_ROWS = [];
let AUDIT_MORE = false;
let auditSearchTimer = null;

/* "kit.create" / "item_photo_set" -> "Kit created" / "Item photo set". Not a
   hand-built table of every action string — those keep growing — just the
   common verb endings put into past tense, with anything unrecognised left
   as-is rather than guessed at. */
const AUDIT_PAST_TENSE = {
  create: 'created', update: 'updated', delete: 'deleted', remove: 'removed',
  set: 'set', share: 'shared', unshare: 'unshared', duplicate: 'duplicated',
  retire: 'retired', cancel: 'cancelled', rename: 'renamed', manual: 'run manually'
};
function auditActionLabel(action) {
  const parts = String(action || '').split(/[._]/).filter(Boolean);
  if (parts.length < 2) return action || '(unknown action)';
  const verb = parts[parts.length - 1];
  const noun = parts.slice(0, -1).join(' ');
  const label = `${noun} ${AUDIT_PAST_TENSE[verb] || verb}`;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** detail is a JSONB grab-bag that varies per action — rendered generically
    as key: value pairs rather than a bespoke formatter per action, so a
    brand new action type still shows something useful instead of nothing. */
function auditDetailLine(detail) {
  const entries = Object.entries(detail || {});
  if (!entries.length) return '';
  return entries.map(([k, v]) => `${k}: ${Array.isArray(v) || typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
}

function auditRow(a) {
  return `<div class="row static">
    <span class="row-main">
      <span class="row-name">${esc(auditActionLabel(a.action))}</span>
      <span class="row-sub">${esc(a.person_name || 'system')} · ${String(a.at).slice(0, 16).replace('T', ' ')}${
        auditDetailLine(a.detail) ? ' · ' + esc(auditDetailLine(a.detail)) : ''}</span>
    </span>
  </div>`;
}

async function sheet_auditLog() {
  AUDIT_Q = ''; AUDIT_PERSON = 'all'; AUDIT_ROWS = []; AUDIT_MORE = false;
  openSheet(`
    <div class="sheet-h">
      <div><div class="lbl">Admin</div><h2>Audit log</h2></div>
      <button class="btn small" data-act="close-sheet">Close</button>
    </div>
    <input id="audit-q" type="search" class="pick-q"
      placeholder="Search by action or anything it mentions" autocomplete="off">
    <select id="audit-person" style="margin-bottom:10px">
      <option value="all">Everyone</option>
      ${S.people.map(p => `<option value="${p.id}">${esc(p.name || p.email)}</option>`).join('')}
    </select>
    <div id="audit-list" class="panel"><div class="panel-b flush"></div></div>
    <button class="btn wide" id="audit-more" style="margin-top:10px" hidden>Load more</button>`);
  await loadAuditPage();
}

async function loadAuditPage({ append = false } = {}) {
  const params = new URLSearchParams({ limit: '50' });
  if (AUDIT_Q.trim()) params.set('q', AUDIT_Q.trim());
  if (AUDIT_PERSON !== 'all') params.set('person_id', AUDIT_PERSON);
  if (append && AUDIT_ROWS.length) params.set('before', AUDIT_ROWS[AUDIT_ROWS.length - 1].id);
  const { rows, more } = await GET(`/api/audit?${params}`);
  AUDIT_ROWS = append ? [...AUDIT_ROWS, ...rows] : rows;
  AUDIT_MORE = more;
  paintAuditLog();
}

function paintAuditLog() {
  const box = $('#audit-list .panel-b');
  if (!box) return;
  box.innerHTML = AUDIT_ROWS.length
    ? AUDIT_ROWS.map(auditRow).join('')
    : `<div class="empty">Nothing matches yet.</div>`;
  const more = $('#audit-more');
  if (more) more.hidden = !AUDIT_MORE;
}

/* --------------------------------------------------------- usage report */

let USAGE_FROM = '';
let USAGE_TO = '';
let USAGE_ROWS = [];
let USAGE_Q = '';
let USAGE_SORT = { key: 'days_out', dir: 'desc' };
let USAGE_OPEN = null;   // item id whose drill-down row is expanded, or null
let usageDateTimer = null;

const USAGE_PRESETS = [
  ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last year']
];

/* Column order is display order. `num` right-aligns and sorts numerically;
   everything else sorts as text. A spreadsheet's header row doubles as its
   sort control, so there's no separate sort UI to build. Category and brand
   share one column (see usageRow) rather than each claiming their own —
   eight full-width columns plus a long item name routinely ran past 900px,
   wider than the sheet ever gets, which read as the table cutting off its
   own last column instead of the discoverable side-scroll it actually was.
   Short labels for the same reason; `title` fills in what got trimmed. */
const USAGE_COLUMNS = [
  { key: 'name', label: 'Item' },
  { key: 'category', label: 'Category' },
  { key: 'checkout_count', label: 'Outs', num: true, title: 'Checkouts in this range' },
  { key: 'days_out', label: 'Days out', num: true },
  { key: 'utilization_pct', label: 'Util %', num: true },
  { key: 'last_used_at', label: 'Last used' },
  { key: 'demand_misses', label: 'Turned away', num: true, title: "Wanted while out or held, with no identical spare free to offer instead" }
];

function usagePctColor(pct) {
  if (pct >= 50) return 'var(--ready)';
  if (pct >= 15) return 'var(--dim)';
  return 'var(--flag)';
}

/** Rows matching the filter box, in the current sort order. Both are done
    client-side against the already-loaded range — instant, like a real
    spreadsheet, rather than a round trip per keystroke or header click. */
function usageVisibleRows() {
  const q = normalize(USAGE_Q);
  const filtered = q
    ? USAGE_ROWS.filter(r => normalize(`${r.name} ${r.code} ${r.category} ${r.brand}`).includes(q))
    : USAGE_ROWS;

  const { key, dir } = USAGE_SORT;
  const sign = dir === 'asc' ? 1 : -1;
  return [...filtered].sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;    // nulls (never used, e.g.) sort to the bottom regardless of direction
    if (bv == null) return -1;
    if (typeof av === 'number') return (av - bv) * sign;
    return String(av).localeCompare(String(bv)) * sign;
  });
}

function usageHeaderRow() {
  return `<tr>${USAGE_COLUMNS.map(c => {
    const active = USAGE_SORT.key === c.key;
    const arrow = active ? `<span class="arrow">${USAGE_SORT.dir === 'asc' ? '▲' : '▼'}</span>` : '';
    return `<th class="${c.num ? 'num' : ''}" data-act="usage-sort" data-id="${c.key}"${
      c.title ? ` title="${esc(c.title)}"` : ''}>${esc(c.label)}${arrow}</th>`;
  }).join('')}</tr>`;
}

function usageRow(r) {
  const open = USAGE_OPEN === r.id;
  const cells = `
    <td class="usage-name">${esc(r.name)}${flagTag(r)}${r.retired ? ' · retired' : ''}<span class="usage-code">${esc(r.code)}</span></td>
    <td>${esc(r.category)}${r.brand ? `<span class="usage-code">${esc(r.brand)}</span>` : ''}</td>
    <td class="num">${r.checkout_count}</td>
    <td class="num">${r.days_out}</td>
    <td class="num" style="color:${usagePctColor(r.utilization_pct)}">${r.utilization_pct}%</td>
    <td>${r.last_used_at ? String(r.last_used_at).slice(0, 10) : '—'}</td>
    <td class="num" style="${r.demand_misses ? 'color:var(--flag)' : ''}">${r.demand_misses}</td>`;
  const detail = open ? `<tr class="usage-detail-row"><td colspan="${USAGE_COLUMNS.length}" id="usage-detail-${r.id}">Loading…</td></tr>` : '';
  return `<tr class="usage-row${r.retired ? ' retired' : ''}" data-act="usage-toggle" data-id="${r.id}">${cells}</tr>${detail}`;
}

function paintUsageReport() {
  const box = $('#usage-table-body');
  if (!box) return;
  const head = $('#usage-table-head');
  if (head) head.innerHTML = usageHeaderRow();
  const rows = usageVisibleRows();
  box.innerHTML = rows.length
    ? rows.map(usageRow).join('')
    : `<tr><td colspan="${USAGE_COLUMNS.length}" class="empty">No checkouts in this range.</td></tr>`;
  if (USAGE_OPEN) loadUsageDetail(USAGE_OPEN);
}

async function loadUsageReport() {
  const params = new URLSearchParams({ from: USAGE_FROM, to: USAGE_TO });
  const { rows } = await GET(`/api/reports/usage?${params}`);
  USAGE_ROWS = rows;
  paintUsageReport();
}

/**
 * One item's checkouts and demand misses for the same range already on
 * screen — expanded in place rather than reusing sheet_item(), which shows
 * an item's live status, not its history over an arbitrary window.
 */
async function loadUsageDetail(itemId) {
  const params = new URLSearchParams({ from: USAGE_FROM, to: USAGE_TO });
  const { checkouts, misses } = await GET(`/api/reports/usage/${itemId}/detail?${params}`);
  const box = $(`#usage-detail-${itemId}`);
  if (!box) return;
  const co = checkouts.map(c => `<div class="row-sub">${String(c.out_at).slice(0, 10)} → ${
    c.returned_at ? String(c.returned_at).slice(0, 10) : 'still out'} · ${esc(c.holder_name)}</div>`).join('');
  const ms = misses.map(m => `<div class="row-sub">${String(m.at).slice(0, 10)} · wanted ${m.wanted_from} to ${
    m.wanted_to} · ${esc(m.person_name || 'someone')}</div>`).join('');
  box.innerHTML = `
    <div class="lbl" style="margin:10px 0 4px">Checkouts</div>
    ${co || '<div class="row-sub">None in this range.</div>'}
    <div class="lbl" style="margin:14px 0 4px">Unmet demand</div>
    ${ms || '<div class="row-sub">None in this range.</div>'}`;
}

function usageRangeControls() {
  return `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
    ${USAGE_PRESETS.map(([days, label]) =>
      `<button class="btn small" data-act="usage-preset" data-id="${days}">${label}</button>`).join('')}
  </div>
  <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
    <input id="usage-from" type="date" value="${USAGE_FROM}">
    <span style="color:var(--dim)">to</span>
    <input id="usage-to" type="date" value="${USAGE_TO}">
    <a class="btn small" href="/api/reports/usage?from=${USAGE_FROM}&to=${USAGE_TO}&format=csv" download>Export CSV</a>
  </div>`;
}

async function sheet_usageReport() {
  USAGE_TO = S.today;
  USAGE_FROM = shiftDate(S.today, -29);
  USAGE_ROWS = [];
  USAGE_Q = '';
  USAGE_OPEN = null;
  openSheet(`
    <div class="sheet-h">
      <div><div class="lbl">Admin</div><h2>Usage report</h2></div>
      <button class="btn small" data-act="close-sheet">Close</button>
    </div>
    <div id="usage-controls">${usageRangeControls()}</div>
    <input id="usage-q" type="search" class="pick-q"
      placeholder="Filter by name, code, category, brand" autocomplete="off">
    <div class="panel"><div class="panel-b flush usage-table-wrap">
      <table class="usage-table">
        <thead id="usage-table-head"></thead>
        <tbody id="usage-table-body"></tbody>
      </table>
    </div></div>`);
  await loadUsageReport();
}

function sheet_labels() {
  const live = S.items.filter(i => !i.retired);
  openSheet(`
    <div class="sheet-h no-print">
      <div><div class="lbl">Asset tags</div><h2>QR labels</h2></div>
      <button class="btn small" data-act="close-sheet">Close</button>
    </div>
    <div class="btn-row no-print" style="margin-bottom:14px">
      <button class="btn primary" data-act="print">Print sheet</button>
    </div>
    <div class="labels" id="labels"></div>`);

  const wrap = $('#labels');
  const origin = location.origin;
  live.forEach(i => {
    const card = document.createElement('div');
    card.className = 'label-card';
    const holder = document.createElement('div');
    card.appendChild(holder);
    card.insertAdjacentHTML('beforeend',
      `<div class="n">${esc(i.name)}</div><div class="c">${esc(i.code)}</div>`);
    wrap.appendChild(card);
    if (typeof QRCode !== 'undefined') {
      // Encode a deep link so a phone camera app opens the item, not just text.
      new QRCode(holder, { text: `${origin}/?code=${encodeURIComponent(i.code)}`, width: 116, height: 116, correctLevel: QRCode.CorrectLevel.M });
    } else {
      holder.innerHTML = `<div class="c" style="padding:22px 0;font-size:15px;font-weight:700">${esc(i.code)}</div>`;
    }
  });
  if (typeof QRCode === 'undefined') toast('QR library did not load — labels show codes as text', true);
}


/* ---------------------------------------------------------------- picker glue */

/** The window the picker is scrolled to, defaulting to just before the request. */
function pickerFrom() {
  if (PICK.from) return PICK.from;
  const s = PICK.start || S.today;
  return shiftDate(s, -2) < S.today ? S.today : shiftDate(s, -2);
}

const PICKER_DAYS = () => (window.innerWidth < 640 ? 10 : 16);

/** Redraw only the picker, so the sheet's scroll position and checkboxes survive. */
/**
 * The day-blocks under the picker.
 *
 * A row per selected item is the right tool when you're choosing dates, and
 * noise when you're not: check out a ten-item kit and you get ten rows of
 * empty calendar to scroll past to reach the button. So on a checkout it
 * defaults to showing only what's actually clashing — which is the row you'd
 * have gone looking for anyway — and the toggle brings the rest back.
 *
 * Reserving is different: there the grid *is* the date picker, so it starts
 * showing everything.
 */
function paintPicker() {
  const host = $('#picker');
  if (!host) return;
  const all = picked();
  const ignoreRes = host.dataset.ignore ? [host.dataset.ignore] : [];
  const bookings = bookingsFromState(S);

  const clashing = collisions({
    itemIds: all, start: PICK.start, end: PICK.end, bookings, ignore: ignoreRes
  });
  const clashIds = [...new Set(clashing.flatMap(c => c.shared))];
  const showing = PICK_TL === 'all' ? all : all.filter(id => clashIds.includes(id));

  $$('[data-act="pick-tl"]').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.tl === PICK_TL)));
  const count = $('#picker-count');
  if (count) {
    count.textContent = clashIds.length
      ? `${clashIds.length} clash${clashIds.length === 1 ? '' : 'es'}`
      : all.length ? 'no clashes' : '';
  }

  if (PICK_TL !== 'all' && !showing.length) {
    host.innerHTML = all.length
      ? `<div class="tl-hint">Nothing you've picked is booked over these dates.
         Switch to <b>All gear</b> to see the calendar anyway.</div>`
      : `<div class="tl-hint">Pick gear below and any clashes appear here.</div>`;
    return;
  }

  host.innerHTML = renderPicker({
    state: S,
    bookings,
    itemIds: showing,
    start: PICK.start,
    end: PICK.end,
    from: pickerFrom(),
    days: PICKER_DAYS(),
    cell: cellWidth(),
    ignore: ignoreRes
  });
}

/** Keep the date inputs and the picker selection in step, whichever moved. */
function syncDatesToPicker() {
  const startEl = $('#r-start') || null;
  const endEl = $('#r-end') || $('#co-due') || null;
  if (startEl) PICK.start = startEl.value || S.today;
  else PICK.start = S.today;                    // a checkout always starts today
  if (endEl) PICK.end = endEl.value || PICK.start;
  if (PICK.end < PICK.start) PICK.end = PICK.start;
}

function syncPickerToDates() {
  const startEl = $('#r-start');
  const endEl = $('#r-end') || $('#co-due');
  if (startEl) startEl.value = PICK.start;
  if (endEl) endEl.value = PICK.end;
}

/* ============================ camera scanning ============================ */

/**
 * Pull a gear code out of whatever a tag actually encodes. This app's own
 * labels are a deep link (origin/?code=LC-101), not just the bare code —
 * but older or third-party tags (Cheqroom's own, printed asset labels from
 * before this app existed) commonly encode a plain URL with the code as the
 * last path segment instead, e.g. https://app.cheqroom.com/scan/LC-101.
 * Falls back to the raw string untouched when it isn't a URL at all, so a
 * bare code — typed, scanned as a barcode rather than a QR, whatever —
 * still works exactly as before.
 */
function codeFromScan(raw) {
  const trimmed = String(raw || '').trim();
  if (trimmed.includes('code=')) return decodeURIComponent(trimmed.split('code=')[1].split('&')[0]);
  try {
    const segments = new URL(trimmed).pathname.split('/').filter(Boolean);
    if (segments.length) return decodeURIComponent(segments[segments.length - 1]);
  } catch { /* not a URL — use it as-is */ }
  return trimmed;
}

/** The running list under the camera — a review pile, not a commitment, so
    anything can be pulled back out before it becomes a real checkout or
    hold. */
function scanResultsBlock() {
  if (!SCAN_ITEMS.length) return '';
  const rows = SCAN_ITEMS.map(id => {
    const it = item(id);
    if (!it) return '';
    const st = statusOf(id);
    return `<div class="row-wrap"><div class="row static">
      <i class="tally ${st}"></i>
      <span class="gear-i ${st}">${gearVisual(it)}</span>
      <span class="row-main">
        <span class="row-name">${esc(it.name)}${flagTag(it)}</span>
        <span class="row-sub">${esc(it.code)}${st !== 'ready' ? ' · ' + STATUS_TEXT[st] : ''}</span>
      </span>
    </div>
    <button class="row-add" data-act="scan-remove" data-id="${id}"
      title="Remove ${esc(it.name)}" aria-label="Remove ${esc(it.name)}">×</button></div>`;
  }).join('');
  return `
    <div class="panel" style="margin-top:10px"><div class="panel-h">
      <span class="lbl">Scanned</span>
      <span class="mono" style="color:var(--dim)">${SCAN_ITEMS.length}</span>
    </div><div class="panel-b flush">${rows}</div></div>
    <div class="btn-row" style="margin-top:10px">
      <button class="btn primary" data-act="scan-checkout">Check out ${SCAN_ITEMS.length}</button>
      <button class="btn" data-act="scan-reserve">Reserve instead</button>
      <button class="btn" data-act="scan-clear">Clear</button>
    </div>`;
}

/* How long the same raw scan is ignored after a hit, so holding a tag
   steady in frame (decoded dozens of times a second) adds it once instead
   of spamming the toast and re-checking it on every frame. */
const SCAN_COOLDOWN_MS = 1500;
let lastScan = { raw: null, at: 0 };

/** Shared by both decode paths below: resolve a raw scanned string to gear
    and add it to the running list. The camera is left running — scanning
    a stack of gear is the point, not a single lookup — so this only ever
    stops itself via the Stop button or leaving the page. */
function handleScannedCode(raw) {
  const now = Date.now();
  if (raw === lastScan.raw && now - lastScan.at < SCAN_COOLDOWN_MS) return;
  lastScan = { raw, at: now };

  const code = codeFromScan(raw).toLowerCase();
  const hit = S.items.find(i => i.code.toLowerCase() === code || (i.serial && i.serial.toLowerCase() === code));
  if (!hit) return toast(`No gear matches ${codeFromScan(raw)}`, true);
  if (SCAN_ITEMS.includes(hit.id)) return toast(`${hit.name} is already on the list`);

  SCAN_ITEMS.push(hit.id);
  toast(`Added ${hit.name} — ${SCAN_ITEMS.length} scanned`);
  const box = $('#scan-results');
  if (box) box.innerHTML = scanResultsBlock();
}

async function startCam() {
  const wrap = $('#cam-wrap');
  if (!wrap) return;

  // A fresh press of "Use camera" starts a new pile, not a continuation of
  // whatever was scanned last time. Stopping and resuming the same camera
  // session (if that's ever wired up) would need to skip this.
  SCAN_ITEMS = [];
  lastScan = { raw: null, at: 0 };
  const results = $('#scan-results');
  if (results) results.innerHTML = '';

  const hasNative = 'BarcodeDetector' in window;
  const hasJsQR = typeof jsQR === 'function';
  if (!hasNative && !hasJsQR) {
    wrap.innerHTML = `<div class="alert warn"><div><div class="lbl">No decoder available</div>
      This browser can't decode codes and the fallback library didn't load — check your
      connection, or type the code below instead.</div></div>`;
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
  } catch {
    wrap.innerHTML = `<div class="alert warn"><div><div class="lbl">Camera unavailable</div>
      Permission was denied, or the page isn't on HTTPS. Type the code below instead.</div></div>`;
    return;
  }
  wrap.innerHTML = `<div class="scan-hint"><video id="cam" playsinline muted></video><div class="scan-frame"></div></div>`;
  const v = $('#cam');
  v.srcObject = stream;
  await v.play().catch(() => {});

  if (hasNative) {
    const det = new BarcodeDetector({ formats: ['qr_code', 'code_128', 'code_39'] });
    (async function tick() {
      if (!stream) return;
      try {
        const codes = await det.detect(v);
        // Keep polling after a hit — this used to `return` here, which was
        // fine back when handleScannedCode always stopped the camera itself.
        // Now that it doesn't, returning would silently freeze scanning
        // after the very first tag.
        if (codes.length) handleScannedCode(codes[0].rawValue);
      } catch { /* frame not ready yet */ }
      requestAnimationFrame(tick);
    })();
    return;
  }

  // No browser on iOS ships BarcodeDetector — "Chrome" there is Safari's
  // WebKit engine wearing a different icon, since Apple requires every iOS
  // browser to use it. jsQR reads a QR code by sampling video frames onto a
  // canvas instead: QR-only (that's all the labels sheet prints, and all
  // this needs to cover), but it works anywhere getUserMedia does.
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  (function tick() {
    if (!stream) return;
    if (v.readyState === v.HAVE_ENOUGH_DATA && v.videoWidth) {
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const result = jsQR(frame.data, frame.width, frame.height);
      if (result) handleScannedCode(result.data);   // see the native branch above
    }
    requestAnimationFrame(tick);
  })();
}
function stopCam() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
}

/* ============================ render ============================ */

const VIEWS = {
  out:view_out, gear:view_gear, calendar:view_calendar,
  reservations:view_reserve, repairs:view_repairs, packages:view_packages, kits:view_kits, admin:view_admin
};

/* The tabs a phone tucks behind More rather than showing in the bottom bar.
   One list drives both the sheet's contents (sheet_moreNav) and knowing when
   to light up the More button itself (render), so they can't drift apart. */
const MORE_TABS = [
  { tab: 'repairs', label: 'Repairs', desc: 'Log and track gear that needs service' },
  { tab: 'packages', label: 'Packages', desc: 'Hand-curated presets, ready to check out' },
  { tab: 'kits', label: 'Kits', desc: 'Physical gear cases, imported as a unit' },
  { tab: 'admin', label: 'Admin', desc: 'Checkout rules and settings', adminOnly: true }
];

function render() {
  const live = S.items.filter(i => !i.retired);
  const out = S.openCheckouts.reduce((n, c) => n + c.item_ids.length, 0);
  const late = S.openCheckouts.filter(c => c.due_on < today()).length;

  $('#hdr-count').textContent = `${live.length} items · ${out} out`;
  $('#hdr-who').textContent = S.me.name || S.me.email;
  $('#nav-admin').hidden = !isAdmin();
  // With sign-in switched off there's nothing to sign out of, and it's worth
  // being obvious about it rather than looking like a logged-in session.
  $('#hdr-noauth').hidden = !AUTH_OFF;
  $('#hdr-signout').hidden = AUTH_OFF;

  $$('#nav button').forEach(b => {
    b.setAttribute('aria-current', String(b.dataset.tab === TAB));
    if (b.dataset.tab === 'gear') {
      b.innerHTML = 'Gear' + (late ? `<span class="badge">${late} late</span>` : '');
    }
  });
  // On a phone, More stands in for whichever of its own tabs is current —
  // it has no data-tab of its own, so the loop above always calls it not-current.
  $('#nav-more').setAttribute('aria-current', String(MORE_TABS.some(t => t.tab === TAB)));

  // Lets the stylesheet give each tab the width it can actually use.
  $('#view').dataset.tab = TAB;
  $('#view').innerHTML = (VIEWS[TAB] || view_out)();
  $('#app').classList.add('ready');
  lastCell = TAB === 'calendar' ? cellWidth() : null;
  paintChipScrollHints();
}

async function refresh() {
  S = await GET('/api/state');
  render();
  paintCart();
}

/* ============================ events ============================ */

/* Shared by a direct nav tap and a row inside the More sheet (nav-more's
   overflow for the tabs a phone doesn't have room to show) — both end up
   switching TAB the same way. */
function goTab(tab) {
  TAB = tab;
  stopCam();
  render();
  window.scrollTo({ top: 0 });
  if (TAB === 'calendar') loadCalendar();
}

document.addEventListener('click', async (e) => {
  const navBtn = e.target.closest('#nav button[data-tab]');
  if (navBtn) return goTab(navBtn.dataset.tab);

  const b = e.target.closest('[data-act]');
  if (!b) return;
  const { act, id, cat, tab } = b.dataset;

  const guard = async fn => {
    b.disabled = true;
    try { await fn(); }
    catch (err) {
      if (err.payload?.blocks) {
        const box = $('#flight');
        if (box) box.innerHTML = blockList(err.payload.blocks);
        toast(err.message, true);
      } else toast(err.message, true);
    }
    finally { b.disabled = false; }
  };

  switch (act) {
    /* ---- auth ---- */
    case 'request-link': return guard(async () => {
      const email = $('#gate-email').value.trim();
      if (!email) return toast('Enter your email', true);
      const r = await POST('/auth/request', { email });
      $('#gate-msg').innerHTML = `<div class="alert ok"><div>${esc(r.message)}</div></div>`;
    });
    case 'signout': return guard(async () => {
      await POST('/auth/signout');
      location.reload();
    });

    /* ---- navigation ---- */
    case 'close-sheet': return closeSheet();
    // A row inside the More sheet — same destination a direct nav tap
    // reaches, just closing the sheet it was opened from first.
    case 'go-tab': closeSheet(); return goTab(tab);
    case 'nav-more': return sheet_moreNav();
    case 'filter': FILTER = cat; return render();
    case 'status-filter': STATUSF = b.dataset.status; return render();
    case 'flag-filter': FLAGF = b.dataset.flag; return render();
    case 'group-toggle': {
      const key = b.dataset.key;
      if (GROUPS_OPEN.has(key)) GROUPS_OPEN.delete(key); else GROUPS_OPEN.add(key);
      return render();
    }
    case 'show-all-units': SHOW_ALL_UNITS = !SHOW_ALL_UNITS; return render();
    /* Preselect hands the ids straight to the same reservation sheet the
       picker itself uses — this is a shortcut into it, not a separate path. */
    case 'gear-add-to-res': {
      const ids = [...GEAR_PICKED].filter(i => item(i));
      GEAR_PICKED.clear();
      closeSheet();
      return sheet_res(ids);
    }
    case 'gear-clear-picks': GEAR_PICKED.clear(); return render();
    case 'pick-avail': PICK_AVAIL = b.dataset.avail; return paintPickList();
    case 'item': closeSheet(); return sheet_item(Number(id));
    case 'checkout': closeSheet(); return sheet_openCheckout(id);
    case 'person': return sheet_person(id);
    case 'new-person': closeSheet(); return sheet_person(null);
    case 'labels': return sheet_labels();
    case 'print': return window.print();

    /* ---- checkout ---- */
    case 'new-checkout': closeSheet(); return sheet_checkout(id ? [Number(id)] : []);
    case 'save-out': return guard(async () => {
      const ids = picked();
      if (!ids.length) return toast('Pick at least one item', true);
      const r = await POST('/api/checkouts', {
        item_ids: ids,
        due_on: $('#co-due').value,
        shoot: $('#co-shoot').value.trim(),
        project: $('#co-project').value.trim(),
        holder_id: Number($('#co-holder').value) || undefined,
        contributor_ids: CART.crew || [],
        kit_id: CART.kit_id || undefined,
        override: $('#co-override')?.checked || false,
        swapped_out: CART.swapped_out || []
      });
      /* The gear is out, so the intention is spent. Only cleared once the
         server has said yes — a failed checkout keeps the list you built. */
      CART = emptyCart();
      cartSave();
      closeSheet();
      await refresh();
      toast(r.warnings?.length ? `Checked out with ${r.warnings.length} override(s)` : `${ids.length} item(s) out`);
    });
    case 'do-return': return guard(async () => {
      const ids = picked();
      if (!ids.length) return toast('Pick what came back', true);
      await POST(`/api/checkouts/${id}/return`, { item_ids: ids });
      closeSheet();
      await refresh();
      toast(`${ids.length} item(s) back on the shelf`);
    });
    case 'rename-booking': return guard(async () => {
      await PATCH(`/api/${b.dataset.kind}/${id}`, {
        shoot: $('#rn-shoot').value.trim(),
        project: $('#rn-project').value.trim()
      });
      await refresh();
      /* Stay where you are — renaming is a small edit made mid-conversation,
         and closing the sheet would lose whatever else you were reading. */
      redrawSheet();
      toast('Names updated');
    });

    case 'do-extend': return guard(async () => {
      await POST(`/api/checkouts/${id}/extend`, { due_on: $('#ex-due').value });
      closeSheet();
      await refresh();
      toast('Due date moved');
    });

    /* ---- the category strip on Gear ---- */
    case 'cat-filter': {
      // Tapping the category you're already in clears it, so the strip
      // toggles rather than trapping you.
      FILTER = FILTER === b.dataset.cat ? 'All' : b.dataset.cat;
      STATUSF = 'all';
      return render();
    }
    case 'cat-status': {
      const sameCat = FILTER === b.dataset.cat;
      const sameStatus = STATUSF === b.dataset.status;
      if (sameCat && sameStatus) { FILTER = 'All'; STATUSF = 'all'; }
      else { FILTER = b.dataset.cat; STATUSF = b.dataset.status; }
      return render();
    }

    /* ---- reservations ---- */
    case 'new-res': closeSheet(); return sheet_res(id ? [Number(id)] : []);
    case 'new-checkout-from-res': {
      /* Guarded here as well as in the sheet: the action is reachable from
         any data-act, and loading someone else's hold into your cart is the
         kind of mistake that only surfaces at the till. */
      const held = S.reservations.find(x => x.id === Number(id));
      if (held && held.person_id !== S.me.id) {
        return toast(`That hold is ${held.person_name || held.person_email}'s — only they can collect it`, true);
      }
      const bk = (CAL.bookings || bookingsFromState(S))
        .find(x => x.kind === 'reservation' && x.id === Number(id));
      closeSheet();
      return sheet_checkout(bk ? bk.item_ids : [], bk?.project || '', bk?.shoot || '');
    }
    case 'save-res': return guard(async () => {
      const ids = picked();
      if (!ids.length) return toast('Pick at least one item', true);
      const base = {
        item_ids: ids,
        start_on: $('#r-start').value,
        end_on: $('#r-end').value,
        shoot: $('#r-shoot').value.trim(),
        project: $('#r-project').value.trim(),
        person_id: Number($('#r-person').value) || undefined,
        contributor_ids: NEW_RES_CREW,
        kit_id: NEW_RES_KIT_ID || undefined,
        swapped_out: SWAPPED_OUT
      };

      if ($('#r-repeat')?.checked) {
        const until = $('#r-until').value;
        if (!until) return toast('Pick an end date for the series', true);
        let r;
        try {
          r = await POST('/api/reservations/recurring', {
            ...base, until,
            frequency: $('#r-freq').value,
            interval: Number($('#r-interval').value) || 1
          });
        } catch (err) {
          // Every occurrence conflicted — nothing was created, so there's no
          // series to land on. Distinct from the single-hold path's inline
          // "tap again to override": overriding a whole series one date at a
          // time isn't a decision worth making blind, so this just reports it.
          if (err.payload?.skipped) return toast('Every occurrence conflicts with an existing hold — nothing was held.', true);
          throw err;
        }
        NEW_RES_CREW = [];
        NEW_RES_KIT_ID = null;
        SWAPPED_OUT = [];
        closeSheet();
        await refresh();
        toast(r.skipped.length
          ? `${r.created.length} held, ${r.skipped.length} skipped — already spoken for`
          : `${r.created.length} holds made`);
        return;
      }

      const wasShownConflicts = Boolean($('#flight')?.dataset.conflicted);
      try {
        await POST('/api/reservations', {
          ...base,
          // Admins confirm by tapping a second time after seeing the collisions.
          force: wasShownConflicts && isAdmin()
        });
      } catch (err) {
        if (err.payload?.blocks) {
          const box = $('#flight');
          box.dataset.conflicted = '1';
          box.innerHTML = blockList(err.payload.blocks, 'Double-booked')
            + (isAdmin()
              ? `<div class="row-sub" style="margin-bottom:10px">Tap hold again to book it anyway.</div>`
              : `<div class="row-sub" style="margin-bottom:10px">Ask an admin if you need to take priority.</div>`);
        }
        throw err;
      }
      NEW_RES_CREW = [];
      NEW_RES_KIT_ID = null;
      SWAPPED_OUT = [];
      closeSheet();
      await refresh();
      toast('Held');
    });
    case 'edit-res': closeSheet(); return sheet_editReservation(Number(id));
    case 'res': return guard(async () => {
      const r = S.reservations.find(x => x.id === Number(id));
      if (r.person_id !== S.me.id && !isAdmin()) return toast('Not your hold to release', true);
      if (!confirm(`Release the hold for ${personName(r)} on ${r.start_on}?`)) return;
      await DEL(`/api/reservations/${id}`);
      closeSheet();
      await refresh();
      toast('Hold released');
    });
    case 'cancel-series': return guard(async () => {
      if (!confirm('Cancel every upcoming hold in this series? This leaves past occurrences alone.')) return;
      const r = await DEL(`/api/reservations/series/${id}`);
      closeSheet();
      await refresh();
      toast(`${r.cancelled} hold${r.cancelled === 1 ? '' : 's'} cancelled`);
    });
    case 'res-add-items': return guard(async () => {
      const ids = pickedAdd();
      if (!ids.length) return toast('Pick at least one item', true);
      await POST(`/api/reservations/${id}/items`, { item_ids: ids });
      ADD_Q = '';
      await refresh();
      sheet_editReservation(Number(id));
      toast('Added');
    });
    case 'res-remove-items': return guard(async () => {
      const ids = $$('.remove-pick').filter(c => c.checked).map(c => Number(c.value));
      if (!ids.length) return toast('Pick at least one item to remove', true);
      const r = await DEL(`/api/reservations/${id}/items`, { item_ids: ids });
      await refresh();
      if (r.emptied) { closeSheet(); toast('Removed — nothing left on the hold, so it was released'); }
      else { sheet_editReservation(Number(id)); toast('Removed'); }
    });
    case 'checkout-add-items': return guard(async () => {
      const ids = pickedAdd();
      if (!ids.length) return toast('Pick at least one item', true);
      await POST(`/api/checkouts/${id}/items`, { item_ids: ids });
      ADD_Q = '';
      await refresh();
      sheet_openCheckout(Number(id));
      toast('Added');
    });

    /* ---- maintenance ---- */
    case 'new-maint': closeSheet(); return sheet_maint(id);
    case 'maint-item-pick': {
      MAINT_ITEM_ID = Number(id);
      const field = $('#maint-item-field');
      if (field) field.innerHTML = maintItemPickBlock();
      return;
    }
    case 'maint-item-change': {
      MAINT_ITEM_ID = null;
      MAINT_ITEM_Q = '';
      const field = $('#maint-item-field');
      if (field) field.innerHTML = maintItemPickBlock();
      paintMaintItemResults();
      return;
    }
    case 'save-maint': return guard(async () => {
      if (!MAINT_ITEM_ID) return toast('Search for the gear this is about first', true);
      await POST('/api/maintenance', {
        item_id: MAINT_ITEM_ID,
        kind: $('#m-kind').value,
        notes: $('#m-notes').value.trim()
      });
      closeSheet();
      await refresh();
      toast('Logged — item marked down');
    });
    case 'close-maint': return guard(async () => {
      await POST(`/api/maintenance/${id}/close`);
      closeSheet();
      await refresh();
      toast('Back in service');
    });
    case 'toggle-watch': return guard(async () => {
      const it = item(Number(id));
      if (it.watching) await DEL(`/api/items/${id}/watch`);
      else await POST(`/api/items/${id}/watch`);
      it.watching = !it.watching;
      await sheet_item(Number(id));
      toast(it.watching ? "We'll email you when it's free" : 'Stopped watching');
    });

    /* ---- items ---- */
    case 'new-item': closeSheet(); return sheet_editItem(null);
    case 'edit-item': closeSheet(); return sheet_editItem(Number(id));
    case 'save-item': return guard(async () => {
      const payload = {
        name: $('#e-name').value.trim(),
        category: $('#e-cat').value.trim() || 'Uncategorized',
        brand: $('#e-brand').value.trim(),
        model: $('#e-model').value.trim(),
        serial: $('#e-serial').value.trim(),
        code: $('#e-code').value.trim().toUpperCase(),
        notes: $('#e-notes').value.trim(),
        flag: $('#e-flag').value.trim().toUpperCase()
      };
      if (!payload.name || !payload.code) return toast('Name and code are required', true);
      let itemId = id ? Number(id) : null;
      if (itemId) await PATCH(`/api/items/${itemId}`, payload);
      else ({ id: itemId } = await POST('/api/items', payload));
      await uploadPendingPhoto('item', itemId);
      closeSheet();
      await refresh();
      toast('Saved');
    });
    case 'retire-item': return guard(async () => {
      if (!confirm('Retire this item? It stays in the history but leaves the active list.')) return;
      await DEL(`/api/items/${id}`);
      closeSheet();
      await refresh();
      toast('Retired');
    });
    case 'remove-photo': {
      const kind = b.dataset.kind, entId = b.dataset.id;
      if (!entId) {
        // Nothing uploaded yet — just drop the staged file and the preview.
        // There's no entity to look up yet either, so the fallback is
        // whatever "no photo at all" looks like for this kind.
        PENDING_PHOTO = null;
        const preview = $('#photo-preview');
        if (preview) preview.innerHTML = photoFallbackHtml(kind, {});
        $('#photo-remove-btn')?.setAttribute('hidden', '');
        return;
      }
      return guard(async () => {
        const r = await DEL(`/api/${photoPath(kind)}/${entId}/photo`);
        setLocalImage(kind, entId, false, r.image_v);
        const entity = kind === 'item' ? item(Number(entId))
          : kind === 'kit' ? S.kits.find(k => k.id === Number(entId))
          : S.people.find(p => p.id === Number(entId));
        const preview = $('#photo-preview');
        if (preview) preview.innerHTML = photoFallbackHtml(kind, entity || {});
        $('#photo-remove-btn')?.setAttribute('hidden', '');
        toast('Photo removed');
      });
    }

    /* ---- packages (curated presets — Yours/Team scoping lives only here,
       physical kits have no personal owner to scope by) ---- */
    case 'package-sec': {
      const sec = b.dataset.sec;
      PKG_OPEN[sec] = !PKG_OPEN[sec];
      return render();
    }
    case 'package-scope': PKG_SCOPE = b.dataset.scope; return render();
    case 'booking-items-toggle': BOOKING_ITEMS_OPEN = !BOOKING_ITEMS_OPEN; return redrawSheet();
    case 'kit-link': return shareKitLink(id);
    /* A link-shared kit is always saved as a personal copy, which makes it a
       package by definition — there's no ownerless "physical" reading of
       something someone just texted you. */
    case 'save-shared-kit': return guard(async () => {
      const name = $('#sk-name').value.trim();
      const ids = picked();
      if (!name) return toast('Name it first', true);
      if (!ids.length) return toast('Pick at least one item', true);
      await POST('/api/kits', { name, item_ids: ids, notes: INCOMING?.notes || '' });
      INCOMING = null;
      closeSheet();
      await refresh();
      PKG_OPEN.mine = true;
      TAB = 'packages';
      toast('Saved to your packages');
    });
    /* ---- kits (shared plumbing — the create/edit sheet, the save action,
       and the checkout/reserve actions below all work the same regardless
       of which page's button opened them) ---- */
    case 'new-package': return sheet_kit(null);
    case 'kit-edit': return sheet_kit(id);
    case 'save-kit': return guard(async () => {
      const ids = picked();
      const name = $('#k-name').value.trim();
      const label = $('#k-shared') ? 'package' : 'kit';
      if (!name) return toast(`Name the ${label}`, true);
      if (!ids.length) return toast('Pick some gear', true);
      const body = { name, item_ids: ids, notes: $('#k-notes').value.trim() };
      // The shared checkbox only exists when editing/creating a package —
      // a physical kit has no personal owner for "shared" to mean anything
      // relative to, so its existing value is left untouched either way.
      if ($('#k-shared')) body.shared = $('#k-shared').checked;
      let kitId = id ? Number(id) : null;
      if (kitId) await PUT(`/api/kits/${kitId}`, body);
      else ({ id: kitId } = await POST('/api/kits', { ...body, type: 'package' }));   // the only creation flow left
      await uploadPendingPhoto('kit', kitId);
      closeSheet();
      await refresh();
      toast(`${label === 'package' ? 'Package' : 'Kit'} saved`);
    });
    /* Every item in the kit goes into the list, including the unavailable
       ones. Preselecting only what was free hid the gap: you'd be told there
       was a conflict without being shown which item, and the kit you thought
       you were taking wasn't the kit in front of you. */
    case 'kit-out': {
      const k = S.kits.find(x => x.id === Number(id));
      const all = k.item_ids.filter(i => item(i));
      const short = all.filter(i => statusOf(i) !== 'ready').length;
      sheet_checkout(all, k.name, '', k.id);
      if (short) toast(`${short} of ${all.length} aren't available — see Conflicts`, true);
      return;
    }
    case 'kit-res': {
      const k = S.kits.find(x => x.id === Number(id));
      return sheet_res(k.item_ids, k.name, '', k.id);
    }
    case 'kit-dup': return guard(async () => {
      const r = await POST(`/api/kits/${id}/duplicate`, {});
      await refresh();
      toast(`Copied as "${r.name}" — it's yours to change`);
    });
    case 'kit-share': return guard(async () => {
      const k = S.kits.find(x => x.id === Number(id));
      const r = await PATCH(`/api/kits/${id}/share`, { shared: !k.shared });
      await refresh();
      toast(r.shared ? 'Shared with the team' : 'Back to private');
    });
    case 'kit-del': return guard(async () => {
      const k = S.kits.find(x => x.id === Number(id));
      const label = k.type === 'kit' ? 'kit' : 'package';
      if (!confirm(`Delete the ${k.name} ${label}? The gear itself stays.`)) return;
      await DEL(`/api/kits/${id}`);
      await refresh();
      toast(`${label === 'kit' ? 'Kit' : 'Package'} deleted`);
    });
    /* ---- reservations ---- */
    case 'res-sort': RES_SORT = b.dataset.sort; return render();
    case 'res-dates': RES_DATES = !RES_DATES; return render();
    case 'res-range': {
      const kind = b.dataset.range;
      const t = today();
      if (kind === 'clear') { RES_FROM = ''; RES_TO = ''; }
      else if (kind === '30') { RES_FROM = t; RES_TO = shift(t, 30); }
      else if (kind === 'month') {
        RES_FROM = t.slice(0, 8) + '01';
        // Day 0 of next month is the last day of this one, leap years included.
        const d = new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7), 0));
        RES_TO = d.toISOString().slice(0, 10);
      } else {                                   // week: Monday to Sunday
        const dow = (new Date(t + 'T12:00:00Z').getUTCDay() + 6) % 7;
        RES_FROM = shift(t, -dow);
        RES_TO = shift(RES_FROM, 6);
      }
      return render();
    }
    case 'add-gear-open': {
      ADD_OPEN = !ADD_OPEN;
      ADD_Q = '';
      const host = $('#add-gear-block');
      const bk = SHEET_BOOKING;
      if (host) {
        host.innerHTML = bk
          ? addGearInner(bk.kind === 'checkout' ? 'checkout-add-items' : 'res-add-items', bk.id)
          : addGearInner();
      }
      if (ADD_OPEN) paintAddList(ADD_EXCLUDE, []);
      return;
    }
    case 'co-more': CO_MORE = !CO_MORE; return sheet_checkout();

    /* ---- requests ---- */
    case 'newcrew-add': {
      const pid = Number($('#newcrew-pick')?.value);
      if (!pid) return;
      if (b.dataset.kind === 'checkout') {
        CART = { ...CART, crew: [...new Set([...(CART.crew || []), pid])] };
        cartSave();
        return $('#pick-list') ? sheet_checkout() : sheet_cart();
      }
      NEW_RES_CREW = [...new Set([...NEW_RES_CREW, pid])];
      return redrawRes();
    }
    case 'newcrew-remove': {
      const pid = Number(b.dataset.person);
      if (b.dataset.kind === 'checkout') {
        CART = { ...CART, crew: (CART.crew || []).filter(x => x !== pid) };
        cartSave();
        return $('#pick-list') ? sheet_checkout() : sheet_cart();
      }
      NEW_RES_CREW = NEW_RES_CREW.filter(x => x !== pid);
      return redrawRes();
    }
    case 'crew-add': return guard(async () => {
      const personId = Number($('#crew-pick')?.value);
      if (!personId) return toast('Pick someone first', true);
      await POST(`/api/${b.dataset.kind}/${id}/contributors`, { person_id: personId });
      await refresh();
      const who = S.people.find(x => x.id === personId);
      redrawSheet();
      toast(`${who?.name || 'They'} can add gear to this now`);
    });
    case 'crew-remove': return guard(async () => {
      await DEL(`/api/${b.dataset.kind}/${id}/contributors/${b.dataset.person}`);
      await refresh();
      redrawSheet();
      toast('Taken off');
    });
    case 'swap-open': {
      SWAP_OPEN = !SWAP_OPEN;
      if (SWAP_OPEN) ASK_OPEN = false;
      /* The gear list gains and loses its tick boxes with this panel, so the
         whole sheet redraws rather than just the block. */
      redrawSheet();
      if (SWAP_OPEN) { SWAP_SRC = 'mine'; SWAP_Q = ''; paintSwapList([]); }
      return;
    }
    case 'swap-src': {
      /* Keep what's already ticked when switching source — you might offer
         one of yours and one off the shelf. */
      const keep = $$('.mine-pick').filter(x => x.checked).map(x => Number(x.value));
      SWAP_SRC = b.dataset.src;
      SWAP_Q = '';
      redrawSheet();
      paintSwapList(keep);
      return;
    }
    case 'swap-send': return guard(async () => {
      const wanted = $$('.their-pick').filter(x => x.checked).map(x => Number(x.value));
      const offered = $$('.mine-pick').filter(x => x.checked).map(x => Number(x.value));
      if (!wanted.length) return toast('Tick what you want from their loan', true);
      if (!offered.length) return toast('Pick what you are offering in exchange', true);
      await POST('/api/requests', {
        kind: 'swap', checkout_id: Number(id),
        item_ids: wanted, offer_item_ids: offered,
        note: $('#swap-note')?.value.trim() || ''
      });
      SWAP_OPEN = false;
      closeSheet();
      await refresh();
      toast('Offer sent — nothing moves until they accept');
    });
    case 'ask-open': {
      ASK_OPEN = !ASK_OPEN;
      ADD_Q = '';
      if (ASK_OPEN) SWAP_OPEN = false;
      const host = $('#ask-block');
      const bk = SHEET_BOOKING;
      if (host && bk) {
        const target = bk.kind === 'checkout'
          ? S.openCheckouts.find(x => x.id === bk.id)
          : S.reservations.find(x => x.id === bk.id);
        const who = target?.holder_name || target?.person_name
          || target?.holder_email || target?.person_email || 'them';
        host.innerHTML = askInner(bk.kind, bk.id, who);
        const swapHost = $('#swap-block');
        if (swapHost && bk.kind === 'checkout') {
          const c = S.openCheckouts.find(x => x.id === bk.id);
          if (c) swapHost.innerHTML = swapInner(c);
        }
        if (ASK_OPEN) {
          ADD_EXCLUDE = target?.item_ids || [];
          paintAddList(ADD_EXCLUDE, []);
        }
      }
      return;
    }
    case 'ask-send': return guard(async () => {
      const ids = pickedAdd();
      if (!ids.length) return toast('Pick the gear you want adding', true);
      const body = { item_ids: ids, note: $('#ask-note')?.value.trim() || '' };
      if (b.dataset.kind === 'checkout') body.checkout_id = Number(id);
      else body.reservation_id = Number(id);
      await POST('/api/requests', body);
      ASK_OPEN = false;
      closeSheet();
      await refresh();
      toast('Request sent — they get an email and see it in the app');
    });
    case 'req-approve': return guard(async () => {
      await POST(`/api/requests/${id}/approve`, {});
      await refresh();
      toast('Approved — the gear is on your booking');
    });
    case 'req-decline': return guard(async () => {
      const reason = prompt('Any reason? (optional)') ?? '';
      await POST(`/api/requests/${id}/decline`, { reason });
      await refresh();
      toast('Declined');
    });
    case 'req-cancel': return guard(async () => {
      await DEL(`/api/requests/${id}`);
      await refresh();
      toast('Withdrawn');
    });

    /* ---- the running checkout ---- */
    case 'cart-add': {
      const it = item(Number(id));
      cartAdd(Number(id), it?.name);
      return render();          // the row's tick and the header count both move
    }
    case 'cart-add-kit': {
      const k = S.kits.find(x => x.id === Number(id));
      if (!k) return;
      const live = k.item_ids.filter(i => item(i));
      CART = setCartKit(CART, k.id);
      cartAdd(live, k.name);
      return render();
    }
    case 'cart-remove': {
      CART = removeFromCart(CART, Number(id));
      cartSave();
      if (CUSTOM_SWAP_FOR === Number(id)) { CUSTOM_SWAP_FOR = null; CUSTOM_SWAP_Q = ''; }
      return sheet_cart();
    }
    case 'cart-swap': {
      const out = Number(id), into = Number(b.dataset.to);
      CART = addSwappedOut(addToCart(removeFromCart(CART, out), into), out);
      cartSave();
      if (CUSTOM_SWAP_FOR === out) { CUSTOM_SWAP_FOR = null; CUSTOM_SWAP_Q = ''; }
      toast(`Swapped in ${item(into)?.name || 'the spare'}`);
      return sheet_cart();
    }
    /* Straight from the clash to the person holding it — that's the moment
       you learn there's a problem, so it's the moment to offer the trade. */
    case 'cart-trade': {
      closeSheet();
      sheet_openCheckout(Number(id));
      SWAP_OPEN = true;
      redrawSheet();
      const box = $(`.their-pick[value="${b.dataset.item}"]`);
      if (box) box.checked = true;
      SWAP_SRC = 'mine'; SWAP_Q = '';
      paintSwapList([]);
      return;
    }
    case 'cart-more': return sheet_checkout();
    case 'cart-review': CUSTOM_SWAP_FOR = null; CUSTOM_SWAP_Q = ''; return sheet_cart();
    case 'cart-confirm': return guard(async () => {
      const ids = CART.items;
      if (!ids.length) return toast('Nothing to check out', true);
      const r = await POST('/api/checkouts', {
        item_ids: ids,
        due_on: $('#co-due').value,
        shoot: $('#co-shoot').value.trim(),
        project: $('#co-project').value.trim(),
        holder_id: Number($('#co-holder').value) || undefined,
        contributor_ids: CART.crew || [],
        kit_id: CART.kit_id || undefined,
        override: $('#co-override')?.checked || false,
        swapped_out: CART.swapped_out || []
      });
      CART = emptyCart();
      cartSave();
      closeSheet();
      await refresh();
      toast(r.warnings?.length
        ? `Checked out with ${r.warnings.length} override(s)`
        : `${ids.length} item(s) out`);
    });
    case 'cart-clear': {
      if (!confirm(`Empty your checkout? ${cartCount(CART)} item(s) will be dropped.`)) return;
      CART = emptyCart();
      cartSave();
      closeSheet();
      return render();
    }
    case 'open-cart': CUSTOM_SWAP_FOR = null; CUSTOM_SWAP_Q = ''; return sheet_cart();
    case 'appearance': return sheet_appearance();
    case 'set-appearance': {
      const v = b.dataset.value;
      APPEARANCE = { ...APPEARANCE, [b.dataset.key]: v === 'true' ? true : v === 'false' ? false : v };
      applyAppearance();
      return sheet_appearance();   // redraw so the pressed state follows
    }
    case 'pick-tl': PICK_TL = b.dataset.tl; return paintPicker();
    /* Stack a kit onto whatever is already ticked, so two packages can go out
       on one checkout. Retired gear is dropped rather than silently failing. */
    case 'add-kit': {
      const k = S.kits.find(x => x.id === Number(id));
      if (!k) return;
      const add = k.item_ids.filter(i => item(i));
      paintPickList([...new Set([...picked(), ...add])]);
      paintPicker();
      // Ticking these boxes was done in code, not by a click, so the usual
      // pick-changed listener never fires — the cart (or the in-progress
      // reservation's kit_id) has to be told directly. preflight() asks the
      // checkout endpoint specifically, so it only makes sense here too.
      if (PICK_CTX === 'reserve') NEW_RES_KIT_ID = NEW_RES_KIT_ID ?? k.id;
      else { CART = setCartKit(CART, k.id); syncCartFromPicker(); preflight(); }
      // Reset whichever dropdown this came from — leaving it pointed at what
      // was just added reads as though nothing happened, and a second click
      // on a stale selection would just add the same kit again.
      for (const [selId, btnId] of [['pkg-start-pick', 'pkg-start-add'], ['kit-start-pick', 'kit-start-add']]) {
        const sel = $(`#${selId}`);
        if (sel && sel.value === id) {
          sel.value = '';
          const addBtn = $(`#${btnId}`);
          if (addBtn) { addBtn.dataset.id = ''; addBtn.disabled = true; }
        }
      }
      const short = add.filter(i => statusOf(i) !== 'ready').length;
      return toast(short
        ? `Added ${k.name} — ${short} aren't available, see Conflicts`
        : `Added ${k.name}`, Boolean(short));
    }
    case 'swap-item': {
      const out = Number(id), into = Number(b.dataset.to);
      const next = picked().filter(x => x !== out);
      if (!next.includes(into)) next.push(into);
      if (CUSTOM_SWAP_FOR === out) { CUSTOM_SWAP_FOR = null; CUSTOM_SWAP_Q = ''; }
      // The swapped-out item never makes it into the final item_ids — that's
      // the point of a swap — so it's tracked separately and sent alongside
      // the submit, or the demand it represents never reaches the usage
      // report. Checkout persists this in the cart (it survives a redraw or
      // a trip elsewhere the same way items/crew do); a reservation that
      // doesn't exist yet has nowhere else to keep it.
      if (PICK_CTX === 'checkout') { CART = addSwappedOut(CART, out); cartSave(); }
      else SWAPPED_OUT = [...new Set([...SWAPPED_OUT, out])];
      paintPickList(next);
      paintPicker();
      if (PICK_CTX === 'checkout') {
        // paintPickList just ticked/unticked boxes in code, not by a real
        // click — the one thing that normally keeps CART.items in step (see
        // the ticking-a-.pick-checkbox-by-code gotcha). Left unsynced,
        // CART.items still shows the swapped-out item until some other real
        // click happens to catch it up.
        syncCartFromPicker();
        preflight();
      }
      return toast(`Swapped in ${item(into)?.name || 'the spare'}`);
    }
    case 'drop-item': {
      if (CUSTOM_SWAP_FOR === Number(id)) { CUSTOM_SWAP_FOR = null; CUSTOM_SWAP_Q = ''; }
      paintPickList(picked().filter(x => x !== Number(id)));
      paintPicker();
      if (PICK_CTX === 'checkout') { syncCartFromPicker(); preflight(); }   // see swap-item
      return;
    }
    /* Opens (or closes) the "choose a different item" search for one clash.
       Accordion, not a checklist per row — the toggle is the same action
       whichever screen it's on; the swap it eventually performs is decided
       by paintCustomSwapResults from what's on screen (picker vs review). */
    case 'custom-swap-open': {
      const target = Number(id);
      CUSTOM_SWAP_FOR = CUSTOM_SWAP_FOR === target ? null : target;
      CUSTOM_SWAP_Q = '';
      if ($('#pick-list')) refreshSwaps(); else sheet_cart();
      paintCustomSwapResults();
      return;
    }

    /* ---- admin ---- */
    case 'save-settings': return guard(async () => {
      const payload = {};
      $$('[data-setting]').forEach(el => { payload[el.dataset.setting] = el.checked ? 'true' : 'false'; });
      payload.default_loan_days = $('#s-loan').value;
      payload.overdue_grace_days = $('#s-grace').value;
      payload.reminder_hour = $('#s-hour').value;
      payload.escalate_after_days = $('#s-esc').value;
      await PUT('/api/settings', payload);
      await refresh();
      toast('Settings saved. Reminder hour applies after the next restart.');
    });
    case 'save-person': return guard(async () => {
      if (!id) {
        const email = $('#p-email').value.trim();
        if (!email) return toast('Email is required', true);
        const { id: personId } = await POST('/api/people', {
          email,
          name: $('#p-name').value.trim(),
          role: $('#p-role').checked ? 'admin' : 'member'
        });
        await uploadPendingPhoto('person', personId);
        closeSheet();
        await refresh();
        return toast('Person added');
      }
      const reason = $('#p-reason').value.trim();
      await PATCH(`/api/people/${id}`, {
        name: $('#p-name').value.trim(),
        blocked_reason: reason || null
      });
      closeSheet();
      await refresh();
      toast('Saved');
    });
    case 'toggle-block': return guard(async () => {
      const p = S.people.find(x => x.id === Number(id));
      await PATCH(`/api/people/${id}`, {
        blocked: !p.blocked,
        blocked_reason: !p.blocked ? ($('#p-reason')?.value.trim() || 'Blocked by an admin') : null
      });
      closeSheet();
      await refresh();
      toast(p.blocked ? 'Checkouts allowed' : 'Checkouts blocked');
    });
    case 'toggle-role': return guard(async () => {
      const p = S.people.find(x => x.id === Number(id));
      await PATCH(`/api/people/${id}`, { role: p.role === 'admin' ? 'member' : 'admin' });
      closeSheet();
      await refresh();
      toast('Role updated');
    });

    /* ---- csv import ---- */
    case 'import-items': closeSheet(); IMPORT_ITEMS = { csv: null, fetchImages: true, result: null }; return sheet_importItems();
    case 'import-items-preview': return guard(async () => {
      const file = $('#imp-items-file')?.files[0];
      if (!file) return toast('Choose a CSV file first', true);
      const csv = await readFileAsText(file);
      IMPORT_ITEMS.csv = csv;
      IMPORT_ITEMS.fetchImages = $('#imp-items-images').checked;
      IMPORT_ITEMS.result = await POST('/api/import/items', { csv, dry: true });
      sheet_importItems();
    });
    case 'import-items-confirm': return guard(async () => {
      if (!IMPORT_ITEMS.csv) return toast('Preview first', true);
      IMPORT_ITEMS.result = await POST('/api/import/items', {
        csv: IMPORT_ITEMS.csv, dry: false, fetchImages: IMPORT_ITEMS.fetchImages
      });
      sheet_importItems();
      await refresh();
      toast(`Imported: ${IMPORT_ITEMS.result.created} new, ${IMPORT_ITEMS.result.updated} updated`);
    });

    case 'import-orders': closeSheet();
      IMPORT_ORDERS = { csv: null, kind: 'checkout', allowPlaceholders: false, notifyImmediately: false, peopleMap: '', result: null };
      return sheet_importOrders();
    case 'import-orders-preview': return guard(async () => {
      const file = $('#imp-ord-file')?.files[0];
      if (!file) return toast('Choose a CSV file first', true);
      IMPORT_ORDERS.csv = await readFileAsText(file);
      IMPORT_ORDERS.kind = $('#imp-ord-kind').value;
      IMPORT_ORDERS.allowPlaceholders = $('#imp-ord-stubs').checked;
      IMPORT_ORDERS.notifyImmediately = $('#imp-ord-notify').checked;
      IMPORT_ORDERS.peopleMap = $('#imp-ord-map').value;
      IMPORT_ORDERS.result = await POST('/api/import/orders', {
        csv: IMPORT_ORDERS.csv, kind: IMPORT_ORDERS.kind, dry: true,
        allowPlaceholders: IMPORT_ORDERS.allowPlaceholders,
        notifyImmediately: IMPORT_ORDERS.notifyImmediately,
        peopleMap: IMPORT_ORDERS.peopleMap
      });
      sheet_importOrders();
    });
    case 'import-orders-confirm': return guard(async () => {
      if (!IMPORT_ORDERS.csv) return toast('Preview first', true);
      IMPORT_ORDERS.result = await POST('/api/import/orders', {
        csv: IMPORT_ORDERS.csv, kind: IMPORT_ORDERS.kind, dry: false,
        allowPlaceholders: IMPORT_ORDERS.allowPlaceholders,
        notifyImmediately: IMPORT_ORDERS.notifyImmediately,
        peopleMap: IMPORT_ORDERS.peopleMap
      });
      sheet_importOrders();
      await refresh();
      toast(`Imported ${IMPORT_ORDERS.result.created} ${IMPORT_ORDERS.kind}(s)`);
    });

    case 'run-reminders': return guard(async () => {
      const r = await POST('/api/tasks/reminders/manual');
      toast(r.sent.length
        ? `Sent ${r.sent.length} message(s) for ${r.today}`
        : `Nothing to send for ${r.today} — already went out or nothing is due`);
    });
    case 'audit-log': return guard(sheet_auditLog);
    case 'audit-more': return guard(() => loadAuditPage({ append: true }));

    case 'usage-report': return guard(sheet_usageReport);
    case 'usage-preset': {
      USAGE_TO = S.today;
      USAGE_FROM = shiftDate(S.today, -(Number(id) - 1));
      const controls = $('#usage-controls');
      if (controls) controls.innerHTML = usageRangeControls();
      return guard(loadUsageReport);
    }
    case 'usage-toggle':
      USAGE_OPEN = USAGE_OPEN === Number(id) ? null : Number(id);
      paintUsageReport();
      return;
    case 'usage-sort':
      // Clicking the column you're already sorted by flips direction,
      // same as any spreadsheet; clicking a new one starts descending —
      // "most days out" is almost always the more useful first look.
      USAGE_SORT = USAGE_SORT.key === id
        ? { key: id, dir: USAGE_SORT.dir === 'asc' ? 'desc' : 'asc' }
        : { key: id, dir: 'desc' };
      paintUsageReport();
      return;

    /* ---- calendar tab ---- */
    case 'cal-shift': {
      const by = Number(b.dataset.by);
      const anchor = CAL.from || S.today;
      CAL.from = b.dataset.unit === 'month'
        ? addMonths(startOfMonth(anchor), by)
        : shiftDate(anchor, by * calWindow().days);
      render();
      loadCalendar();
      return;
    }
    case 'cal-today': CAL.from = S.today; render(); loadCalendar(); return;
    case 'cal-span': {
      const v = b.dataset.span;
      CAL.span = v === 'month' ? 'month' : Number(v);
      render();
      loadCalendar();
      return;
    }
    case 'cal-group': CAL.group = b.dataset.group; return render();
    case 'cal-scope': CAL.scope = b.dataset.scope; return render();
    case 'cal-cat': CAL.cat = b.dataset.cat; return render();
    case 'cal-heat': CAL.heat = !CAL.heat; return render();
    case 'cal-heat-group': {
      const g = b.dataset.group;
      CAL.heatGroups = { ...CAL.heatGroups, [g]: !CAL.heatGroups[g] };
      return render();
    }
    case 'cal-find-clear':
      CAL.find = ''; CAL.hi = null; CAL.findErr = false;
      return render();
    case 'cal-gear-clear': CAL.gear = ''; return render();
    case 'cal-listshow': CAL.listShow = b.dataset.show; return render();
    case 'cal-range-clear':
      CAL.rangeFrom = null; CAL.rangeTo = null;
      render();
      return loadCalendar();
    case 'res-from-gap': {
      // A free stretch in the list is a ready-made reservation.
      closeSheet();
      sheet_res([Number(id)]);
      const start = $('#r-start'), end = $('#r-end');
      if (start && end) {
        start.value = b.dataset.start;
        end.value = b.dataset.end;
        PICK.start = b.dataset.start;
        PICK.end = b.dataset.end;
        PICK.from = null;
        paintPickList();
        paintPicker();
      }
      return;
    }

    /* ---- the scheduling picker ---- */
    case 'tl-pick': {
      const d = b.dataset.date;
      const startEl = $('#r-start');
      if (!startEl) {
        // Checkouts always start today, so a tap only moves the due date.
        PICK.end = d < S.today ? S.today : d;
      } else if (PICK.mode === 'start') {
        PICK.start = d;
        PICK.end = d;
        PICK.mode = 'end';
      } else {
        if (d < PICK.start) { PICK.start = d; } else { PICK.end = d; }
        PICK.mode = 'start';
      }
      syncPickerToDates();
      paintPickList();
      paintPicker();
      clearTimeout(preflightTimer);
      preflightTimer = setTimeout(preflight, 200);
      return;
    }
    case 'tl-apply': {
      PICK.start = b.dataset.start;
      PICK.end = b.dataset.end;
      PICK.from = shiftDate(PICK.start, -2) < S.today ? S.today : shiftDate(PICK.start, -2);
      PICK.mode = 'start';
      syncPickerToDates();
      paintPickList();
      paintPicker();
      clearTimeout(preflightTimer);
      preflightTimer = setTimeout(preflight, 200);
      toast(`Moved to ${PICK.start} → ${PICK.end}`);
      return;
    }
    case 'tl-shift': {
      PICK.from = shiftDate(pickerFrom(), Number(b.dataset.by));
      paintPicker();
      return;
    }
    case 'tl-open': {
      closeSheet();
      return sheet_booking(b.dataset.kind, Number(b.dataset.id));
    }

    /* ---- scanning ---- */
    case 'start-cam': return startCam();
    case 'stop-cam': stopCam(); $('#cam-wrap').innerHTML = ''; return;
    case 'lookup': {
      // codeFromScan handles a pasted tag URL the same way the camera does —
      // typing and scanning end up at the same code either way.
      const v = codeFromScan($('#code').value).toLowerCase();
      const hit = S.items.find(i => i.code.toLowerCase() === v || (i.serial && i.serial.toLowerCase() === v));
      if (hit) sheet_item(hit.id); else toast('No gear with that code', true);
      return;
    }
    case 'scan-remove': {
      SCAN_ITEMS = SCAN_ITEMS.filter(x => x !== Number(id));
      const box = $('#scan-results');
      if (box) box.innerHTML = scanResultsBlock();
      return;
    }
    case 'scan-clear': {
      SCAN_ITEMS = [];
      const box = $('#scan-results');
      if (box) box.innerHTML = '';
      return;
    }
    case 'scan-checkout': {
      const ids = SCAN_ITEMS;
      stopCam();
      $('#cam-wrap').innerHTML = '';
      return sheet_checkout(ids);
    }
    case 'scan-reserve': {
      const ids = SCAN_ITEMS;
      stopCam();
      $('#cam-wrap').innerHTML = '';
      return sheet_res(ids);
    }
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'r-repeat') {
    const fields = $('#r-repeat-fields');
    if (fields) fields.hidden = !e.target.checked;
    return;
  }
  if (e.target.id === 'audit-q' || e.target.id === 'audit-person') {
    if (e.target.id === 'audit-q') AUDIT_Q = e.target.value;
    else AUDIT_PERSON = e.target.value;
    clearTimeout(auditSearchTimer);
    auditSearchTimer = setTimeout(() => loadAuditPage(), 220);
    return;
  }
  if (e.target.id === 'usage-from' || e.target.id === 'usage-to') {
    if (!e.target.value) return;
    if (e.target.id === 'usage-from') USAGE_FROM = e.target.value;
    else USAGE_TO = e.target.value;
    if (USAGE_FROM > USAGE_TO) return;   // wait for the other end to catch up
    const csv = $('#usage-controls a[download]');
    if (csv) csv.href = `/api/reports/usage?from=${USAGE_FROM}&to=${USAGE_TO}&format=csv`;
    clearTimeout(usageDateTimer);
    usageDateTimer = setTimeout(() => loadUsageReport(), 220);
    return;
  }
  if (e.target.id === 'usage-q') {
    USAGE_Q = e.target.value;
    paintUsageReport();   // client-side filter over rows already loaded — no debounce needed
    return;
  }
  if (e.target.id === 'photo-file') {
    const kind = e.target.dataset.kind, id = e.target.dataset.id;
    const file = e.target.files?.[0];
    if (!file) return;
    if (!PHOTO_TYPES.includes(file.type)) {
      toast('Only JPG, PNG or WEBP photos are supported.', true);
      e.target.value = '';
      return;
    }
    if (file.size > PHOTO_MAX_BYTES) {
      toast('That photo is over the 5MB limit.', true);
      e.target.value = '';
      return;
    }
    // Shown immediately, win or lose — a photo the size of the DOM node it's
    // going into doesn't need a round trip to preview.
    const localUrl = URL.createObjectURL(file);
    const preview = $('#photo-preview');
    if (preview) {
      preview.innerHTML = kind === 'person'
        ? `<span class="avatar large"><img src="${localUrl}" alt=""></span>`
        : photoWrapper(kind, `<img src="${localUrl}" alt="">`);
    }
    $('#photo-remove-btn')?.removeAttribute('hidden');

    if (!id) {
      // Nothing to attach it to yet — save-item/save-kit/save-person uploads
      // it themselves once creating the record hands back a real id.
      PENDING_PHOTO = { kind, file };
      return;
    }
    // guard() is only in scope inside the click handler below — this is the
    // input listener, so the same try/catch/toast happens by hand instead.
    (async () => {
      try {
        const r = await uploadPhoto(`/api/${photoPath(kind)}/${id}/photo`, file);
        setLocalImage(kind, id, true, r.image_v);
        toast('Photo saved');
      } catch (err) {
        toast(err.message, true);
      }
    })();
    return;
  }
  if (e.target.id === 'cal-from' || e.target.id === 'cal-to') {
    const v = e.target.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;   // mid-typing
    if (e.target.id === 'cal-from') CAL.rangeFrom = v; else CAL.rangeTo = v;
    // Keep them the right way round rather than rendering an empty period.
    if (CAL.rangeFrom && CAL.rangeTo && CAL.rangeTo < CAL.rangeFrom) {
      if (e.target.id === 'cal-from') CAL.rangeTo = CAL.rangeFrom;
      else CAL.rangeFrom = CAL.rangeTo;
    }
    render();
    loadCalendar();
    return;
  }
  if (e.target.id === 'cal-gear') {
    CAL.gear = e.target.value;
    const y = window.scrollY;
    render();
    window.scrollTo({ top: y });
    const box = $('#cal-gear');
    if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    return;
  }
  if (e.target.id === 'cal-find') {
    CAL.find = e.target.value;
    const range = parseDayQuery(CAL.find, { today: S.today });
    CAL.hi = range;
    CAL.findErr = Boolean(CAL.find.trim()) && !range;
    if (range) focusRange(range);
    // In the list, typing a range is the natural way to set its period —
    // "aug 14 to aug 20" should scope the list, not just highlight days.
    if (range && CAL.group === 'list' && range.start !== range.end) {
      CAL.rangeFrom = range.start;
      CAL.rangeTo = range.end;
    }
    const y = window.scrollY;
    render();
    window.scrollTo({ top: y });
    const box = $('#cal-find');
    if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    if (range) loadCalendar();
    return;
  }
  if (e.target.id === 'q') {
    QUERY = e.target.value;
    const y = window.scrollY;
    render();
    window.scrollTo({ top: y });
    const box = $('#q');
    if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    return;
  }
  if (e.target.classList.contains('gear-pick')) {
    const id = Number(e.target.value);
    if (e.target.checked) GEAR_PICKED.add(id); else GEAR_PICKED.delete(id);
    // A full re-render, same as any other Gear tab toggle — but scrolled back
    // to where it was, since ticking gear is usually more than one row.
    const y = window.scrollY;
    render();
    window.scrollTo({ top: y });
    return;
  }
  /* The picker lives inside an open sheet, so this repaints the list in place
     rather than re-rendering the view and losing the sheet. */
  if (e.target.classList.contains('add-pick')) {
    /* The action button sits above the list now, so it has to say how much it
       will act on — otherwise you'd scroll back down to check what's ticked. */
    const n = $('#ask-count');
    if (n) {
      const picked = pickedAdd().length;
      n.textContent = picked ? ` ${picked} item${picked === 1 ? '' : 's'}` : '';
    }
    return;
  }
  if (e.target.id === 'swap-q') {
    SWAP_Q = e.target.value;
    paintSwapList();
    return;
  }
  if (e.target.id === 'custom-swap-q') {
    CUSTOM_SWAP_Q = e.target.value;
    paintCustomSwapResults();
    return;
  }
  if (e.target.id === 'maint-item-q') {
    MAINT_ITEM_Q = e.target.value;
    paintMaintItemResults();
    return;
  }
  if (e.target.id === 'pkg-start-pick' || e.target.id === 'kit-start-pick') {
    /* The button carries the chosen id as its own data-id, so the shared
       add-kit handler needs no idea whether it was clicked from a dropdown
       or a row — same as it never needed to know which page it was on. */
    const btn = $(e.target.id === 'pkg-start-pick' ? '#pkg-start-add' : '#kit-start-add');
    if (btn) {
      btn.dataset.id = e.target.value;
      btn.disabled = !e.target.value;
    }
    return;
  }
  if (e.target.id === 'newcrew-pick') {
    const btn = $('#newcrew-btn');
    if (btn) {
      const chosen = Boolean(e.target.value);
      btn.classList.toggle('primary', chosen);
      btn.disabled = !chosen;
    }
    return;
  }
  if (e.target.id === 'crew-pick') {
    /* Selecting a name is only half the job; the button has to look like the
       other half. Accent + enabled is the cue that something is waiting. */
    const btn = $('#crew-add-btn');
    if (btn) {
      const chosen = Boolean(e.target.value);
      btn.classList.toggle('primary', chosen);
      btn.disabled = !chosen;
    }
    return;
  }
  if (e.target.id === 'kit-pick-q') {
    KIT_PICK_Q = e.target.value;
    paintKitPickList();
    return;
  }
  if (e.target.id === 'pick-q') {
    PICK_Q = e.target.value;
    paintPickList();
    return;
  }
  if (e.target.id === 'res-q' || e.target.id === 'res-who'
      || e.target.id === 'res-from' || e.target.id === 'res-to') {
    if (e.target.id === 'res-q') RES_Q = e.target.value;
    if (e.target.id === 'res-who') RES_WHO = e.target.value;
    if (e.target.id === 'res-from') RES_FROM = e.target.value;
    if (e.target.id === 'res-to') RES_TO = e.target.value;
    // Keep them the right way round rather than filtering to nothing.
    if (RES_FROM && RES_TO && RES_TO < RES_FROM) {
      if (e.target.id === 'res-from') RES_TO = RES_FROM; else RES_FROM = RES_TO;
    }
    const y = window.scrollY;
    render();
    window.scrollTo({ top: y });
    const box = $('#' + e.target.id);
    if (box) {
      box.focus();
      if (box.type === 'search') box.setSelectionRange(box.value.length, box.value.length);
    }
    return;
  }
  if (e.target.id === 'add-q') {
    ADD_Q = e.target.value;
    paintAddList(ADD_EXCLUDE);
    return;
  }
  if (e.target.id === 'kit-q') {
    KIT_Q = e.target.value;
    const y = window.scrollY;
    render();
    window.scrollTo({ top: y });
    const box = $('#kit-q');
    if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    return;
  }
  if (e.target.id === 'pkg-q') {
    PKG_Q = e.target.value;
    const y = window.scrollY;
    render();
    window.scrollTo({ top: y });
    const box = $('#pkg-q');
    if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    return;
  }
  /* Every edit inside the checkout sheet writes straight through to the cart,
     so wandering off to look at a clash costs nothing. */
  if (PICK_CTX === 'checkout'
      && (e.target.classList.contains('pick') || ['co-due', 'co-shoot', 'co-project'].includes(e.target.id))) {
    syncCartFromPicker();
    if (!$('#pick-list')) { clearTimeout(preflightTimer); preflightTimer = setTimeout(preflightCart, 220); }
  }
  if (e.target.classList.contains('pick') || ['co-due', 'co-holder', 'co-override'].includes(e.target.id)) {
    if (['co-due'].includes(e.target.id)) { syncDatesToPicker(); PICK.from = null; }
    // The window or the holder moved, so what counts as free moved with it.
    if (['co-due', 'co-holder'].includes(e.target.id)) paintPickList();
    // Ticking something that's out deserves the same offer of a spare as
    // adding a kit does — repaint the panel without rebuilding the list,
    // which would throw away the scroll position mid-tick.
    else refreshSwaps();
    paintPicker();
    // preflight() asks the *checkout* endpoint "what if this went out today" —
    // right question in the checkout sheet, actively misleading in the
    // reserve sheet, where it would report today's conflicts against a
    // window that might be months away. The reserve sheet gets its own
    // answer from save-res's response instead, when it's actually submitted.
    if (PICK_CTX === 'checkout') {
      clearTimeout(preflightTimer);
      preflightTimer = setTimeout(preflight, 220);
    }
  }
  if (['r-start', 'r-end', 'r-person'].includes(e.target.id)) {
    syncDatesToPicker();
    PICK.from = null;
    PICK.mode = 'start';
    paintPickList();
    paintPicker();
  }
});

/**
 * The timeline's column width is computed in JS, so CSS alone can't reflow it.
 * Without this, dragging a window between a laptop and a 4K display left the
 * board at whatever size it happened to render at.
 *
 * Only re-renders when the width would actually change, and puts focus and
 * scroll back, so typing in a search box while resizing doesn't lose the
 * cursor.
 */
let resizeTimer = null;

window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!S || TAB !== 'calendar') return;
    const next = cellWidth();
    if (next === lastCell) return;

    const active = document.activeElement;
    const id = active && active.id;
    const caret = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;
    const y = window.scrollY;

    render();

    window.scrollTo({ top: y });
    if (id) {
      const el = document.getElementById(id);
      if (el) {
        el.focus();
        if (caret !== null && el.setSelectionRange) {
          try { el.setSelectionRange(caret, caret); } catch { /* date inputs refuse */ }
        }
      }
    }
  }, 150);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
  if (e.key === 'Enter') {
    if (e.target.id === 'code') $('[data-act="lookup"]')?.click();
    if (e.target.id === 'gate-email') $('[data-act="request-link"]')?.click();
  }
});

/* ============================ boot ============================ */

(async function boot() {
  try {
    const me = await GET('/auth/me');
    AUTH_OFF = Boolean(me.auth_disabled);
  } catch {
    $('#gate').hidden = false;
    return;
  }
  $('#gate').hidden = true;
  /* Belt and braces: index.html applies this before first paint, but the
     single-file build and any stale cached shell get it here too. */
  await refresh();
  /* Now that the server has said who this is, switch to their settings. The
     pre-paint guess used the last person on this device, so this is usually
     a no-op. */
  APPEARANCE = readAppearance(S.me?.id);
  applyAppearance();
  CART = loadCart(S.me?.id);
  const restored = pruneCart(CART, S.items);
  CART = restored.cart;
  cartSave();

  // A QR label deep-links to /?code=LC-123 — open that item straight away.
  const code = new URLSearchParams(location.search).get('code');
  if (code) {
    const hit = S.items.find(i => i.code.toLowerCase() === code.toLowerCase());
    if (hit) sheet_item(hit.id); else toast(`No gear matches ${code}`, true);
    history.replaceState({}, '', '/');
  }

  openSharedKitFromUrl();
  // Someone pasting a link into the address bar of an already-open tab only
  // changes the hash, which doesn't reload anything.
  addEventListener('hashchange', openSharedKitFromUrl);
})();
