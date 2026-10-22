import { afterAll, describe, it } from 'bun:test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_WARDEN_CONFIG } from '@ferretry/protocol';
import should from 'should';
import {
  ConfigFileWardenConfigStore,
  FileWardenStateStore,
  NodeWardenReportFileSystem,
  WARDEN_STATE_FILENAME,
} from '../../../src/adapters/warden/index.ts';
import {
  createWardenPaths,
  defaultWardenConfig,
  parseStoredWardenConfig,
  parseWardenRuntimeState,
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

describe('the warden settings file', () => {
  /** The configuration service, with every `writeOwn` counted. */
  async function settings(label: string) {
    const home = await configHome(await tempDirectory(label));
    const writes: string[] = [];
    const store = new ConfigFileWardenConfigStore({
      inEffect: async () => await home.service.inEffect(),
      load: async () => await home.service.load(),
      writeOwn: async (file, text) => {
        writes.push(file);
        await home.service.writeOwn(file, text);
      },
    });
    return { home, store, writes, file: path.join(home.paths.config, 'warden.yaml') };
  }

  it('should read the defaults on a state home that has never been configured, and write nothing', async () => {
    // Arrange
    const { store, writes, file } = await settings('warden-config-absent');

    // Act
    const actual = await store.read();
    await store.write(defaultWardenConfig);

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
    await store.write(configured);

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
    await store.write({ ...legacy, layers: { jev: true, llm: false } });

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
    await store.write({ ...defaultWardenConfig, intervalMinutes: 10 as const });
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
    await store.write({ ...defaultWardenConfig, intervalMinutes: 10 as const });

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
    await store.write(configured);
    const before = await readFile(file, 'utf8');

    // Act
    await store.write(configured);

    // Assert
    should(writes).deepEqual(['warden.yaml']);
    should(await readFile(file, 'utf8')).equal(before);
  });
});
