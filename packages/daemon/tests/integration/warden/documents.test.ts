import { afterAll, describe, it } from 'bun:test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import {
  FileWardenConfigStore,
  FileWardenStateStore,
  NodeWardenReportFileSystem,
  WARDEN_CONFIG_FILENAME,
  WARDEN_STATE_FILENAME,
} from '../../../src/adapters/warden/index.ts';
import {
  createWardenPaths,
  defaultWardenConfig,
  parseStoredWardenConfig,
  parseWardenRuntimeState,
  type WardenRuntimeState,
} from '../../../src/lib/warden/index.ts';
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

describe('the warden configuration document', () => {
  it('should read as absent on a state home that has never been configured', async () => {
    // Arrange
    const { root, files } = await wardenHome('warden-config-absent');

    // Act
    const actual = await new FileWardenConfigStore(files, root).read();

    // Assert
    should(parseStoredWardenConfig(actual)).deepEqual({ config: defaultWardenConfig, warnings: [] });
  });

  it('should round-trip a configuration an operator changed', async () => {
    // Arrange
    const { root, files } = await wardenHome('warden-config-roundtrip');
    const store = new FileWardenConfigStore(files, root);
    const configured = { ...defaultWardenConfig, enabled: true, intervalMinutes: 11 };

    // Act
    await store.write(configured);

    // Assert
    should(parseStoredWardenConfig(await store.read())).deepEqual({ config: configured, warnings: [] });
  });

  it('should live beside the state rather than inside the daemon configuration', async () => {
    // Arrange
    const { root, files } = await wardenHome('warden-config-location');

    // Act
    await new FileWardenConfigStore(files, root).write(defaultWardenConfig);

    // Assert
    should((await stat(path.join(root, WARDEN_CONFIG_FILENAME))).isFile()).be.true();
  });

  it('should surface a hand-edited document to the domain, which falls back and says so', async () => {
    // Arrange
    const { root, files } = await wardenHome('warden-config-invalid');
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(path.join(root, WARDEN_CONFIG_FILENAME), JSON.stringify({ enabled: true }), 'utf8');

    // Act
    const actual = parseStoredWardenConfig(await new FileWardenConfigStore(files, root).read());

    // Assert
    should(actual.config.enabled).be.false();
    should(actual.warnings).have.length(1);
  });
});
