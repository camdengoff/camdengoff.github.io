#!/usr/bin/env node
/**
 * Run the daily reminder batch once and exit. For a Render Cron Job, a GitHub
 * Actions workflow with a database URL, or a local `npm run reminders`.
 *
 * Safe to run repeatedly — every message is claimed in the notifications table
 * before it's sent, so a double trigger sends nothing twice.
 */
import { runReminders } from '../src/reminders.js';
import { pool } from '../src/db.js';

try {
  const result = await runReminders({ verbose: true });
  console.log(`Done: ${result.sent.length} message(s) for ${result.today}.`);
  await pool.end();
  process.exit(0);
} catch (err) {
  console.error('Reminder run failed:', err);
  await pool.end().catch(() => {});
  process.exit(1);
}
