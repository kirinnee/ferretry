import { describe, expect, it } from 'bun:test';
import { chmod, lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CarrierConversionFiles,
  convertLegacyCarrierKeysIn,
} from '../../../src/adapters/runtime/carrier-conversion.ts';
import { CARRIERS_JOURNAL_NAME, FileDaemonConfig } from '../../../src/adapters/runtime/daemon-config.ts';
import { ExplicitDaemonConfig } from '../../../src/adapters/runtime/explicit-config.ts';
import type { FileSystemPort, FoundationPaths } from '../../../src/lib/index.ts';
import { defaultDaemonConfigDocument } from '../../../src/lib/runtime/config.ts';

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
  it("should keep the original, journal it ahead, write the new document, then settle the entry — and convert the owner's file", async () => {
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
    // The order is the contract: backup, journal entry ahead, document, entry settled.
    expect(disk.writes).toEqual([backup, JOURNAL, FILE, JOURNAL]);
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
          status: 'converted',
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

describe('a conversion that is interrupted', () => {
  const journalOf = (disk: ReturnType<typeof memory>) =>
    JSON.parse(disk.files.get(JOURNAL)?.text ?? '{}') as { v: number; conversions: Record<string, unknown>[] };

  /** Fails the nth write to `path` (1-based), once, as a disk that filled or a process that died would. */
  function failing(disk: ReturnType<typeof memory>, path: string, nth: number) {
    let seen = 0;
    let armed = true;
    const inner = disk.port.writeAtomic;
    disk.port.writeAtomic = async (target, text, mode) => {
      if (target === path && armed && ++seen === nth) {
        armed = false;
        throw new Error('power lost');
      }
      await inner(target, text, mode);
    };
  }

  it('should have the entry on record when the document write fails, and abandon it next time while converting once', async () => {
    const disk = memory({ [FILE]: { text: OWNERS, mode: 0o600 } });
    failing(disk, FILE, 1);

    await expect(convertLegacyCarrierKeysIn(disk.port, { file: FILE, journal: JOURNAL }, AT)).rejects.toThrow(
      'power lost',
    );

    const backup = `${FILE}.pre-carriers.2026-11-06T10-20-30-456Z`;
    expect(disk.files.get(FILE)?.text).toBe(OWNERS);
    expect(disk.files.get(backup)?.text).toBe(OWNERS);
    expect(journalOf(disk).conversions.map(entry => [entry.status, entry.backup])).toEqual([['pending', backup]]);

    const later = '2026-11-06T11:00:00.000Z';
    const outcome = await convertLegacyCarrierKeysIn(disk.port, { file: FILE, journal: JOURNAL }, later);

    const second = `${FILE}.pre-carriers.2026-11-06T11-00-00-000Z`;
    expect(outcome.kind === 'converted' && outcome.backup).toBe(second);
    expect(journalOf(disk).conversions.map(entry => [entry.status, entry.backup])).toEqual([
      ['abandoned', backup],
      ['converted', second],
    ]);
    // Neither backup was touched by the other.
    expect(disk.files.get(backup)?.text).toBe(OWNERS);
    expect(disk.files.get(second)?.text).toBe(OWNERS);
    expect(JSON.parse(disk.files.get(FILE)?.text ?? '')).not.toHaveProperty('port');
  });

  it('should settle the entry as converted when the last journal write fails, and never convert again', async () => {
    const disk = memory({ [FILE]: { text: OWNERS, mode: 0o600 } });
    failing(disk, JOURNAL, 2);

    await expect(convertLegacyCarrierKeysIn(disk.port, { file: FILE, journal: JOURNAL }, AT)).rejects.toThrow(
      'power lost',
    );

    const backup = `${FILE}.pre-carriers.2026-11-06T10-20-30-456Z`;
    // The document was replaced, and the record of it survived as a pending entry.
    expect(JSON.parse(disk.files.get(FILE)?.text ?? '')).not.toHaveProperty('port');
    expect(journalOf(disk).conversions.map(entry => [entry.status, entry.backup])).toEqual([['pending', backup]]);
    const converted = disk.files.get(FILE)?.text;
    const writtenBefore = disk.writes.length;

    const outcome = await convertLegacyCarrierKeysIn(
      disk.port,
      { file: FILE, journal: JOURNAL },
      '2026-11-06T11:00:00.000Z',
    );

    expect(outcome).toEqual({ kind: 'unchanged' });
    expect(journalOf(disk).conversions.map(entry => [entry.status, entry.backup])).toEqual([['converted', backup]]);
    expect(disk.files.get(FILE)?.text).toBe(converted);
    // One write — the journal settling — and no second backup.
    expect(disk.writes.slice(writtenBefore)).toEqual([JOURNAL]);
    expect(disk.files.get(backup)?.text).toBe(OWNERS);
  });

  it('should leave the document and the journal alone when the entry cannot be written ahead', async () => {
    const disk = memory({ [FILE]: { text: OWNERS, mode: 0o600 } });
    failing(disk, JOURNAL, 1);

    await expect(convertLegacyCarrierKeysIn(disk.port, { file: FILE, journal: JOURNAL }, AT)).rejects.toThrow(
      'power lost',
    );

    expect(disk.files.get(FILE)?.text).toBe(OWNERS);
    expect(disk.files.has(JOURNAL)).toBe(false);
  });

  it('should abandon a pending entry whose document is gone or unreadable, and leave other files entries pending', async () => {
    const pending = (file: string, backup: string) => ({ status: 'pending', at: AT, file, backup });
    const disk = memory({
      [JOURNAL]: {
        text: JSON.stringify({
          v: 1,
          conversions: [pending(FILE, `${FILE}.bak`), pending('/other/daemon.json', '/other.bak')],
        }),
        mode: 0o600,
      },
    });

    expect(await convertLegacyCarrierKeysIn(disk.port, { file: FILE, journal: JOURNAL }, AT)).toEqual({
      kind: 'unchanged',
    });

    expect(journalOf(disk).conversions.map(entry => entry.status)).toEqual(['abandoned', 'pending']);
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
    expect(JSON.parse(texts.get(`/home/${CARRIERS_JOURNAL_NAME}`) ?? '')).toMatchObject({
      conversions: [{ status: 'converted', file: FILE, backup }],
    });
    expect(await store.convertLegacyCarrierKeys(AT)).toEqual({ kind: 'unchanged' });
  });

  describe('recording the settled port after a conversion that did not happen', () => {
    /** The state-home filesystem port over a map, failing any write whose path `failing` accepts. */
    const stateHome = (text: string, failing: (path: string) => boolean) => {
      const texts = new Map<string, string>([[FILE, text]]);
      const files = {
        readText: async (path: string) => texts.get(path),
        information: async (path: string) => (texts.has(path) ? { mode: 0o600 } : undefined),
        writeTextAtomic: async (path: string, written: string) => {
          if (failing(path)) throw new Error('injected write failure');
          texts.set(path, written);
        },
        setMode: async () => undefined,
      } as unknown as FileSystemPort;
      const store = new FileDaemonConfig({ daemonConfig: FILE, home: '/home' } as unknown as FoundationPaths, files);
      return { texts, store };
    };
    const JOURNAL_PATH = `/home/${CARRIERS_JOURNAL_NAME}`;

    it.each([
      { name: 'a host only', document: { host: '127.0.0.1' } },
      { name: 'a port of 0', document: { host: '127.0.0.1', port: 0 } },
    ])('should keep $name spelled the legacy way when the backup cannot be written', async ({ document }) => {
      const text = JSON.stringify(document);
      const { texts, store } = stateHome(text, path => path.includes('.pre-carriers.'));

      await expect(store.convertLegacyCarrierKeys(AT)).rejects.toThrow('injected write failure');
      await store.record(9_100);

      // The recorder is no way round the journal: no bind entry, no deleted key, no partial conversion.
      expect(JSON.parse(texts.get(FILE) ?? '')).toEqual({ ...document, port: 9_100 });
      expect(texts.has(JOURNAL_PATH)).toBe(false);
      expect([...texts.keys()].filter(path => path.includes('.pre-carriers.'))).toEqual([]);
    });

    it('should keep the legacy spelling when the pending journal entry cannot be written', async () => {
      const { texts, store } = stateHome('{"host":"127.0.0.1"}', path => path === JOURNAL_PATH);

      await expect(store.convertLegacyCarrierKeys(AT)).rejects.toThrow('injected write failure');
      await store.record(9_100);

      expect(JSON.parse(texts.get(FILE) ?? '')).toEqual({ host: '127.0.0.1', port: 9_100 });
      expect(texts.has(JOURNAL_PATH)).toBe(false);
    });

    it('should leave a refused document exactly as it is, and record nothing into it', async () => {
      // The plan refuses a legacy document that does not parse as it stands; the recorder holds the same refusal.
      const text = '{"host":"127.0.0.1","relay":{"url":"http://relay.example"}}';
      const { texts, store } = stateHome(text, () => false);

      const outcome = await store.convertLegacyCarrierKeys(AT);
      await expect(store.record(9_100)).rejects.toThrow();

      expect(outcome.kind).toBe('refused');
      expect(texts.get(FILE)).toBe(text);
      expect(texts.size).toBe(1);
    });

    it('should write the legacy port into a --config file the conversion refused', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'fy-carriers-'));
      try {
        const path = join(directory, 'operator.json');
        await writeFile(path, '{"host":"127.0.0.1"}');
        const store = new ExplicitDaemonConfig(path);

        expect((await store.convertLegacyCarrierKeys(AT)).kind).toBe('refused');
        await store.record(9_100);

        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ host: '127.0.0.1', port: 9_100 });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it('should still record a fresh first boot into the bind entry it seeded', async () => {
      const { texts, store } = stateHome(JSON.stringify(defaultDaemonConfigDocument()), () => false);

      expect(await store.convertLegacyCarrierKeys(AT)).toEqual({ kind: 'unchanged' });
      await store.record(9_100);

      expect(JSON.parse(texts.get(FILE) ?? '')).toMatchObject({
        carriers: [{ kind: 'bind', host: '127.0.0.1', port: 9_100 }],
      });
      expect(Object.hasOwn(JSON.parse(texts.get(FILE) ?? ''), 'port')).toBe(false);
    });
  });

  it('should never write into a file --config named, only say it was left alone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fy-carriers-'));
    try {
      const path = join(directory, 'operator.json');
      await writeFile(path, OWNERS, { mode: 0o644 });
      await chmod(path, 0o644);
      const link = join(directory, 'linked.json');
      await symlink(path, link);

      for (const named of [path, link]) {
        const outcome = await new ExplicitDaemonConfig(named).convertLegacyCarrierKeys(AT);

        expect(outcome).toEqual({
          kind: 'refused',
          reason:
            'an operator-named --config file is never rewritten at boot; move host/port/relay into its "carriers" list by hand',
        });
      }
      // Byte for byte, mode and symlink intact, and nothing created beside it.
      expect(await readFile(path, 'utf8')).toBe(OWNERS);
      expect((await stat(path)).mode & 0o777).toBe(0o644);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect((await readdir(directory)).sort()).toEqual(['linked.json', 'operator.json']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('should have nothing to say about a --config file with no legacy key, a broken one, or one that is not there', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fy-carriers-'));
    try {
      const converted = join(directory, 'converted.json');
      await writeFile(converted, '{"carriers":[{"kind":"bind","host":"127.0.0.1","port":9100}]}');
      const broken = join(directory, 'broken.json');
      await writeFile(broken, '{ "port": ');

      for (const named of [converted, broken, join(directory, 'absent.json')])
        expect(await new ExplicitDaemonConfig(named).convertLegacyCarrierKeys(AT)).toEqual({ kind: 'unchanged' });

      expect((await readdir(directory)).sort()).toEqual(['broken.json', 'converted.json']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
