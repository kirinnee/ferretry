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
import type { CredentialMaterial } from '@ferretry/fleet';
import should from 'should';
import {
  CredentialEmailReader,
  codexEmail,
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

/** A Codex `auth.json` whose id token carries these claims. The signature is never checked. */
const codexAuth = (claims: Record<string, unknown>): string =>
  JSON.stringify({
    tokens: {
      id_token: `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.c2ln`,
      access_token: 'access-TESTONLY',
      refresh_token: 'refresh-TESTONLY',
    },
  });

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

describe('codexEmail', () => {
  it('should keep the id token email claim and nothing else', () => {
    // Act / Assert
    should(codexEmail({ outcome: 'found', blob: codexAuth({ email: ' person@example.com ' }) })).equal(
      'person@example.com',
    );
  });

  it.each<[string, CredentialMaterial]>([
    ['absent material', { outcome: 'absent' }],
    ['unreadable material', { outcome: 'unreadable', reason: 'locked' }],
    ['a blob that is not JSON', { outcome: 'found', blob: 'not json' }],
    ['a login with no id token', { outcome: 'found', blob: JSON.stringify({ OPENAI_API_KEY: 'sk-TESTONLY' }) }],
    ['an id token with no payload', { outcome: 'found', blob: JSON.stringify({ tokens: { id_token: 'header' } }) }],
    ['an id token with no email', { outcome: 'found', blob: codexAuth({ sub: 'someone' }) }],
  ])('should show no email for %s', (_case, material) => {
    // Act / Assert
    should(codexEmail(material)).be.undefined();
  });
});

describe('CredentialEmailReader', () => {
  it('should read the account Claude recorded in a config directory', async () => {
    // Arrange
    const accountFile = join(await scratch(), '.claude.json');
    await writeFile(accountFile, JSON.stringify({ oauthAccount: { emailAddress: 'person@example.com' } }));
    const reader = new CredentialEmailReader({ storedMaterial: async () => ({ outcome: 'absent' }) });

    // Act / Assert
    should(await reader.email({ harness: 'claude', accountFile })).equal('person@example.com');
  });

  it('should show no Claude email when the account file is missing or damaged', async () => {
    // Arrange
    const root = await scratch();
    const damaged = join(root, '.claude.json');
    await writeFile(damaged, '{');
    const reader = new CredentialEmailReader({ storedMaterial: async () => ({ outcome: 'absent' }) });

    // Act / Assert
    should(await reader.email({ harness: 'claude', accountFile: join(root, 'missing.json') })).be.undefined();
    should(await reader.email({ harness: 'claude', accountFile: damaged })).be.undefined();
  });

  it('should read a Codex email from the store it names', async () => {
    // Arrange
    const asked: string[] = [];
    const reader = new CredentialEmailReader({
      storedMaterial: async resolution => {
        asked.push(resolution.canonicalFile);
        return { outcome: 'found', blob: codexAuth({ email: 'team@example.com' }) };
      },
    });

    // Act
    const actual = await reader.email({ harness: 'codex', resolution: CODEX_RESOLUTION });

    // Assert
    should(actual).equal('team@example.com');
    should(asked).deepEqual(['/fy/credentials/team/auth.json']);
  });

  it('should show no Codex email when the store cannot be read', async () => {
    // Arrange
    const reader = new CredentialEmailReader({
      storedMaterial: async () => {
        throw new Error('the keychain is locked');
      },
    });

    // Act / Assert
    should(await reader.email({ harness: 'codex', resolution: CODEX_RESOLUTION })).be.undefined();
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
