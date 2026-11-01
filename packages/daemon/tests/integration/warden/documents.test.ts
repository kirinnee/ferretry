import { afterAll, describe, it } from 'bun:test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_WARDEN_CONFIG, mergeWardenConfig, type WardenConfigPatch } from '@ferretry/protocol';
import should from 'should';
import {
  ConfigFileWardenConfigStore,
  FileAutoMigrateLedger,
  FileWardenStateStore,
  NodeWardenReportFileSystem,
  WARDEN_STATE_FILENAME,
} from '../../../src/adapters/warden/index.ts';
import {
  createWardenPaths,
  defaultWardenConfig,
  EMPTY_AUTO_MIGRATE_MEMORY,
  parseAutoMigrateMemory,
  parseStoredWardenConfig,
  parseWardenRuntimeState,
  recordMove,
  type WardenRuntimeState,
} from '../../../src/lib/warden/index.ts';
import { configHome } from '../fleet/config-files-fixture.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/** A throwaway state home with nothing in it yet — the first-boot situation. */
async function wardenHome(label: string): Promise<{ root: string; files: NodeWardenReportFileSystem }> {
  const home = await tempDirectory(label);
  return { root: createWardenPaths(path.join(home, 'state')).root, files: new NodeWardenReportFileSystem() };
}

const STATE: WardenRuntimeState = {
  lastSweepAt: '2026-07-31T12:00:00.000Z',
  lastFingerprint: 'sus_thinking:s1',
  recoveryGeneration: 2,
  failover: { strikes: { a: { count: 2, lastAt: '2026-07-31T11:00:00.000Z', lastReason: 'tmux refused' } } },
};

afterAll(cleanupTempDirectories);

