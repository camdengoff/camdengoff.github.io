#!/usr/bin/env node
/**
 * The Cage, as an MCP server.
 *
 * Lets Claude — in Claude Code, Claude Desktop, or anything else that speaks
 * MCP — read the gear room and act in it: "what cameras are free next Tuesday",
 * "check out the C400 for me until Friday", "what's overdue".
 *
 * It is a thin client over the REST API, deliberately. Every tool here is an
 * HTTP call to a running Cage, authenticated with an API token that maps to
 * one person, so:
 *
 *   - src/policy.js still decides what's allowed. This process has no special
 *     powers; a checkout it isn't permitted to make is refused exactly as the
 *     web UI would be refused.
 *   - Everything it does is attributed to that person and shows up in the
 *     audit log. There is no anonymous "the robot did it".
 *   - It cannot reach the database directly, so a bug here cannot corrupt
 *     state in a way the API wouldn't have allowed.
 *
 *   CAGE_URL     where the app is           (default http://localhost:3000)
 *   CAGE_TOKEN   from `npm run token`       (required unless AUTH_MODE=none)
 *
 * Transport is stdio: the client launches this process and talks over its
 * stdin/stdout. Nothing may be written to stdout except protocol messages —
 * a stray console.log corrupts the stream. Logging goes to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.CAGE_URL || 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = process.env.CAGE_TOKEN || '';

const log = (...a) => console.error('[cage-mcp]', ...a);

/* ------------------------------------------------------------------- client */

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }

  if (!res.ok) {
    const err = new Error(data.error || `${method} ${path} failed (${res.status})`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

/**
 * Turn a failure into something Claude can act on rather than a stack trace.
 * A policy block isn't an error in the "something went wrong" sense — it's the
 * answer, and it usually says exactly what to do instead.
 */
function explain(err) {
  if (err.status === 401) {
    return 'Not authenticated. CAGE_TOKEN is missing, wrong, or revoked — mint a new one with `npm run token -- --new "Claude MCP"`.';
  }
  if (err.status === 403) return `Not allowed: ${err.message}`;
  if (err.payload?.blocks?.length) {
    const reasons = err.payload.blocks.map(b => `- ${b.message}`).join('\n');
    return `The cage refused this:\n${reasons}`;
  }
  if (err.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(err.message)) {
    return `Can't reach The Cage at ${BASE}. Is it running? (npm run dev)`;
  }
  return err.message;
}

const text = s => ({ content: [{ type: 'text', text: s }] });
const fail = e => ({ content: [{ type: 'text', text: explain(e) }], isError: true });

/* ------------------------------------------------------------------ helpers */

const DAY = 86_400_000;
const iso = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(Date.parse(s + 'T12:00:00Z') + n * DAY));
const overlaps = (aS, aE, bS, bE) => aS <= bE && bS <= aE;

/** One line per item, dense enough to reason over without being a wall. */
const describe = (it, state) => {
  const bits = [it.code, it.brand || it.category].filter(Boolean).join(' · ');
  return `${it.name} (${bits})${state ? ` — ${state}` : ''}`;
};

async function state() {
  return api('GET', '/api/state');
}

/** Current status of one item, using the same rules the UI paints with. */
function statusOf(id, s) {
  const today = s.today;
  if (s.openMaintenance.some(m => m.item_id === id)) return 'down for repair';
  const out = s.openCheckouts.find(c => c.item_ids.includes(id));
  if (out) {
    return out.due_on < today
      ? `OVERDUE with ${out.holder_name}, was due ${out.due_on}`
      : `out with ${out.holder_name}, due ${out.due_on}`;
  }
  const held = s.reservations.find(r =>
    r.item_ids.includes(id) && r.start_on <= today && today <= r.end_on);
  if (held) return `held for ${held.person_name} until ${held.end_on}`;
  return 'available';
}

/* -------------------------------------------------------------------- tools */

const server = new McpServer({ name: 'the-cage', version: '1.0.0' });

server.registerTool('whoami', {
  title: 'Who am I in The Cage',
  description:
    'Which Cage account this connection acts as, and whether it can do admin things. ' +
    'Useful when a checkout is refused and you need to know if it is a permissions problem.',
  inputSchema: {}
}, async () => {
  try {
    const me = await api('GET', '/auth/me');
    const p = me.person;
    return text(
      `Acting as ${p.name || p.email} <${p.email}> — role: ${p.role}.` +
      (p.blocked ? `\nThis account is BLOCKED from taking gear out: ${p.blocked_reason || 'no reason given'}.` : '') +
      `\nCage: ${BASE}`
    );
  } catch (e) { return fail(e); }
});

server.registerTool('search_gear', {
  title: 'Find gear',
  description:
    'Search the inventory by name, brand, model, code or category, and see the current state of each match ' +
    '(available, out with someone, overdue, held, down for repair). Matching is forgiving — "sigmma 1835" finds the Sigma 18-35. ' +
    'Use this first when the user names gear loosely; it gives you the item IDs the other tools need.',
  inputSchema: {
    query: z.string().describe('What to look for — a name, brand, code, or category.'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results (default 15).')
  }
}, async ({ query, limit = 15 }) => {
  try {
    const s = await state();
    const { searchItems } = await import('../public/search.js');
    const hits = searchItems(s.items.filter(i => !i.retired), query).slice(0, limit);
    if (!hits.length) return text(`Nothing in the cage matches "${query}".`);

    const lines = hits.map(i => `[${i.id}] ${describe(i, statusOf(i.id, s))}`);
    return text(`${hits.length} match(es) for "${query}":\n\n${lines.join('\n')}`);
  } catch (e) { return fail(e); }
});

server.registerTool('list_gear', {
  title: 'List gear by category or state',
  description:
    'Browse the inventory. Filter by category (Cameras, Lenses, Lighting, Audio, …) and/or by state. ' +
    'Use state="available" to answer "what can I take right now".',
  inputSchema: {
    category: z.string().optional().describe('Exact category name. Omit for all.'),
    state: z.enum(['any', 'available', 'out', 'overdue', 'held', 'repair']).optional()
      .describe('Filter by current state (default any).'),
    limit: z.number().int().min(1).max(100).optional()
  }
}, async ({ category, state: want = 'any', limit = 40 }) => {
  try {
    const s = await state();
    const bucket = id => {
      const st = statusOf(id, s);
      if (st.startsWith('OVERDUE')) return 'overdue';
      if (st.startsWith('out')) return 'out';
      if (st.startsWith('held')) return 'held';
      if (st.startsWith('down')) return 'repair';
      return 'available';
    };

    let items = s.items.filter(i => !i.retired);
    if (category) items = items.filter(i => i.category.toLowerCase() === category.toLowerCase());
    if (want !== 'any') items = items.filter(i => bucket(i.id) === want);

    const cats = [...new Set(s.items.filter(i => !i.retired).map(i => i.category))].sort();
    if (!items.length) {
      return text(`Nothing matches.\nCategories in this cage: ${cats.join(', ')}`);
    }

    const shown = items.slice(0, limit);
    const lines = shown.map(i => `[${i.id}] ${describe(i, statusOf(i.id, s))}`);
    const more = items.length > shown.length ? `\n\n…and ${items.length - shown.length} more.` : '';
    return text(`${items.length} item(s):\n\n${lines.join('\n')}${more}`);
  } catch (e) { return fail(e); }
});

server.registerTool('check_availability', {
  title: 'Is this gear free on these dates',
  description:
    'Check whether specific items are free over a date range, before trying to book them. ' +
    'Returns what clashes and who has it. Ask this when the user proposes dates.',
  inputSchema: {
    item_ids: z.array(z.number().int()).min(1).describe('Item IDs, from search_gear or list_gear.'),
    start: z.string().describe('First day, YYYY-MM-DD.'),
    end: z.string().describe('Last day, YYYY-MM-DD (inclusive).')
  }
}, async ({ item_ids, start, end }) => {
  try {
    const s = await state();
    const cal = await api('GET', `/api/calendar?from=${start}&to=${end}`);
    const byId = new Map(s.items.map(i => [i.id, i]));

    const report = item_ids.map(id => {
      const it = byId.get(id);
      if (!it) return `[${id}] no such item`;

      const down = s.openMaintenance.find(m => m.item_id === id);
      if (down) return `[${id}] ${it.name} — DOWN (${down.kind}: ${down.notes || 'no notes'})`;

      const clashes = cal.bookings.filter(b =>
        b.item_ids.includes(id) && overlaps(b.start, b.end, start, end));
      if (!clashes.length) return `[${id}] ${it.name} — free ${start} to ${end}`;

      const who = clashes.map(c =>
        `${c.kind === 'reservation' ? 'held for' : 'out with'} ${c.person_name} ${c.start}→${c.end}`).join('; ');
      return `[${id}] ${it.name} — NOT free: ${who}`;
    });

    return text(`Availability ${start} → ${end}:\n\n${report.join('\n')}`);
  } catch (e) { return fail(e); }
});

server.registerTool('check_out_gear', {
  title: 'Check gear out',
  description:
    'Take gear out of the cage, starting today. This is a real, recorded action — it books physical equipment ' +
    'to a person. Confirm the exact items and the due date with the user before calling it. ' +
    'The server enforces the rules: gear already out, in repair, or held by someone else will be refused, ' +
    'and the refusal explains why.',
  inputSchema: {
    item_ids: z.array(z.number().int()).min(1).describe('Item IDs to take.'),
    due_on: z.string().describe('When it comes back, YYYY-MM-DD.'),
    project: z.string().optional().describe('What it is for — shows on the calendar and in reminders.')
  }
}, async ({ item_ids, due_on, project }) => {
  try {
    const s = await state();
    const byId = new Map(s.items.map(i => [i.id, i]));
    const r = await api('POST', '/api/checkouts', { item_ids, due_on, project: project || '' });

    const names = item_ids.map(id => byId.get(id)?.name || `item ${id}`).join(', ');
    const warned = r.warnings?.length
      ? `\n\nOverridden warnings:\n${r.warnings.map(w => `- ${w.message}`).join('\n')}`
      : '';
    return text(`Checked out #${r.id}: ${names}\nDue back ${due_on}${project ? ` · ${project}` : ''}.${warned}`);
  } catch (e) { return fail(e); }
});

server.registerTool('reserve_gear', {
  title: 'Reserve gear for future dates',
  description:
    'Hold gear for a future date range without taking it now. Real and recorded — confirm with the user first. ' +
    'Refused if it clashes with an existing booking, and the refusal names who has it.',
  inputSchema: {
    item_ids: z.array(z.number().int()).min(1),
    start_on: z.string().describe('First day of the hold, YYYY-MM-DD.'),
    end_on: z.string().describe('Last day of the hold, YYYY-MM-DD.'),
    project: z.string().optional()
  }
}, async ({ item_ids, start_on, end_on, project }) => {
  try {
    const r = await api('POST', '/api/reservations', {
      item_ids, start_on, end_on, project: project || ''
    });
    return text(`Held #${r.id}: ${item_ids.length} item(s), ${start_on} → ${end_on}${project ? ` · ${project}` : ''}.`);
  } catch (e) { return fail(e); }
});

server.registerTool('check_in_gear', {
  title: 'Check gear back in',
  description:
    'Return gear that is currently out, closing the loan. Pass item_ids to return only part of a loan; ' +
    'omit them to return everything on it. Use my_gear or whats_out to find the checkout ID.',
  inputSchema: {
    checkout_id: z.number().int().describe('The loan to close.'),
    item_ids: z.array(z.number().int()).optional()
      .describe('Only these items came back. Omit to return the whole loan.')
  }
}, async ({ checkout_id, item_ids }) => {
  try {
    const s = await state();
    const co = s.openCheckouts.find(c => c.id === checkout_id);
    const returning = item_ids?.length ? item_ids : (co?.item_ids || []);
    await api('POST', `/api/checkouts/${checkout_id}/return`, { item_ids: returning });

    const byId = new Map(s.items.map(i => [i.id, i]));
    const names = returning.map(id => byId.get(id)?.name || `item ${id}`).join(', ');
    const partial = item_ids?.length && co && item_ids.length < co.item_ids.length;
    return text(
      `Checked in: ${names || 'nothing'}.` +
      (partial ? '\nThe rest of that loan stays open on a new checkout.' : '')
    );
  } catch (e) { return fail(e); }
});

server.registerTool('my_gear', {
  title: 'What am I holding',
  description: 'Everything currently checked out to this account, with due dates and what is late.',
  inputSchema: {}
}, async () => {
  try {
    const s = await state();
    const mine = s.openCheckouts.filter(c => c.holder_id === s.me.id);
    if (!mine.length) return text('You have nothing out.');

    const byId = new Map(s.items.map(i => [i.id, i]));
    const lines = mine.map(c => {
      const names = c.item_ids.map(i => byId.get(i)?.name).filter(Boolean).join(', ');
      const late = c.due_on < s.today ? '  ** OVERDUE **' : '';
      return `Checkout #${c.id} — due ${c.due_on}${late}\n  ${names}${c.project ? `\n  for: ${c.project}` : ''}`;
    });
    return text(`You have ${mine.length} loan(s) out:\n\n${lines.join('\n\n')}`);
  } catch (e) { return fail(e); }
});

server.registerTool('whats_out', {
  title: 'What is out, overdue, or down',
  description:
    'The state of the whole cage: everything currently on loan, what is overdue and with whom, ' +
    'and what is in for repair. Use this for "what is late" or "who has the X".',
  inputSchema: {
    only_overdue: z.boolean().optional().describe('Just the late gear.')
  }
}, async ({ only_overdue = false }) => {
  try {
    const s = await state();
    const byId = new Map(s.items.map(i => [i.id, i]));
    const late = s.openCheckouts.filter(c => c.due_on < s.today);
    const current = s.openCheckouts.filter(c => c.due_on >= s.today);

    const fmt = c => {
      const names = c.item_ids.map(i => byId.get(i)?.name).filter(Boolean).join(', ');
      return `#${c.id} ${c.holder_name} — due ${c.due_on}${c.project ? ` · ${c.project}` : ''}\n  ${names}`;
    };

    const parts = [];
    parts.push(late.length
      ? `OVERDUE (${late.length}):\n${late.map(fmt).join('\n')}`
      : 'Nothing is overdue.');

    if (!only_overdue) {
      parts.push(current.length
        ? `\nOut on set (${current.length}):\n${current.map(fmt).join('\n')}`
        : '\nNothing else is out.');
      if (s.openMaintenance.length) {
        const down = s.openMaintenance.map(m =>
          `- ${byId.get(m.item_id)?.name || `item ${m.item_id}`} (${m.kind}${m.notes ? `: ${m.notes}` : ''})`);
        parts.push(`\nDown for repair (${s.openMaintenance.length}):\n${down.join('\n')}`);
      }
    }
    return text(parts.join('\n'));
  } catch (e) { return fail(e); }
});

server.registerTool('whats_happening', {
  title: 'What is booked over a date range',
  description:
    'Every checkout and hold overlapping a date range — who has what, and when. ' +
    'Use for "what is going on next week" or "is anything booked on the 14th".',
  inputSchema: {
    from: z.string().describe('Start of the range, YYYY-MM-DD.'),
    to: z.string().optional().describe('End of the range, YYYY-MM-DD. Defaults to 13 days after `from`.')
  }
}, async ({ from, to }) => {
  try {
    const end = to || addDays(from, 13);
    const cal = await api('GET', `/api/calendar?from=${from}&to=${end}`);
    if (!cal.bookings.length) return text(`Nothing booked ${from} → ${end}.`);

    const s = await state();
    const byId = new Map(s.items.map(i => [i.id, i]));
    const sorted = [...cal.bookings].sort((a, b) => a.start.localeCompare(b.start));

    const lines = sorted.map(b => {
      const names = b.item_ids.map(i => byId.get(i)?.name).filter(Boolean).join(', ');
      const kind = b.kind === 'reservation' ? 'HOLD'
        : b.returned ? 'returned'
        : b.due < cal.today ? 'OVERDUE' : 'out';
      return `${b.start} → ${b.end}  [${kind}] ${b.person_name}${b.project ? ` · ${b.project}` : ''}\n  ${names}`;
    });
    return text(`${cal.bookings.length} booking(s), ${from} → ${end}:\n\n${lines.join('\n\n')}`);
  } catch (e) { return fail(e); }
});

server.registerTool('report_problem', {
  title: 'Report gear as broken or in for repair',
  description:
    'Open a maintenance ticket, which takes the item out of service until it is closed. ' +
    'Use when the user says something is broken, damaged, or away being serviced.',
  inputSchema: {
    item_id: z.number().int(),
    kind: z.enum(['Repair', 'Damage', 'Service', 'Lost']).optional().describe('Default Repair.'),
    notes: z.string().optional().describe('What is wrong.')
  }
}, async ({ item_id, kind = 'Repair', notes }) => {
  try {
    const r = await api('POST', '/api/maintenance', { item_id, kind, notes: notes || '' });
    const s = await state();
    const it = s.items.find(i => i.id === item_id);
    return text(`Opened ${kind.toLowerCase()} ticket #${r.id} on ${it?.name || `item ${item_id}`}. It is now out of service.`);
  } catch (e) { return fail(e); }
});

/* --------------------------------------------------------------------- boot */

async function main() {
  if (!TOKEN) {
    log('CAGE_TOKEN is not set — requests will be unauthenticated and will fail');
    log('unless the server is running with AUTH_MODE=none.');
    log('Mint one with: npm run token -- --new "Claude MCP"');
  }

  // Fail loudly at startup rather than on the user's first question.
  try {
    const health = await fetch(BASE + '/healthz', { signal: AbortSignal.timeout(5000) });
    if (!health.ok) log(`warning: ${BASE}/healthz returned ${health.status}`);
    else log(`connected to ${BASE}`);
  } catch {
    log(`warning: can't reach ${BASE} — tools will fail until it's running.`);
  }

  await server.connect(new StdioServerTransport());
  log('ready on stdio');
}

main().catch(err => {
  log('failed to start:', err.message);
  process.exit(1);
});
