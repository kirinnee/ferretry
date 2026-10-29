import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { BunSqliteIndexFactory, StateFileSystem } from '../../src/adapters/index.ts';
import {
  createFoundationPaths,
  type FoundationPaths,
  type IndexedSession,
  parseSessionId,
  resolveStateHome,
} from '../../src/lib/index.ts';

/** The index's journal fingerprint, against a real SQLite file: it is stored whole or not at all. */

const directories = new Set<string>();

async function createTemporaryPaths(): Promise<FoundationPaths> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-index-fingerprint-'));
  directories.add(home);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: '/home-must-not-be-used' }));
  await mkdir(paths.index, { recursive: true });
  return paths;
}

afterEach(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
});

describe('session index journal fingerprint', () => {
  it('should read a session indexed without a journal back as having none, and a fingerprinted one back whole', async () => {
    // Arrange
    const paths = await createTemporaryPaths();
    const index = await new BunSqliteIndexFactory().open(paths, new StateFileSystem(paths));
    const bare: IndexedSession = {
      id: parseSessionId('20260806-bare'),
      lastSequence: 0,
      journalLine: 1,
      journal: null,
    };
    const fingerprinted: IndexedSession = {
      id: parseSessionId('20260806-stamped'),
      lastSequence: 2,
      journalLine: 3,
      journal: { device: '64768', inode: '1234', size: 99, modifiedAtMs: 1_786_000_000_000 },
    };

    // Act
    index.refreshSession(bare);
    index.refreshSession(fingerprinted);
    const foundBare = index.findSession(bare.id);
    const foundStamped = index.findSession(fingerprinted.id);
    index.close();

    // Assert
    should(foundBare?.journal).equal(null);
    should(foundStamped?.journal).eql(fingerprinted.journal);
  });
});
