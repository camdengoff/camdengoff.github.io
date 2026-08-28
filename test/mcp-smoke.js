#!/usr/bin/env node
/**
 * Drive the MCP server over stdio, the way a client does.
 *
 *   CAGE_TOKEN=... node test/mcp-smoke.js
 *
 * Not part of `npm test` — that suite is pure and needs no database, and this
 * needs both a database and a running app. It exists because the failure modes
 * of an MCP server are protocol-shaped: a stray console.log corrupts the
 * stream, a bad schema makes a tool silently unavailable, and neither shows up
 * in a unit test of the handler.
 *
 * Speaks raw JSON-RPC rather than importing the client SDK, so it fails if the
 * wire format is wrong rather than if only our own abstraction is wrong.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const child = spawn('node', [path.join(ROOT, 'mcp', 'server.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env }
});

let buffer = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', chunk => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // The single most common way to break an stdio MCP server.
      console.error(`${RED}NON-JSON ON STDOUT — this corrupts the protocol:${RESET}\n  ${line}`);
      process.exitCode = 1;
      continue;
    }
    const resolve = pending.get(msg.id);
    if (resolve) { pending.delete(msg.id); resolve(msg); }
  }
});

const stderr = [];
child.stderr.on('data', d => stderr.push(d.toString()));

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); }
    }, 20_000);
  });
}

let pass = 0, fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  ${GREEN}✓${RESET} ${label}`); }
  else { fail++; console.log(`  ${RED}✗${RESET} ${label}${detail ? `\n      ${detail}` : ''}`); }
}

const textOf = r => (r?.result?.content || []).map(c => c.text).join('\n');

async function main() {
  console.log('\nDriving mcp/server.js over stdio\n');

  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'cage-smoke', version: '1.0.0' }
  });
  check('initialize handshake', Boolean(init.result?.serverInfo),
    JSON.stringify(init.error || init.result || {}).slice(0, 200));
  check('server identifies itself', init.result?.serverInfo?.name === 'the-cage',
    `got ${init.result?.serverInfo?.name}`);

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const listed = await send('tools/list', {});
  const tools = listed.result?.tools || [];
  const names = tools.map(t => t.name).sort();
  check(`tools/list returns tools (${tools.length})`, tools.length >= 10, names.join(', '));

  const expected = ['check_availability', 'check_in_gear', 'check_out_gear', 'list_gear',
    'my_gear', 'report_problem', 'reserve_gear', 'search_gear', 'whats_happening',
    'whats_out', 'whoami'];
  const missing = expected.filter(n => !names.includes(n));
  check('every expected tool is exposed', missing.length === 0, `missing: ${missing.join(', ')}`);

  // A tool with no usable schema is silently uncallable by the client.
  const badSchema = tools.filter(t => !t.inputSchema || t.inputSchema.type !== 'object');
  check('every tool has an object inputSchema', badSchema.length === 0,
    badSchema.map(t => t.name).join(', '));
  const undescribed = tools.filter(t => !t.description || t.description.length < 20);
  check('every tool is described well enough to choose', undescribed.length === 0,
    undescribed.map(t => t.name).join(', '));

  const call = (name, args = {}) => send('tools/call', { name, arguments: args });

  const who = await call('whoami');
  check('whoami reaches the API and authenticates',
    /Acting as/.test(textOf(who)) && !who.result?.isError, textOf(who).slice(0, 160));

  const search = await call('search_gear', { query: 'camera', limit: 5 });
  check('search_gear returns matches with IDs',
    /\[\d+\]/.test(textOf(search)), textOf(search).slice(0, 160));

  const typo = await call('search_gear', { query: 'aputre', limit: 3 });
  check('search_gear tolerates a typo',
    /aputure/i.test(textOf(typo)), textOf(typo).slice(0, 120));

  const out = await call('whats_out', { only_overdue: true });
  check('whats_out reports overdue gear',
    textOf(out).length > 0 && !out.result?.isError, textOf(out).slice(0, 120));

  const avail = await call('list_gear', { state: 'available', limit: 3 });
  check('list_gear filters to available',
    /\[\d+\]/.test(textOf(avail)), textOf(avail).slice(0, 120));

  // Availability of something known to be out must come back NOT free.
  const busyId = Number((textOf(out).match(/#(\d+)/) || [])[1]);
  const stateResp = await fetch((process.env.CAGE_URL || 'http://localhost:3000') + '/api/state',
    { headers: { authorization: `Bearer ${process.env.CAGE_TOKEN}` } }).then(r => r.json());
  const outItem = stateResp.openCheckouts[0]?.item_ids[0];
  if (outItem) {
    const check1 = await call('check_availability', {
      item_ids: [outItem], start: stateResp.today, end: stateResp.today
    });
    check('check_availability sees gear that is already out',
      /NOT free|DOWN/.test(textOf(check1)), textOf(check1).slice(0, 160));

    // And the policy engine must refuse to check it out.
    const refused = await call('check_out_gear', {
      item_ids: [outItem], due_on: stateResp.today, project: 'smoke test'
    });
    check('check_out_gear is refused for gear already out',
      refused.result?.isError === true && /refused|already out/i.test(textOf(refused)),
      textOf(refused).slice(0, 200));
  }

  // A real round trip: take something free, confirm it, put it back.
  const freeItem = stateResp.items.find(i =>
    !i.retired &&
    !stateResp.openCheckouts.some(c => c.item_ids.includes(i.id)) &&
    !stateResp.reservations.some(r => r.item_ids.includes(i.id)) &&
    !stateResp.openMaintenance.some(m => m.item_id === i.id));

  if (freeItem) {
    const due = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const took = await call('check_out_gear', {
      item_ids: [freeItem.id], due_on: due, project: 'MCP smoke test'
    });
    check(`check_out_gear takes free gear (${freeItem.name})`,
      !took.result?.isError && /Checked out/.test(textOf(took)), textOf(took).slice(0, 200));

    const mine = await call('my_gear');
    check('my_gear shows what was just taken',
      textOf(mine).includes(freeItem.name), textOf(mine).slice(0, 200));

    const coId = Number((textOf(took).match(/#(\d+)/) || [])[1]);
    if (coId) {
      const back = await call('check_in_gear', { checkout_id: coId });
      check('check_in_gear returns it', !back.result?.isError && /Checked in/.test(textOf(back)),
        textOf(back).slice(0, 160));
    }
  } else {
    check('found free gear to test a checkout round trip', false, 'everything is booked');
  }

  const bad = await call('check_out_gear', { item_ids: [999999], due_on: '2026-12-01' });
  check('an unknown item is an error, not a crash', bad.result?.isError === true,
    textOf(bad).slice(0, 160));

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (stderr.length) {
    console.log(`${DIM}server stderr:\n${stderr.join('').split('\n').map(l => '    ' + l).join('\n')}${RESET}`);
  }
  child.kill();
  process.exit(fail ? 1 : 0);
}

main().catch(err => {
  console.error(`${RED}smoke test failed:${RESET}`, err.message);
  if (stderr.length) console.error(stderr.join(''));
  child.kill();
  process.exit(1);
});
