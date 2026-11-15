import { describe, expect, test } from 'bun:test';
import { err, ok } from '@ferretry/std';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { ScriptRecordFile, ScriptRecordSchema } from '../../../../contract/index.ts';
import { ScriptRecordOnState } from '../../../../daemon/adapters/inputs/script-record.ts';

const fixture = () => {
  const folder = new MemoryStateFolder();
  return { folder, record: new ScriptRecordOnState(folder.port([ScriptRecordFile])) };
};

describe('the page-script record on the Vault’s own state', () => {
  test('nothing kept yet reads as no record', async () => {
    expect(await fixture().record.load()).toBeUndefined();
  });

  test('a saved record reads back whole, with and without an unreadable-origin time', async () => {
    const { folder, record } = fixture();

    await record.save({ hosts: new Map([['github.com', 10]]), everywhere: 7 });
    expect(await record.load()).toEqual({ hosts: new Map([['github.com', 10]]), everywhere: 7 });
    expect(ScriptRecordSchema.parse({ format: 1, ...JSON.parse(folder.raw(ScriptRecordFile) ?? '{}') })).toBeDefined();

    await record.save({ hosts: new Map() });
    expect(await record.load()).toEqual({ hosts: new Map() });
  });

  test('a file that cannot be read is damaged, never "no script ran"', async () => {
    const { folder, record } = fixture();
    folder.plant(ScriptRecordFile, '{not json');
    expect(await record.load()).toBe('damaged');

    folder.plant(ScriptRecordFile, JSON.stringify({ format: 1, hosts: { 'a.com': 'later' } }));
    expect(await record.load()).toBe('damaged');
  });

  test('a narrower file read as absent, yet present on disk, is damaged too', async () => {
    const read = async () => ok(undefined);
    const present = new ScriptRecordOnState({
      read,
      write: async () => undefined,
      version: async () => ({ size: 3, etag: 'x' }),
    } as never);
    const absent = new ScriptRecordOnState({
      read,
      write: async () => undefined,
      version: async () => undefined,
    } as never);
    const failing = new ScriptRecordOnState({
      read: async () => err({ file: 'script-record.json', reason: 'io', sentence: 'x' }),
      write: async () => undefined,
      version: async () => undefined,
    } as never);

    expect(await present.load()).toBe('damaged');
    expect(await absent.load()).toBeUndefined();
    expect(await failing.load()).toBe('damaged');
  });

  test('the file is declared owner-only', () => {
    expect(ScriptRecordFile.mode).toBe(0o600);
    expect(ScriptRecordFile.store).toBe('json');
  });
});
