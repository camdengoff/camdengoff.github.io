import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  emptyCart, normaliseCart, addToCart, removeFromCart, cartHas, cartCount,
  pruneCart, loadCart, saveCart, cartKey, CART_VERSION, setCartKit, addSwappedOut
} from '../public/cart.js';

const fakeStore = () => {
  const m = new Map();
  return { get: k => m.get(k) ?? null, set: (k, v) => m.set(k, v), _m: m };
};

test('a new cart is empty and versioned', () => {
  const c = emptyCart();
  assert.deepEqual(c.items, []);
  assert.equal(c.v, CART_VERSION);
});

test('adding is a union, so adding the same kit twice changes nothing', () => {
  let c = addToCart(emptyCart(), [1, 2, 3]);
  c = addToCart(c, [2, 3, 4]);
  assert.deepEqual(c.items, [1, 2, 3, 4]);
});

test('a single id works as well as a list', () => {
  assert.deepEqual(addToCart(emptyCart(), 7).items, [7]);
  assert.deepEqual(removeFromCart(addToCart(emptyCart(), [7, 8]), 7).items, [8]);
});

test('removing something that was never there is not an error', () => {
  assert.deepEqual(removeFromCart(addToCart(emptyCart(), [1]), [99]).items, [1]);
});

test('cartHas and cartCount read what you would expect', () => {
  const c = addToCart(emptyCart(), [4, 5]);
  assert.equal(cartHas(c, 4), true);
  assert.equal(cartHas(c, '5'), true, 'ids arrive from data attributes as strings');
  assert.equal(cartHas(c, 6), false);
  assert.equal(cartCount(c), 2);
});

/* This comes back from localStorage, which anything on the machine can write,
   so it either parses as ours or it's discarded. */
test('a cart from another version is discarded, not half-read', () => {
  assert.deepEqual(normaliseCart({ v: 99, items: [1, 2] }).items, []);
  assert.deepEqual(normaliseCart(null).items, []);
  assert.deepEqual(normaliseCart('nonsense').items, []);
  assert.deepEqual(normaliseCart({ v: CART_VERSION }).items, []);
});

test('junk inside a cart is filtered rather than trusted', () => {
  const c = normaliseCart({ v: CART_VERSION, items: [1, 'x', null, 2.5, 2, 2], due: 'soon', project: 42 });
  assert.deepEqual(c.items, [1, 2]);
  assert.equal(c.due, '', 'a due date that is not a date is dropped');
  assert.equal(c.project, '');
});

test('a valid due date survives the round trip', () => {
  const store = fakeStore();
  saveCart(7, { v: CART_VERSION, items: [3], due: '2026-08-09', project: 'Weekend service' }, store);
  const back = loadCart(7, store);
  assert.deepEqual(back.items, [3]);
  assert.equal(back.due, '2026-08-09');
  assert.equal(back.project, 'Weekend service');
});

/* Two people share a laptop in the gear room; one must not inherit the
   other's half-built checkout. */
test('carts are kept per person', () => {
  const store = fakeStore();
  saveCart(1, addToCart(emptyCart(), [10]), store);
  saveCart(2, addToCart(emptyCart(), [20]), store);
  assert.deepEqual(loadCart(1, store).items, [10]);
  assert.deepEqual(loadCart(2, store).items, [20]);
  assert.notEqual(cartKey(1), cartKey(2));
});

test('an unknown person gets their own empty cart rather than someone else\'s', () => {
  const store = fakeStore();
  saveCart(1, addToCart(emptyCart(), [10]), store);
  assert.deepEqual(loadCart(undefined, store).items, []);
});

test('a corrupt stored cart loads as empty instead of throwing', () => {
  const store = fakeStore();
  store.set(cartKey(1), '{not json');
  assert.deepEqual(loadCart(1, store).items, []);
});

/* A cart can sit for days. The inventory does not hold still for it. */
test('gear that was retired or deleted is pruned, and the count is reported', () => {
  const cart = addToCart(emptyCart(), [1, 2, 3]);
  const items = [{ id: 1 }, { id: 2, retired: true }];
  const { cart: pruned, dropped } = pruneCart(cart, items);
  assert.deepEqual(pruned.items, [1]);
  assert.equal(dropped, 2, 'one retired, one no longer in the inventory');
});

