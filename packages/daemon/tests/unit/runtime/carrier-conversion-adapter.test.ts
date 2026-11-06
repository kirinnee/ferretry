import { describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CarrierConversionFiles,
  convertLegacyCarrierKeysIn,
} from '../../../src/adapters/runtime/carrier-conversion.ts';
import { CARRIERS_JOURNAL_NAME, FileDaemonConfig } from '../../../src/adapters/runtime/daemon-config.ts';
import { ExplicitDaemonConfig } from '../../../src/adapters/runtime/explicit-config.ts';
import type { FileSystemPort, FoundationPaths } from '../../../src/lib/index.ts';

const AT = '2026-11-06T10:20:30.456Z';
const FILE = '/home/config/daemon.json';
const JOURNAL = '/home/carriers-migration.json';
const OWNERS = JSON.stringify({ host: '127.0.0.1', port: 7431, carriers: [{ kind: 'tunnel', source: 'discovery' }] });

/** An in-memory filesystem that remembers each file's text and mode, and every write in order. */
function memory(initial: Record<string, { text: string; mode: number }>) {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  const port: CarrierConversionFiles = {
    readText: async path => files.get(path)?.text,
    modeOf: async path => files.get(path)?.mode,
    writeAtomic: async (path, text, mode) => {
      writes.push(path);
      files.set(path, { text, mode });
    },
  };
  return { files, writes, port };
}

