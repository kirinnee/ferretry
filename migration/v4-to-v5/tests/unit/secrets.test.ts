import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { VaultDocumentSchema } from '@ferretry/core-vault/contract';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rewrapSealed } from '../../src/rewrap.ts';
import {
  identityStep,
  V5_IDENTITY_FILE,
  V5_VAULT_FILE,
  V5_VAULT_KEY_FILE,
  vaultStep,
} from '../../src/steps/secrets.ts';
import { v4Paths } from '../../src/v4/layout.ts';
import { v5Writer } from '../../src/v5/write.ts';

// Fixed FAKE values (not real secrets): base64 shapes only, so a test can prove they are copied unchanged and never
// reach a report or an error.
const FAKE_KEY = 'ZmFrZS1rZXktZmFrZS1rZXktZmFrZS1rZXktZmFrZS0=\n';
const FAKE_IV = 'AAAAAAAAAAAAAAAA';
const FAKE_CIPHERTEXT = 'Q0lQSEVSVEVYVC1QTEFOVEVELTNmOWE=';
const FAKE_IDENTITY =
  '{"schemaVersion":1,"privateKeyPem":"-----BEGIN PRIVATE KEY-----\\nFAKE\\n-----END PRIVATE KEY-----\\n"}\n';

let root: string;
let v4: string;
let v5: string;

function v4Vault(entries: Record<string, unknown>): string {
  return `${JSON.stringify({ v: 1, cipher: 'AES-256-GCM', entries }, null, 2)}\n`;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fy-v4-secrets-'));
  v4 = join(root, 'v4');
  v5 = join(root, 'v5');
  await mkdir(join(v4, 'state'), { recursive: true });
  await mkdir(v5, { mode: 0o700 });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ctx = (dryRun = false) => ({ v4: v4Paths(v4), v5: v5Writer(v5, { dryRun }), dryRun });
const entry = {
  iv: FAKE_IV,
  ciphertext: FAKE_CIPHERTEXT,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
};

describe('vault step', () => {
  test('moves the key byte for byte and re-labels only the envelope', async () => {
    await writeFile(join(v4, 'state', 'secrets.key'), FAKE_KEY, { mode: 0o600 });
    await writeFile(join(v4, 'state', 'secrets.json'), v4Vault({ GITHUB_TOKEN: entry, NPM_TOKEN: entry }), {
      mode: 0o600,
    });
    const report = await vaultStep.run(ctx());

    expect(report.status).toBe('converted');
    expect(report.kept).toEqual([{ what: 'sealed secrets', count: 2 }]);
    expect(await readFile(join(v5, V5_VAULT_KEY_FILE), 'utf8')).toBe(FAKE_KEY);
    const document = VaultDocumentSchema.parse(JSON.parse(await readFile(join(v5, V5_VAULT_FILE), 'utf8')));
    expect(document.entries.GITHUB_TOKEN).toEqual(entry);
    expect((await stat(join(v5, V5_VAULT_FILE))).mode & 0o777).toBe(0o600);
    expect((await stat(join(v5, V5_VAULT_KEY_FILE))).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(report)).not.toContain(FAKE_CIPHERTEXT);
    expect(JSON.stringify(report)).not.toContain(FAKE_KEY.trim());
  });

  test('a vault without its key fails and writes nothing', async () => {
    await writeFile(join(v4, 'state', 'secrets.json'), v4Vault({ A: entry }));
    const report = await vaultStep.run(ctx());
    expect(report.status).toBe('failed');
    expect(await stat(join(v5, 'state')).catch(() => undefined)).toBeUndefined();
  });

  test('a dry run reports sizes and writes nothing', async () => {
    await writeFile(join(v4, 'state', 'secrets.key'), FAKE_KEY);
    const report = await vaultStep.run(ctx(true));
    expect(report.sealed).toEqual([{ file: V5_VAULT_KEY_FILE, bytes: FAKE_KEY.length }]);
    expect(await stat(join(v5, 'state')).catch(() => undefined)).toBeUndefined();
  });
});

describe('envelope re-label', () => {
  test('refuses a shape that is not today’s, naming no value', async () => {
    const odd = join(v4, 'odd.json');
    await writeFile(odd, v4Vault({ A: { ...entry, extra: FAKE_CIPHERTEXT } }));
    const failure = await rewrapSealed(odd, join(v5, 'x.json'), { stamped: true, schema: VaultDocumentSchema }).catch(
      (error: Error) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(FAKE_CIPHERTEXT);
  });

  test('refuses a name the v5 vault does not accept, naming only the path', async () => {
    const lower = join(v4, 'lower.json');
    await writeFile(lower, v4Vault({ lower_name: entry }));
    const failure = (await rewrapSealed(lower, join(v5, 'y.json'), {
      stamped: true,
      schema: VaultDocumentSchema,
    }).catch((error: Error) => error)) as Error;
    expect(failure.message).toContain('entries');
    expect(failure.message).not.toContain(FAKE_IV);
  });
});

describe('identity step', () => {
  test('moves the identity byte for byte to the kernel’s file', async () => {
    await writeFile(join(v4, 'state', 'daemon-identity.json'), FAKE_IDENTITY, { mode: 0o600 });
    const report = await identityStep.run(ctx());
    expect(report.status).toBe('converted');
    expect(await readFile(join(v5, V5_IDENTITY_FILE), 'utf8')).toBe(FAKE_IDENTITY);
    expect(JSON.stringify(report)).not.toContain('PRIVATE KEY');
  });
});