test('pruning an already-clean cart changes nothing', () => {
  const cart = addToCart(emptyCart(), [1, 2]);
  const { cart: pruned, dropped } = pruneCart(cart, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(pruned.items, [1, 2]);
  assert.equal(dropped, 0);
});

test('the cart never mutates what it was given', () => {
  const original = addToCart(emptyCart(), [1, 2]);
  const snapshot = JSON.stringify(original);
  addToCart(original, [3]);
  removeFromCart(original, [1]);
  pruneCart(original, []);
  assert.equal(JSON.stringify(original), snapshot);
});

test('a cart remembers who else is on the checkout', () => {
  const store = fakeStore();
  saveCart(7, { ...emptyCart(), items: [1], crew: [4, 5] }, store);
  assert.deepEqual(loadCart(7, store).crew, [4, 5]);
});

/* Added after v1 shipped, so carts written before it must still load. */
test('a cart saved before crew existed loads with none', () => {
  assert.deepEqual(normaliseCart({ v: CART_VERSION, items: [1] }).crew, []);
});

test('crew ids are filtered the same way item ids are', () => {
  assert.deepEqual(normaliseCart({ v: CART_VERSION, crew: [1, null, 'x', 0, -2, 3, 3] }).crew, [1, 3]);
});

test('a cart remembers what the shoot is called as well as the project', () => {
  const store = fakeStore();
  saveCart(7, { ...emptyCart(), items: [1], shoot: 'Easter 9am', project: 'Easter' }, store);
  const back = loadCart(7, store);
  assert.equal(back.shoot, 'Easter 9am');
  assert.equal(back.project, 'Easter');
});

test('a cart saved before shoot existed loads with an empty one', () => {
  assert.equal(normaliseCart({ v: CART_VERSION, items: [1] }).shoot, '');
  assert.equal(normaliseCart({ v: CART_VERSION, shoot: 42 }).shoot, '');
});

test('a cart saved before kit_id existed loads with none', () => {
  assert.equal(normaliseCart({ v: CART_VERSION, items: [1] }).kit_id, null);
});

test('junk in kit_id is dropped rather than trusted', () => {
  assert.equal(normaliseCart({ v: CART_VERSION, kit_id: 'nope' }).kit_id, null);
  assert.equal(normaliseCart({ v: CART_VERSION, kit_id: 0 }).kit_id, null);
  assert.equal(normaliseCart({ v: CART_VERSION, kit_id: -3 }).kit_id, null);
  assert.equal(normaliseCart({ v: CART_VERSION, kit_id: 5 }).kit_id, 5);
});

test('setCartKit remembers the first kit and ignores the rest', () => {
  let c = setCartKit(emptyCart(), 11);
  assert.equal(c.kit_id, 11);
  c = setCartKit(c, 12);
  assert.equal(c.kit_id, 11, 'a second kit does not reassign it');
});

test('emptying the cart forgets which kit it started from', () => {
  assert.equal(emptyCart().kit_id, null);
});

test('a cart saved before swapped_out existed loads with none', () => {
  assert.deepEqual(normaliseCart({ v: CART_VERSION, items: [1] }).swapped_out, []);
});

test('junk in swapped_out is dropped rather than trusted', () => {
  assert.deepEqual(normaliseCart({ v: CART_VERSION, swapped_out: 'nope' }).swapped_out, []);
  assert.deepEqual(normaliseCart({ v: CART_VERSION, swapped_out: [0, -3, 'x', 7] }).swapped_out, [7]);
});

test('addSwappedOut records an item once even if it is swapped out twice', () => {
  let c = addSwappedOut(emptyCart(), 9);
  assert.deepEqual(c.swapped_out, [9]);
  c = addSwappedOut(c, 9);
  assert.deepEqual(c.swapped_out, [9], 'no duplicate from swapping the same item again');
  c = addSwappedOut(c, 12);
  assert.deepEqual(c.swapped_out, [9, 12]);
});

test('addSwappedOut ignores a bad id rather than corrupting the cart', () => {
  assert.deepEqual(addSwappedOut(emptyCart(), 0).swapped_out, []);
  assert.deepEqual(addSwappedOut(emptyCart(), null).swapped_out, []);
});
