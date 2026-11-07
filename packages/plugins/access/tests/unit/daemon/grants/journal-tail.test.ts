import { expect, test } from 'bun:test';
import { journalState as fixture } from '../../../support/daemon/journal-state.ts';
import { JournalGrantAudit } from '../../../../daemon/adapters/grants/runtime-grant-ports.ts';

const record = (actor: string) => ({
  format: 1,
  kind: 'grant.changed',
  at: '2026-11-06T09:00:00.000Z',
  actor,
  changes: ['fleet.use=off'],
});
const line = (actor: string) => `${JSON.stringify(record(actor))}\n`;

test('recent reads at most the final 64 KiB, reports truncation and returns only the requested newest entries', async () => {
  const f = fixture(line('old').repeat(1_000) + line('newest'));
  const result = await f.audit.recent(1);
  expect(result).toEqual({
    entries: [{ at: record('').at, actor: 'newest', changes: ['fleet.use=off'] }],
    unreadable: 0,
    truncated: true,
  });
  expect(f.reads).toEqual([64 * 1024]);
});

test('recent counts damaged tail lines while retaining healthy records on both sides', async () => {
  const f = fixture(line('before') + '{broken\n' + JSON.stringify({ format: 2 }) + '\n' + line('after'));
  const result = await f.audit.recent(10);
  expect(result.entries.map(entry => entry.actor)).toEqual(['after', 'before']);
  expect(result.unreadable).toBe(2);
  expect(result.truncated).toBe(false);
});

test('healthy mixed grant and security records keep separate histories with unreadable:0', async () => {
  const f = fixture();
  const security = new JournalGrantAudit(f.state, 'security.changed');
  const entry = { at: record('').at, actor: 'owner', changes: ['pairing.use=off'] };
  await f.audit.record(entry);
  await security.record({ ...entry, actor: 'security-owner' });
  expect(await f.audit.recent(10)).toEqual({ entries: [entry], unreadable: 0, truncated: false });
  expect(await security.recent(10)).toEqual({
    entries: [{ ...entry, actor: 'security-owner' }],
    unreadable: 0,
    truncated: false,
  });
});

test('old damage outside the tail cannot hide a healthy recent history or count as tail damage', async () => {
  const result = await fixture('{broken\n' + line('healthy').repeat(1_000)).audit.recent(2);
  expect(result.entries).toHaveLength(2);
  expect(result.unreadable).toBe(0);
  expect(result.truncated).toBe(true);
});

test('an empty journal is an empty untruncated history', async () => {
  expect(await fixture().audit.recent(10)).toEqual({ entries: [], unreadable: 0, truncated: false });
});

test('recent propagates a tail I/O refusal instead of presenting it as an empty history', async () => {
  const f = fixture(line('present'));
  f.state.tail = async () => {
    throw new Error('fixture I/O refusal');
  };
  await expect(f.audit.recent(1)).rejects.toThrow('fixture I/O refusal');
});