describe('converting a document on disk', () => {
  it("should keep the original, write the new document, then journal it — and convert the owner's file", async () => {
    const disk = memory({ [FILE]: { text: OWNERS, mode: 0o644 } });

    const outcome = await convertLegacyCarrierKeysIn(disk.port, { file: FILE, journal: JOURNAL }, AT);

    const backup = `${FILE}.pre-carriers.2026-11-06T10-20-30-456Z`;
    expect(outcome).toEqual({
      kind: 'converted',
      file: FILE,
      backup,
      removedKeys: ['host', 'port'],
      addedEntries: [{ kind: 'bind', host: '127.0.0.1', port: 7431 }],
    });
    // The order is the contract: backup, document, journal.
    expect(disk.writes).toEqual([backup, FILE, JOURNAL]);
    // The original, byte for byte and with the mode it had.
    expect(disk.files.get(backup)).toEqual({ text: OWNERS, mode: 0o644 });
    expect(disk.files.get(FILE)?.mode).toBe(0o600);
    expect(disk.files.get(FILE)?.text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(disk.files.get(FILE)?.text ?? '')).toEqual({
      carriers: [
        { kind: 'tunnel', source: 'discovery' },
        { kind: 'bind', host: '127.0.0.1', port: 7431 },
      ],
    });
    expect(disk.files.get(JOURNAL)?.mode).toBe(0o600);
    expect(JSON.parse(disk.files.get(JOURNAL)?.text ?? '')).toEqual({
      v: 1,
      conversions: [
        {
          at: AT,
          file: FILE,
          backup,
          removedKeys: ['host', 'port'],
          addedEntries: [{ kind: 'bind', host: '127.0.0.1', port: 7431 }],
        },
      ],
    });
  });

  it('should do nothing the second time, because the converted document has no legacy keys', async () => {
    const disk = memory({ [FILE]: { text: OWNERS, mode: 0o600 } });
    await convertLegacyCarrierKeysIn(disk.port, { file: FILE, journal: JOURNAL }, AT);
    const writtenBefore = disk.writes.length;

    const second = await convertLegacyCarrierKeysIn(
      disk.port,
      { file: FILE, journal: JOURNAL },
      '2026-11-06T11:00:00.000Z',
    );

    expect(second).toEqual({ kind: 'unchanged' });
    expect(disk.writes.length).toBe(writtenBefore);
  });

  it('should append to a journal that already holds conversions, and replace one it cannot read', async () => {
    const earlier = { at: 'x', file: '/other', backup: '/other.bak', removedKeys: ['port'], addedEntries: [] };
    const disk = memory({
      [FILE]: { text: '{"port":9100}', mode: 0o600 },
      [JOURNAL]: { text: JSON.stringify({ v: 1, conversions: [earlier] }), mode: 0o600 },
    });
    await convertLegacyCarrierKeysIn(disk.port, { file: FILE, journal: JOURNAL }, AT);
    expect((JSON.parse(disk.files.get(JOURNAL)?.text ?? '') as { conversions: unknown[] }).conversions).toHaveLength(2);

    const broken = memory({
      [FILE]: { text: '{"port":9100}', mode: 0o600 },
      [JOURNAL]: { text: 'not json', mode: 0o600 },
    });
    await convertLegacyCarrierKeysIn(broken.port, { file: FILE, journal: JOURNAL }, AT);
    expect((JSON.parse(broken.files.get(JOURNAL)?.text ?? '') as { conversions: unknown[] }).conversions).toHaveLength(
      1,
    );

    const shapeless = memory({
      [FILE]: { text: '{"port":9100}', mode: 0o600 },
      [JOURNAL]: { text: 'null', mode: 0o600 },
    });
    await convertLegacyCarrierKeysIn(shapeless.port, { file: FILE, journal: JOURNAL }, AT);
    expect(
      (JSON.parse(shapeless.files.get(JOURNAL)?.text ?? '') as { conversions: unknown[] }).conversions,
    ).toHaveLength(1);
  });

  it('should never overwrite a backup that already exists', async () => {
    const taken = `${FILE}.pre-carriers.2026-11-06T10-20-30-456Z`;
    const disk = memory({
      [FILE]: { text: '{"port":9100}', mode: 0o600 },
      [taken]: { text: 'earlier original', mode: 0o600 },
    });

    const outcome = await convertLegacyCarrierKeysIn(disk.port, { file: FILE, journal: JOURNAL }, AT);

    expect(outcome.kind === 'converted' && outcome.backup).toBe(`${taken}-1`);
    expect(disk.files.get(taken)?.text).toBe('earlier original');
  });

  it('should fall back to a private backup when the original has no readable mode', async () => {
    const disk = memory({ [FILE]: { text: '{"port":9100}', mode: 0o600 } });
    disk.port.modeOf = async () => undefined;

    await convertLegacyCarrierKeysIn(disk.port, { file: FILE, journal: JOURNAL }, AT);

    expect(disk.files.get(`${FILE}.pre-carriers.2026-11-06T10-20-30-456Z`)?.mode).toBe(0o600);
  });

  it('should have nothing to do for a document that is not there or has no legacy key', async () => {
    expect(await convertLegacyCarrierKeysIn(memory({}).port, { file: FILE, journal: JOURNAL }, AT)).toEqual({
      kind: 'unchanged',
    });
    const disk = memory({ [FILE]: { text: '{"healthIntervalSeconds":90}', mode: 0o600 } });
    expect(await convertLegacyCarrierKeysIn(disk.port, { file: FILE, journal: JOURNAL }, AT)).toEqual({
      kind: 'unchanged',
    });
    expect(disk.writes).toEqual([]);
  });

  it.each([
    { name: 'invalid JSON', text: '{ "port": ', reason: 'not valid JSON' },
    {
      name: 'a relay url the schema refuses',
      text: '{"relay":{"url":"http://relay.example"}}',
      reason: 'does not parse',
    },
    { name: 'carriers that is not a list', text: '{"port":1,"carriers":"x"}', reason: 'not a list' },
  ])('should refuse $name, naming why, and write nothing', async ({ text, reason }) => {
    const disk = memory({ [FILE]: { text, mode: 0o600 } });

    const outcome = await convertLegacyCarrierKeysIn(disk.port, { file: FILE, journal: JOURNAL }, AT);

    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.reason).toContain(reason);
    expect(disk.writes).toEqual([]);
    expect(disk.files.get(FILE)?.text).toBe(text);
  });

  it('should leave the document untouched when the backup cannot be written', async () => {
    const disk = memory({ [FILE]: { text: OWNERS, mode: 0o600 } });
    const inner = disk.port.writeAtomic;
    disk.port.writeAtomic = async (path, text, mode) => {
      if (path.includes('.pre-carriers.')) throw new Error('disk full');
      await inner(path, text, mode);
    };

    await expect(convertLegacyCarrierKeysIn(disk.port, { file: FILE, journal: JOURNAL }, AT)).rejects.toThrow(
      'disk full',
    );

    expect(disk.files.get(FILE)?.text).toBe(OWNERS);
    expect(disk.files.has(JOURNAL)).toBe(false);
  });
});

