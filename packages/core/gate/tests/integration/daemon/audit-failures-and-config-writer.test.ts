import { describe, expect, test } from 'bun:test';
import type { ConfigFilesWriter, ConfigWriteOutcome, StatePort } from '@ferretry/kernel/contract';
import { state } from '@ferretry/kernel/host';
import { AUDIT_KINDS, type AuditRecord, AuditLogFile, GateConfigFile } from '../../../contract/index.ts';
import { AuditKeptFile, AuditKeptRotatedFile, AuditRotatedFile } from '../../../manifest.ts';
import { StateAuditJournal } from '../../../daemon/adapters/audit/state-audit-journal.ts';
import { GateConfigNotSaved, GateConfigWriter } from '../../../daemon/adapters/config/gate-config-writer.ts';

const FILES = [AuditLogFile, AuditRotatedFile, AuditKeptFile, AuditKeptRotatedFile];
const AUDIT_FILES = {
  general: { live: AuditLogFile, rotated: AuditRotatedFile },
  kept: { live: AuditKeptFile, rotated: AuditKeptRotatedFile },
};

const record = (n: number): AuditRecord => ({
  format: 1,
  at: `2026-11-07T12:00:${String(n).padStart(2, '0')}.000Z` as AuditRecord['at'],
  event: AUDIT_KINDS['terminal.opened'],
  actor: { kind: 'host' },
  subject: `t${n}`,
  outcome: 'succeeded',
});

/** The real state port over an in-memory disk, with the named verbs made to fail. */
function port(failing: { append?: () => boolean; records?: boolean } = {}): StatePort {
  const real = state.createStatePort({
    home: '/home/test',
    pluginId: 'gate',
    files: FILES,
    fs: state.createMemoryHostFs(),
  });
  return new Proxy(real, {
    get(target, key, receiver) {
      if (key === 'append' && failing.append !== undefined)
        return async (...args: Parameters<StatePort['append']>) => {
          if (failing.append?.() === true) throw new Error('the disk refused the line');
          return await target.append(...args);
        };
      if (key === 'records' && failing.records === true)
        return async () => {
          throw new Error('the file could not be read');
        };
      return Reflect.get(target, key, receiver);
    },
  });
}

describe('the audit journal when the disk fails', () => {
  test('a refused write fails that append and the next one still lands', async () => {
    let refuse = true;
    const journal = new StateAuditJournal(port({ append: () => refuse }), AUDIT_FILES);
    await expect(journal.append(record(1), 'general')).rejects.toThrow('the disk refused the line');
    refuse = false;
    expect(await journal.append(record(2), 'general')).toBe(true);
    expect((await journal.recent(10, 0)).records.map(r => r.subject)).toEqual(['t2']);
  });

  test('a file the kernel cannot read is one unreadable count in each store, not an empty history', async () => {
    const journal = new StateAuditJournal(port({ records: true }), AUDIT_FILES);
    const reading = await journal.recent(10, 0);
    expect(reading.records).toEqual([]);
    expect(reading.kept).toEqual([]);
    expect(reading.keptTotal).toBe(0);
    // Two stores, a live and a rotated file each.
    expect(reading.unreadable).toBe(4);
  });
});

describe('the gate.yaml writer', () => {
  const target = { plugin: 'gate', def: GateConfigFile };

  function writerReturning(outcome: ConfigWriteOutcome): {
    writer: GateConfigWriter;
    calls: { edit: unknown; options: unknown }[];
  } {
    const calls: { edit: unknown; options: unknown }[] = [];
    const config = {
      write: async (_target: unknown, edit: unknown, options: unknown) => {
        calls.push({ edit, options });
        return outcome;
      },
    } as unknown as ConfigFilesWriter;
    return { writer: new GateConfigWriter(() => config, target), calls };
  }

  test('a written outcome returns, having sent only that key with the loosening already confirmed', async () => {
    const { writer, calls } = writerReturning({ kind: 'written', etag: 'e1', loosened: [] });
    await writer.write('grants', {} as never);
    expect(calls).toEqual([{ edit: { patch: { grants: {} } }, options: { confirmedLoosening: true } }]);
  });

  test('a daemon with no config writer saves nothing and says so', async () => {
    const writer = new GateConfigWriter(() => undefined, target);
    const error = await writer.write('grants', {} as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GateConfigNotSaved);
    expect((error as Error).name).toBe('GateConfigNotSaved');
    expect((error as Error).message).toBe('this daemon has no config writer for gate.yaml, so nothing was saved');
  });

  test('a held outcome is a save that did not take effect yet', async () => {
    const { writer } = writerReturning({ kind: 'held', etag: 'e1', id: 'h1', sentences: ['loosens a thing'] });
    await expect(writer.write('grants', {} as never)).rejects.toThrow(
      'gate.yaml was saved but waits for the owner to confirm it, so nothing changed yet',
    );
  });

  test('a conflict outcome asks to read again and retry', async () => {
    const { writer } = writerReturning({ kind: 'conflict' });
    await expect(writer.write('grants', {} as never)).rejects.toThrow(
      'gate.yaml changed while this was being saved; read it again and retry',
    );
  });

  test('a refusal names the reason, and the first issue when there is one', async () => {
    const withIssue = writerReturning({
      kind: 'refused',
      reason: 'schema',
      issues: [{ path: 'security.unlockValidityHours', message: 'unlockValidityHours must be a number' }],
    });
    await expect(withIssue.writer.write('grants', {} as never)).rejects.toThrow(
      'gate.yaml refused the change (schema: unlockValidityHours must be a number), so nothing was saved',
    );
    const bare = writerReturning({ kind: 'refused', reason: 'yaml', issues: [] });
    await expect(bare.writer.write('grants', {} as never)).rejects.toThrow(
      'gate.yaml refused the change (yaml), so nothing was saved',
    );
  });
});
