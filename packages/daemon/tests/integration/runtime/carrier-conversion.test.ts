import { afterEach, describe, it } from 'bun:test';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { CARRIERS_JOURNAL_NAME, FileDaemonConfig } from '../../../src/adapters/runtime/daemon-config.ts';
import { createFoundationPaths, type FoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

const AT = '2026-11-06T10:20:30.456Z';
const LEGACY = JSON.stringify({ host: '127.0.0.1', port: 7431 });
const CONVERTED = JSON.stringify({ carriers: [{ kind: 'bind', host: '127.0.0.1', port: 7431 }] });

/**
 * The carriers conversion over a REAL state home: the file adapters and the confined filesystem port
 * together, which is the only tier that shows a recovered journal or an unreadable document behaves on
 * a real disk the way the unit tier's in-memory filesystem says it does.
 */
async function stateHome(daemonJson: string | undefined): Promise<{
  readonly paths: FoundationPaths;
  readonly store: FileDaemonConfig;
  readonly journal: string;
}> {
  const home = await tempDirectory('fyd-carriers-conversion');
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: '/home-must-not-be-used' }));
  await mkdir(dirname(paths.daemonConfig), { recursive: true });
  if (daemonJson !== undefined) await writeFile(paths.daemonConfig, daemonJson, { mode: 0o600 });
  return {
    paths,
    store: new FileDaemonConfig(paths, new StateFileSystem(paths)),
    journal: join(paths.home, CARRIERS_JOURNAL_NAME),
  };
}

/** A conversion that was journalled ahead of the document and never settled. */
const pending = (file: string) => ({
  status: 'pending',
  at: AT,
  file,
  backup: `${file}.pre-carriers.earlier`,
  removedKeys: ['host', 'port'],
  addedEntries: [{ kind: 'bind', host: '127.0.0.1', port: 7431 }],
});

const journalOf = async (journal: string) =>
  JSON.parse(await readFile(journal, 'utf8')) as { v: number; conversions: Array<Record<string, unknown>> };

describe('the carriers conversion over a real state home', () => {
  afterEach(async () => await cleanupTempDirectories());

  it('should settle a pending entry as converted when the crash came after the document was replaced', async () => {
    // Arrange — the process stopped between the document write and the journal rewrite.
    const { paths, store, journal } = await stateHome(CONVERTED);
    await writeFile(journal, JSON.stringify({ v: 1, conversions: [pending(paths.daemonConfig)] }), { mode: 0o600 });

    // Act
    const outcome = await store.convertLegacyCarrierKeys(AT);

    // Assert
    should(outcome).deepEqual({ kind: 'unchanged' });
    const recorded = await journalOf(journal);
    should(recorded.conversions).have.length(1);
    should(recorded.conversions[0]).have.property('status', 'converted');
    should(await readFile(paths.daemonConfig, 'utf8')).equal(CONVERTED);
  });

  it('should settle a pending entry as abandoned when the crash came before the document was replaced', async () => {
    // Arrange — the document still spells the legacy keys, so the replacement never happened.
    const { paths, store, journal } = await stateHome(LEGACY);
    await writeFile(journal, JSON.stringify({ v: 1, conversions: [pending(paths.daemonConfig)] }), { mode: 0o600 });

    // Act
    const outcome = await store.convertLegacyCarrierKeys(AT);

    // Assert — the stale entry is settled first, and the same call then converts the document afresh.
    should(outcome.kind).equal('converted');
    const recorded = await journalOf(journal);
    should(recorded.conversions.map(entry => entry.status)).deepEqual(['abandoned', 'converted']);
    should(JSON.parse(await readFile(paths.daemonConfig, 'utf8'))).have.property('carriers');
  });

  it('should settle a pending entry as abandoned when the document is gone', async () => {
    // Arrange
    const { paths, store, journal } = await stateHome(undefined);
    await writeFile(journal, JSON.stringify({ v: 1, conversions: [pending(paths.daemonConfig)] }), { mode: 0o600 });

    // Act
    const outcome = await store.convertLegacyCarrierKeys(AT);

    // Assert
    should(outcome).deepEqual({ kind: 'unchanged' });
    should((await journalOf(journal)).conversions[0]).have.property('status', 'abandoned');
  });

  it('should settle a pending entry as abandoned and refuse a document that is no longer JSON', async () => {
    // Arrange — nothing proves a document that cannot be read was ours, so it is not "converted".
    const { paths, store, journal } = await stateHome('{ not json');
    await writeFile(journal, JSON.stringify({ v: 1, conversions: [pending(paths.daemonConfig)] }), { mode: 0o600 });

    // Act
    const outcome = await store.convertLegacyCarrierKeys(AT);

    // Assert
    should(outcome).deepEqual({ kind: 'refused', reason: 'it is not valid JSON' });
    should((await journalOf(journal)).conversions[0]).have.property('status', 'abandoned');
    should(await readFile(paths.daemonConfig, 'utf8')).equal('{ not json');
  });

  it('should not settle a pending entry that belongs to another file', async () => {
    // Arrange
    const { paths, store, journal } = await stateHome(CONVERTED);
    const other = pending('/somewhere/else/daemon.json');
    await writeFile(journal, JSON.stringify({ v: 1, conversions: [other] }), { mode: 0o600 });

    // Act
    await store.convertLegacyCarrierKeys(AT);

    // Assert
    should((await journalOf(journal)).conversions).deepEqual([other]);
    should(await readFile(paths.daemonConfig, 'utf8')).equal(CONVERTED);
  });

  it('should replace a journal that is not JSON rather than stop over it', async () => {
    // Arrange
    const { paths, store, journal } = await stateHome(LEGACY);
    await writeFile(journal, 'garbage, not a journal', { mode: 0o600 });

    // Act
    const outcome = await store.convertLegacyCarrierKeys(AT);

    // Assert
    should(outcome.kind).equal('converted');
    const recorded = await journalOf(journal);
    should(recorded.conversions.map(entry => entry.status)).deepEqual(['converted']);
    should(JSON.parse(await readFile(paths.daemonConfig, 'utf8'))).not.have.property('host');
  });

  it('should treat a journal with no conversions list as empty', async () => {
    // Arrange
    const { store, journal } = await stateHome(LEGACY);
    await writeFile(journal, JSON.stringify({ v: 1 }), { mode: 0o600 });

    // Act
    const outcome = await store.convertLegacyCarrierKeys(AT);

    // Assert
    should(outcome.kind).equal('converted');
    should((await journalOf(journal)).conversions.map(entry => entry.status)).deepEqual(['converted']);
  });

  it('should refuse a document that is not JSON and leave it, with no backup or journal', async () => {
    // Arrange
    const { paths, store, journal } = await stateHome('{ not json');

    // Act
    const outcome = await store.convertLegacyCarrierKeys(AT);

    // Assert
    should(outcome).deepEqual({ kind: 'refused', reason: 'it is not valid JSON' });
    should(await readFile(paths.daemonConfig, 'utf8')).equal('{ not json');
    should(await readdir(dirname(paths.daemonConfig))).deepEqual(['daemon.json']);
    await should(readFile(journal, 'utf8')).be.rejected();
  });
});
