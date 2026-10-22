/**
 * The credentials surface's host reads, against a real temporary filesystem and real children.
 *
 * Every file here is one the harness or Ferretry writes — a `.claude.json`, a Codex
 * `auth.json`, a rollout — so what is proved is that each reader finds the one display fact it keeps
 * and nothing else, and that a missing or damaged file is "nothing to show" rather than a failure.
 * Every path is under a temporary directory; no real harness home is read.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialFileStamp } from '@ferretry/fleet/adapters';
import should from 'should';
import {
  CredentialEmailReader,
  type CredentialEmailReaderDeps,
  ensurePrivateDirectory,
  rolloutFiles,
  runCredentialHarness,
} from '../../../src/adapters/fleet-credentials/credential-facts.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-credential-facts-'));
  temporaryDirectories.push(root);
  return root;
}

const CODEX_RESOLUTION = {
  harness: 'codex',
  store: 'ferretry',
  canonicalFile: '/fy/credentials/team/auth.json',
} as const;

describe('ensurePrivateDirectory', () => {
  it('should create the directory and its parents readable by this user only', async () => {
    // Arrange
    const path = join(await scratch(), 'credentials', 'work', 'sign-in');

    // Act
    await ensurePrivateDirectory(path);

    // Assert
    should((await stat(path)).mode & 0o777).equal(0o700);
  });
});

describe('CredentialEmailReader', () => {
  const readerOf = (deps: Partial<CredentialEmailReaderDeps> = {}): CredentialEmailReader =>
    new CredentialEmailReader({
      codexFacts: async () => ({ shape: { kind: 'decided', reading: { state: 'missing' } } }),
      stamp: credentialFileStamp,
      kept: new Map(),
      ...deps,
    });

  it('should read the account Claude recorded in a config directory', async () => {
    // Arrange
    const accountFile = join(await scratch(), '.claude.json');
    await writeFile(accountFile, JSON.stringify({ oauthAccount: { emailAddress: 'person@example.com' } }));

    // Act / Assert
    should(await readerOf().email({ harness: 'claude', accountFile })).equal('person@example.com');
  });

  it('should show no Claude email when the account file is missing or damaged', async () => {
    // Arrange
    const root = await scratch();
    const damaged = join(root, '.claude.json');
    await writeFile(damaged, '{');
    const reader = readerOf();

    // Act / Assert
    should(await reader.email({ harness: 'claude', accountFile: join(root, 'missing.json') })).be.undefined();
    should(await reader.email({ harness: 'claude', accountFile: damaged })).be.undefined();
  });

  it('should parse a Claude account file again only once its stamp moved', async () => {
    // Arrange — a stamp that never moves, then the real one.
    const accountFile = join(await scratch(), '.claude.json');
    await writeFile(accountFile, JSON.stringify({ oauthAccount: { emailAddress: 'first@example.com' } }));
    const kept = new Map();
    const frozen = readerOf({ stamp: async () => 'unchanged', kept });
    await frozen.email({ harness: 'claude', accountFile });
    await writeFile(accountFile, JSON.stringify({ oauthAccount: { emailAddress: 'second@example.com' } }));

    // Act
    const unchanged = await frozen.email({ harness: 'claude', accountFile });
    const moved = await readerOf({ kept }).email({ harness: 'claude', accountFile });

    // Assert
    should(unchanged).equal('first@example.com');
    should(moved).equal('second@example.com');
  });

  it('should keep nothing for a Claude account file it could not stamp', async () => {
    // Arrange
    const accountFile = join(await scratch(), '.claude.json');
    await writeFile(accountFile, JSON.stringify({ oauthAccount: { emailAddress: 'person@example.com' } }));
    const kept = new Map();

    // Act
    const actual = await readerOf({ stamp: async () => undefined, kept }).email({ harness: 'claude', accountFile });

    // Assert
    should(actual).equal('person@example.com');
    should(kept.size).equal(0);
  });

  it('should read a Codex email from the store facts it names, with no read of its own', async () => {
    // Arrange
    const asked: string[] = [];
    const reader = readerOf({
      codexFacts: async resolution => {
        asked.push(resolution.canonicalFile);
        return {
          shape: { kind: 'tokens', hasAccess: true, hasRefresh: true },
          codex: { state: 'tokens', hasAccess: true, hasRefresh: true, email: 'team@example.com' },
        };
      },
    });

    // Act
    const actual = await reader.email({ harness: 'codex', resolution: CODEX_RESOLUTION });

    // Assert
    should(actual).equal('team@example.com');
    should(asked).deepEqual(['/fy/credentials/team/auth.json']);
  });

  it('should show no Codex email when the store cannot be read or holds no login', async () => {
    // Arrange
    const failing = readerOf({
      codexFacts: async () => {
        throw new Error('the keychain is locked');
      },
    });

    // Act / Assert
    should(await failing.email({ harness: 'codex', resolution: CODEX_RESOLUTION })).be.undefined();
    should(await readerOf().email({ harness: 'codex', resolution: CODEX_RESOLUTION })).be.undefined();
  });
});

describe('rolloutFiles', () => {
  it('should list each rollout once with its modification time, skipping anything else', async () => {
    // Arrange
    const root = await scratch();
    const plain = join(root, 'rollout-a.jsonl');
    const packed = join(root, 'rollout-b.jsonl.zst');
    const notes = join(root, 'notes.txt');
    const folder = join(root, 'folder.jsonl');
    await writeFile(plain, '{}\n');
    await writeFile(packed, 'x');
    await writeFile(notes, 'x');
    await mkdir(folder);
    await utimes(plain, 1_700_000_000, 1_700_000_000);

    // Act
    const actual = await rolloutFiles([plain, plain, packed, notes, folder, join(root, 'gone.jsonl')]);

    // Assert
    should(actual.map(file => file.path)).deepEqual([plain, packed]);
    should(actual[0]?.modifiedAt).equal(1_700_000_000_000);
  });
});

describe('runCredentialHarness', () => {
  it('should answer the child exit code', async () => {
    // Act / Assert
    should(
      await runCredentialHarness({ command: ['sh', '-c', 'exit 3'], environment: { PATH: process.env.PATH } }),
    ).equal(3);
  });

  it('should kill a child that outlives its time and answer -1', async () => {
    // Act
    const actual = await runCredentialHarness({ command: ['sleep', '5'], environment: { PATH: process.env.PATH } }, 50);

    // Assert
    should(actual).equal(-1);
  });
});
