import { describe, expect, test } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import { state } from '@ferretry/kernel/host';
import {
  AdminTokenFile,
  AUDIT_KINDS,
  type AuditRecord,
  AuditLogFile,
  WardenTokenFile,
} from '../../../contract/index.ts';
import { AuditKeptFile, AuditKeptRotatedFile, AuditRotatedFile } from '../../../manifest.ts';
import { StateAuditJournal } from '../../../daemon/adapters/audit/state-audit-journal.ts';
import { StateTokens } from '../../../daemon/adapters/tokens/state-tokens.ts';
import { StateGrantHistory } from '../../../daemon/adapters/grants/state-grant-history.ts';
import type { GrantAuditEntryView as GrantAuditEntry } from '../../../contract/index.ts';
import { GrantAuditFile } from '../../../manifest.ts';

const FILES = [
  AdminTokenFile,
  WardenTokenFile,
  AuditLogFile,
  AuditRotatedFile,
  AuditKeptFile,
  AuditKeptRotatedFile,
  GrantAuditFile,
];

/** The real host state port over an in-memory disk: the same format, schema and secret handling as a daemon. */
function folder(): { port: (files: typeof FILES) => StatePort; fs: ReturnType<typeof state.createMemoryHostFs> } {
  const fs = state.createMemoryHostFs();
  return { fs, port: files => state.createStatePort({ home: '/home/test', pluginId: 'gate', files, fs }) };
}

const record = (n: number): AuditRecord => ({
  format: 1,
  at: `2026-11-07T12:00:${String(n).padStart(2, '0')}.000Z` as AuditRecord['at'],
  event: AUDIT_KINDS['terminal.opened'],
  actor: { kind: 'host' },
  subject: `t${n}`,
  outcome: 'succeeded',
});

describe('the audit journal on the kernel state', () => {
  test('F-0078 F-0224 F-0076 F-0222 two stores, read apart and newest first', async () => {
    const disk = folder();
    const journal = new StateAuditJournal(disk.port(FILES), {
      general: { live: AuditLogFile, rotated: AuditRotatedFile },
      kept: { live: AuditKeptFile, rotated: AuditKeptRotatedFile },
    });
    await journal.append(record(1), 'general');
    await journal.append(record(2), 'kept');
    await journal.append(record(3), 'general');
    const reading = await journal.recent(10, 0);
    expect(reading.records.map(r => r.subject)).toEqual(['t3', 't1']);
    expect(reading.kept.map(r => r.subject)).toEqual(['t2']);
    expect(reading.keptTotal).toBe(1);
  });

  test('F-0077 F-0223 F-0075 F-0221 a store past its bound rotates, and a never-rotate line is refused instead', async () => {
    const disk = folder();
    const one = new TextEncoder().encode(`${JSON.stringify(record(1))}\n`).byteLength;
    const journal = new StateAuditJournal(
      disk.port(FILES),
      {
        general: { live: AuditLogFile, rotated: AuditRotatedFile },
        kept: { live: AuditKeptFile, rotated: AuditKeptRotatedFile },
      },
      one * 2,
    );
    for (const n of [1, 2, 3]) await journal.append(record(n), 'general');
    expect((await journal.recent(10, 0)).records.map(r => r.subject)).toEqual(['t3', 't2', 't1']);
    await journal.append(record(4), 'general');
    await journal.append(record(5), 'general');
    // The oldest file went with the second rotation.
    expect((await journal.recent(10, 0)).records.map(r => r.subject)).toEqual(['t5', 't4', 't3']);
    await journal.append(record(6), 'kept');
    await journal.append(record(7), 'kept');
    expect(await journal.append(record(8), 'kept', 'never')).toBe(false);
  });
});

describe('the daemon tokens', () => {
  test('F-0025 F-0041 F-0106 tokens are minted on first use into state/gate and reused after', async () => {
    const disk = folder();
    let n = 0;
    const tokens = new StateTokens(
      disk.port(FILES),
      { admin: AdminTokenFile, warden: WardenTokenFile },
      () => `minted-${++n}`,
    );
    expect(await tokens.load()).toEqual({ admin: 'minted-1', warden: 'minted-2' });
    expect(await tokens.load()).toEqual({ admin: 'minted-1', warden: 'minted-2' });
  });

  test('with no minting injected, each token is a fresh 32-byte base64url secret, stored with a newline and read back', async () => {
    const disk = folder();
    const tokens = new StateTokens(disk.port(FILES), { admin: AdminTokenFile, warden: WardenTokenFile });
    const first = await tokens.load();
    expect(first.admin).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.warden).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.admin).not.toBe(first.warden);
    expect(await disk.fs.readText('/home/test/state/gate/admin-token')).toBe(`${first.admin}\n`);
    expect(await tokens.load()).toEqual(first);
  });

  test('a blank token file is minted again: an empty secret authenticates nothing', async () => {
    const disk = folder();
    await disk.fs.writeAtomic('/home/test/state/gate/admin-token', '\n', 0o600);
    const tokens = new StateTokens(disk.port(FILES), { admin: AdminTokenFile, warden: WardenTokenFile }, () => 'fresh');
    expect((await tokens.load()).admin).toBe('fresh');
  });
});

describe('the grant history', () => {
  test('F-0251 grant changes are appended to state/gate/grant-audit.jsonl and read newest first, bounded', async () => {
    const disk = folder();
    const history = new StateGrantHistory(disk.port(FILES), GrantAuditFile);
    const entry = (n: number): GrantAuditEntry => ({
      at: `2026-11-07T12:00:0${String(n)}.000Z` as GrantAuditEntry['at'],
      actor: 'admin-cli',
      changes: [`fleet.use=${n % 2 === 0 ? 'on' : 'off'}`],
    });
    for (const n of [1, 2, 3]) await history.record(entry(n));
    expect(await history.recent(2)).toEqual({ entries: [entry(3), entry(2)], unreadable: 0, truncated: false });
    expect(await disk.fs.readText('/home/test/state/gate/grant-audit.jsonl')).not.toContain('token');
  });
});
