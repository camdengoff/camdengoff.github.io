/**
 * The running checkout — "add to checkout" from anywhere, confirm later.
 *
 * It holds *intentions*, not bookings. Nothing here reserves anything: the
 * gear stays available to everyone until the checkout is actually confirmed,
 * and the server re-checks the whole list at that moment. A cart that quietly
 * held gear would be worse than no cart, because it would take kit off the
 * shelf for someone who wandered off mid-thought.
 *
 * It survives reloads, which is the point — the common way to lose a
 * half-built checkout is to go and look at whoever you're clashing with.
 *
 * Keyed per person, so two people sharing a browser don't inherit each
 * other's list, and a stale cart doesn't reappear under a new name.
 *
 * Pure except for the storage calls, which are injected so this can be tested
 * without a browser.
 */

export const CART_VERSION = 1;
const KEY = 'the-cage-cart-v1';

const memory = new Map();
/* localStorage throws in private mode and in a file:// sandbox, so every
   access is guarded and falls back to memory — a cart that vanishes on
   reload still beats an app that won't load. */
const safeStore = {
  get(k) {
    try { return globalThis.localStorage?.getItem(k) ?? memory.get(k) ?? null; }
    catch { return memory.get(k) ?? null; }
  },
  set(k, v) {
    memory.set(k, v);
    try { globalThis.localStorage?.setItem(k, v); } catch { /* memory holds it */ }
  }
};

export const cartKey = personId => `${KEY}:${personId ?? 'anon'}`;

export function emptyCart() {
  return { v: CART_VERSION, items: [], due: '', shoot: '', project: '', crew: [], kit_id: null, swapped_out: [] };
}

/* Number(null) is 0 and Number.isInteger(0) is true, so a plain integer check
   quietly turns a null into item id 0. Ids are positive. */
const isId = v => Number.isInteger(v) && v > 0;

/** Reject anything that isn't a cart we wrote, rather than half-trusting it. */
export function normaliseCart(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== CART_VERSION) return emptyCart();
  const items = Array.isArray(raw.items)
    ? [...new Set(raw.items.map(Number).filter(isId))]
    : [];
  return {
    v: CART_VERSION,
    items,
    due: typeof raw.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.due) ? raw.due : '',
    /* Added after v1, like crew: a cart written before the shoot field
       existed simply has none rather than being rejected wholesale. */
    shoot: typeof raw.shoot === 'string' ? raw.shoot.slice(0, 200) : '',
    project: typeof raw.project === 'string' ? raw.project.slice(0, 200) : '',
    /* Who else is on this checkout, chosen before it exists. Added without a
       version bump: a cart written before this simply has none. */
    crew: Array.isArray(raw.crew) ? [...new Set(raw.crew.map(Number).filter(isId))] : [],
    /* Which kit (if any) started this checkout, so the eventual booking can
       say "Aputure B7C Kit" instead of listing every item. Added the same
       way as crew — a cart written before this simply has none. */
    kit_id: isId(Number(raw.kit_id)) ? Number(raw.kit_id) : null,
    /* Items swapped away from in the picker's Conflicts panel — never in
       `items` (a swap replaces one with the other), so this is the only
       record that one was ever wanted. Sent to the server at submit time so
       it can log the demand even though the swapped-out item itself never
       appears in the checkout. Added the same way as crew/kit_id. */
    swapped_out: Array.isArray(raw.swapped_out) ? [...new Set(raw.swapped_out.map(Number).filter(isId))] : []
  };
}

export function loadCart(personId, store = safeStore) {
  try { return normaliseCart(JSON.parse(store.get(cartKey(personId)) || 'null')); }
  catch { return emptyCart(); }
}

export function saveCart(personId, cart, store = safeStore) {
  const clean = normaliseCart(cart);
  store.set(cartKey(personId), JSON.stringify(clean));
  return clean;
}

/** Adding is a union, so "add this kit" twice doesn't double anything up. */
export function addToCart(cart, ids) {
  const add = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(isId);
  return { ...normaliseCart(cart), items: [...new Set([...normaliseCart(cart).items, ...add])] };
}

/**
 * Remember which kit started this checkout — first one wins. Adding a
 * second kit, or ad-hoc gear on top, doesn't reassign it; the booking still
 * remembers where it began, and anything beyond that kit's own contents
 * shows up as "+ N more" rather than replacing the label.
 */
export function setCartKit(cart, kitId) {
  const c = normaliseCart(cart);
  if (c.kit_id) return c;
  return { ...c, kit_id: isId(Number(kitId)) ? Number(kitId) : null };
}

export function removeFromCart(cart, ids) {
  const drop = new Set((Array.isArray(ids) ? ids : [ids]).map(Number));
  return { ...normaliseCart(cart), items: normaliseCart(cart).items.filter(i => !drop.has(i)) };
}

/** A union like addToCart, so re-swapping the same item twice in one
    session doesn't record it twice. */
export function addSwappedOut(cart, id) {
  const c = normaliseCart(cart);
  return isId(Number(id)) ? { ...c, swapped_out: [...new Set([...c.swapped_out, Number(id)])] } : c;
}

export const cartHas = (cart, id) => normaliseCart(cart).items.includes(Number(id));
export const cartCount = cart => normaliseCart(cart).items.length;

/**
 * Drop gear that no longer exists or has been retired since it went in.
 * A cart can sit for days; the inventory doesn't hold still for it.
 */
export function pruneCart(cart, items) {
  const live = new Set((items || []).filter(i => i && !i.retired).map(i => i.id));
  const c = normaliseCart(cart);
  const kept = c.items.filter(i => live.has(i));
  return { cart: { ...c, items: kept }, dropped: c.items.length - kept.length };
}