describe('the two configuration stores', () => {
  it('should convert through the state-home filesystem port and keep the journal in the home', async () => {
    const modes = new Map<string, number>([[FILE, 0o640]]);
    const texts = new Map<string, string>([[FILE, '{"host":"box.lan","port":9100}']]);
    const files = {
      readText: async (path: string) => texts.get(path),
      information: async (path: string) => (modes.has(path) ? { mode: modes.get(path) } : undefined),
      writeTextAtomic: async (path: string, text: string) => {
        texts.set(path, text);
        modes.set(path, 0o600);
      },
      setMode: async (path: string, mode: number) => {
        modes.set(path, mode);
      },
    } as unknown as FileSystemPort;
    const store = new FileDaemonConfig({ daemonConfig: FILE, home: '/home' } as unknown as FoundationPaths, files);

    const outcome = await store.convertLegacyCarrierKeys(AT);

    const backup = `${FILE}.pre-carriers.2026-11-06T10-20-30-456Z`;
    expect(outcome.kind).toBe('converted');
    expect(texts.get(backup)).toBe('{"host":"box.lan","port":9100}');
    expect(modes.get(backup)).toBe(0o640);
    expect(modes.get(FILE)).toBe(0o600);
    expect(JSON.parse(texts.get(FILE) ?? '')).toEqual({ carriers: [{ kind: 'bind', host: 'box.lan', port: 9100 }] });
    expect(texts.has(`/home/${CARRIERS_JOURNAL_NAME}`)).toBe(true);
    expect(await store.convertLegacyCarrierKeys(AT)).toEqual({ kind: 'unchanged' });
  });

  it('should convert the exact file --config named, with the same mode on the backup and a private journal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fy-carriers-'));
    try {
      const path = join(directory, 'operator.json');
      await writeFile(path, OWNERS, { mode: 0o644 });
      await chmod(path, 0o644);
      const journal = join(directory, 'journal', 'carriers-migration.json');
      await mkdir(join(directory, 'journal'));
      const store = new ExplicitDaemonConfig(path, journal);

      const outcome = await store.convertLegacyCarrierKeys(AT);

      const backup = `${path}.pre-carriers.2026-11-06T10-20-30-456Z`;
      expect(outcome.kind === 'converted' && outcome.backup).toBe(backup);
      expect(await readFile(backup, 'utf8')).toBe(OWNERS);
      expect((await stat(backup)).mode & 0o777).toBe(0o644);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
        carriers: [
          { kind: 'tunnel', source: 'discovery' },
          { kind: 'bind', host: '127.0.0.1', port: 7431 },
        ],
      });
      expect((await stat(journal)).mode & 0o777).toBe(0o600);
      expect(await store.convertLegacyCarrierKeys(AT)).toEqual({ kind: 'unchanged' });
      // A document that is not there is nothing to convert, and creates nothing.
      expect(await new ExplicitDaemonConfig(join(directory, 'absent.json')).convertLegacyCarrierKeys(AT)).toEqual({
        kind: 'unchanged',
      });
      await expect(stat(join(directory, 'absent.json'))).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('should keep the journal beside the document when --config names no home', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fy-carriers-'));
    try {
      const path = join(directory, 'operator.json');
      await writeFile(path, '{"port":9100}');

      await new ExplicitDaemonConfig(path).convertLegacyCarrierKeys(AT);

      expect(JSON.parse(await readFile(join(directory, CARRIERS_JOURNAL_NAME), 'utf8'))).toHaveProperty('v', 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