describe('the durable warden state document', () => {
  it('should read as absent before any sweep has run', async () => {
    // Arrange
    const { root, files } = await wardenHome('warden-state-absent');

    // Act
    const actual = await new FileWardenStateStore(files, root).read();

    // Assert
    should(actual).be.undefined();
    should(parseWardenRuntimeState(actual)).deepEqual({});
  });

  it('should round-trip everything one sweep must tell the next', async () => {
    // Arrange
    const { root, files } = await wardenHome('warden-state-roundtrip');
    const store = new FileWardenStateStore(files, root);

    // Act
    await store.write(STATE);

    // Assert
    should(parseWardenRuntimeState(await store.read())).deepEqual(STATE);
  });

  it('should create the warden directory owner-only on the first write', async () => {
    // Arrange: the document holds the capability that authorizes stopping a session.
    const { root, files } = await wardenHome('warden-state-mode');

    // Act
    await new FileWardenStateStore(files, root).write(STATE);

    // Assert
    should((await stat(root)).mode & 0o777).equal(0o700);
    should((await stat(path.join(root, WARDEN_STATE_FILENAME))).mode & 0o777).equal(0o600);
  });

  it('should write readable JSON, because an operator debugs supervision by reading it', async () => {
    // Arrange
    const { root, files } = await wardenHome('warden-state-readable');

    // Act
    await new FileWardenStateStore(files, root).write(STATE);

    // Assert
    const raw = await readFile(path.join(root, WARDEN_STATE_FILENAME), 'utf8');
    should(raw).endWith('\n');
    should(raw.split('\n').length).be.greaterThan(1);
  });

  it('should replace an earlier document rather than appending to it', async () => {
    // Arrange
    const { root, files } = await wardenHome('warden-state-replace');
    const store = new FileWardenStateStore(files, root);
    await store.write(STATE);

    // Act
    await store.write({ lastSweepAt: '2026-07-31T13:00:00.000Z' });

    // Assert
    should(parseWardenRuntimeState(await store.read())).deepEqual({ lastSweepAt: '2026-07-31T13:00:00.000Z' });
  });

  it.each([
    { label: 'a torn write', content: '{"lastSweepAt":' },
    { label: 'an empty file', content: '' },
    { label: 'whitespace only', content: '  \n' },
  ])('should read $label as absent rather than throwing', async ({ content }) => {
    // Arrange: the domain owns the fallback policy, and "remember nothing" is what it decides.
    const { root, files } = await wardenHome(`warden-state-${content.length}`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(path.join(root, WARDEN_STATE_FILENAME), content, 'utf8');

    // Act / Assert
    should(await new FileWardenStateStore(files, root).read()).be.undefined();
  });

  it('should read as absent when the path is a directory rather than a document', async () => {
    // Arrange: an unreadable path is the caller's fallback to decide, never an exception here.
    const { root, files } = await wardenHome('warden-state-directory');
    await mkdir(path.join(root, WARDEN_STATE_FILENAME), { recursive: true });

    // Act / Assert
    should(await new FileWardenStateStore(files, root).read()).be.undefined();
  });
});

describe('the Warden move ledger document', () => {
  it('should read as a fresh ledger before anything moved, and round-trip the moves after', async () => {
    // Arrange
    const { root, files } = await wardenHome('warden-move-ledger');
    const ledger = new FileAutoMigrateLedger(files, root);
    const moved = recordMove(EMPTY_AUTO_MIGRATE_MEMORY, 's1', Date.parse('2026-11-01T12:00:00.000Z'));

    // Act
    const before = parseAutoMigrateMemory(await ledger.read());
    await ledger.write(moved);
    const after = parseAutoMigrateMemory(await ledger.read());

    // Assert
    should(before).deepEqual(EMPTY_AUTO_MIGRATE_MEMORY);
    should(after).deepEqual(moved);
  });
});

describe('the warden settings file', () => {
  /** The configuration service, with every `writeOwn` counted. */
  async function settings(label: string) {
    const home = await configHome(await tempDirectory(label));
    const writes: string[] = [];
    const store = new ConfigFileWardenConfigStore({
      inEffect: async () => await home.service.inEffect(),
      load: async () => await home.service.load(),
      writeOwn: async (file, text, inEffect) => {
        writes.push(file);
        await home.service.writeOwn(file, text, inEffect);
      },
    });
    return { home, store, writes, file: path.join(home.paths.config, 'warden.yaml') };
  }

  it('should read the defaults on a state home that has never been configured, and write nothing', async () => {
    // Arrange
    const { store, writes, file } = await settings('warden-config-absent');

    // Act
    const actual = await store.read();
    await store.write(defaultWardenConfig, {});

    // Assert
    should(actual).deepEqual(DEFAULT_WARDEN_CONFIG);
    should(parseStoredWardenConfig(actual)).deepEqual({ config: defaultWardenConfig, warnings: [] });
    should(writes).deepEqual([]);
    should(await Bun.file(file).exists()).be.false();
  });

  it('should round-trip a configuration the owner changed, in effect at once even though it loosens', async () => {
    // Arrange
    const { home, store, file } = await settings('warden-config-roundtrip');
    const configured = { ...defaultWardenConfig, layers: { jev: false, llm: true }, intervalMinutes: 10 as const };

    // Act
    await store.write(configured, { layers: configured.layers, intervalMinutes: configured.intervalMinutes });

    // Assert — the owner's own act is acknowledged, never held as an unconfirmed loosening.
    should(parseStoredWardenConfig(await store.read())).deepEqual({ config: configured, warnings: [] });
    should((await home.service.load()).evaluation.pending).deepEqual([]);
    should((await stat(file)).mode & 0o777).equal(0o600);
  });

  it('should write the layers and never the legacy triage a hand-written file still says', async () => {
    // Arrange
    const { home, store, file } = await settings('warden-config-legacy');
    await writeFile(file, 'triage: rules\nintervalMinutes: 10\n', 'utf8');
    await home.service.load();
    const legacy = parseStoredWardenConfig(await store.read()).config;

    // Act
    await store.write({ ...legacy, layers: { jev: true, llm: false } }, { layers: { jev: true, llm: false } });

    // Assert
    const text = await readFile(file, 'utf8');
    should(legacy.layers).deepEqual({ jev: false, llm: false });
    should(text).match(/layers:\n {2}jev: true/u);
    should(text).not.match(/triage/u);
  });

  it('should read the version in effect, not the file: a hand edit that loosens is held', async () => {
    // Arrange
    const { home, store, file } = await settings('warden-config-held');
    await writeFile(file, 'triage: llm\n', 'utf8');

    // Act
    const actual = await store.read();

    // Assert
    should(actual).deepEqual(DEFAULT_WARDEN_CONFIG);
    should((await home.service.load()).evaluation.pending).match([{ path: 'warden.yaml' }]);
  });

  it('should keep the last good settings while the file is broken', async () => {
    // Arrange
    const { store, file } = await settings('warden-config-broken');
    await store.write({ ...defaultWardenConfig, intervalMinutes: 10 as const }, { intervalMinutes: 10 });
    await writeFile(file, 'intervalMinutes: [not, a, number\n', 'utf8');

    // Act
    const actual = await store.read();

    // Assert
    should(actual).match({ intervalMinutes: 10 });
  });

  it("should change only the keys that moved, keeping the owner's comments", async () => {
    // Arrange
    const { store, file } = await settings('warden-config-comments');
    await writeFile(file, '# how often the Warden looks\nintervalMinutes: 5\n', 'utf8');

    // Act
    await store.write({ ...defaultWardenConfig, intervalMinutes: 10 as const }, { intervalMinutes: 10 });

    // Assert
    const text = await readFile(file, 'utf8');
    should(text).containEql('# how often the Warden looks');
    should(text).match(/intervalMinutes: 10/);
    should(await store.read()).match({ intervalMinutes: 10 });
  });

  it('should write nothing when the settings did not change', async () => {
    // Arrange
    const { store, writes, file } = await settings('warden-config-unchanged');
    const configured = { ...defaultWardenConfig, intervalMinutes: 10 as const };
    await store.write(configured, { intervalMinutes: 10 });
    const before = await readFile(file, 'utf8');

    // Act
    await store.write(configured, { intervalMinutes: 10 });

    // Assert
    should(writes).deepEqual(['warden.yaml']);
    should(await readFile(file, 'utf8')).equal(before);
  });
  describe('while an edit waits for the owner', () => {
    /** Settings in effect at $2 per million, then a hand edit to the real $0.042, held because it loosens. */
    async function heldPrice(label: string) {
      const home = await settings(label);
      const atTwo = mergeWardenConfig(defaultWardenConfig, { guard: { usdPerMillionInputTokens: 2 } });
      await home.store.write(atTwo, { guard: { usdPerMillionInputTokens: 2 } });
      const text = await readFile(home.file, 'utf8');
      await writeFile(
        home.file,
        text.replace('usdPerMillionInputTokens: 2', 'usdPerMillionInputTokens: 0.042'),
        'utf8',
      );
      await home.home.service.load();
      /** What the app sends: the settings in effect with the owner's patch, and the patch. */
      const save = async (patch: WardenConfigPatch): Promise<void> => {
        const inEffect = parseStoredWardenConfig(await home.store.read()).config;
        await home.store.write(mergeWardenConfig(inEffect, patch), patch);
      };
      return { ...home, save };
    }

    it('should never put a held price back to the one in effect when the owner saves another setting', async () => {
      // Arrange: 2026-10-29 — a save of the daily caps rewrote the held $0.042 back to $2.
      const { home, store, file, save } = await heldPrice('warden-config-held-price');
      should((await home.service.load()).evaluation.pending).match([{ path: 'warden.yaml' }]);

      // Act
      await save({ caps: { jevUsdPerDay: 1 } });

      // Assert: the owner's change is in effect at once; the held price is still in the file, still held.
      const text = await readFile(file, 'utf8');
      should(text).match(/usdPerMillionInputTokens: 0\.042/u);
      should(text).match(/jevUsdPerDay: 1/u);
      should(await store.read()).match({ caps: { jevUsdPerDay: 1 }, guard: { usdPerMillionInputTokens: 2 } });
      const held = (await home.service.load()).evaluation.pending;
      should(held).match([{ path: 'warden.yaml' }]);
      should(held[0]?.changes.join(' ')).match(/Jev price/u);
    });

    it("should put the held price into effect, with the owner's other change, once it is confirmed", async () => {
      // Arrange
      const { home, store, save } = await heldPrice('warden-config-held-confirm');
      await save({ caps: { jevUsdPerDay: 1 } });
      const [held] = (await home.service.load()).evaluation.pending;

      // Act
      const confirmed = await home.service.confirm('warden.yaml', held?.etag ?? '');

      // Assert
      should(confirmed).be.true();
      should(await store.read()).match({ caps: { jevUsdPerDay: 1 }, guard: { usdPerMillionInputTokens: 0.042 } });
    });

    it('should settle the hold when the owner saves the held value themselves', async () => {
      // Arrange
      const { home, store, file, save } = await heldPrice('warden-config-held-settled');

      // Act
      await save({ guard: { usdPerMillionInputTokens: 0.042 } });

      // Assert
      should((await home.service.load()).evaluation.pending).deepEqual([]);
      should(await store.read()).match({ guard: { usdPerMillionInputTokens: 0.042 } });
      should(await readFile(file, 'utf8')).match(/usdPerMillionInputTokens: 0\.042/u);
    });

    it('should save as before when the held file no longer checks, the last good version in effect', async () => {
      // Arrange: nothing is held for a file that does not parse — it is broken, and the save repairs it.
      const { home, store, file } = await settings('warden-config-held-broken');
      await writeFile(file, 'intervalMinutes: [not, a, number\n', 'utf8');
      await home.service.load();

      // Act
      await store.write({ ...defaultWardenConfig, intervalMinutes: 10 as const }, { intervalMinutes: 10 });

      // Assert
      should(await store.read()).match({ intervalMinutes: 10 });
      should((await home.service.load()).evaluation.pending).deepEqual([]);
    });
  });
});
