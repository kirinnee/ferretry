import { describe, expect, test } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import {
  allowedDestination,
  defineSealedDocument,
  InputRaiseSchema,
  InputTargetFactsSchema,
  isVaultKeyText,
  malformedSecretReference,
  type SecretName,
  SecretUseRequestSchema,
  secretReferencesIn,
  strongestSensitivity,
  VaultDocumentSchema,
} from '../../contract/index.ts';
import {
  FakeInputHolds,
  FakeOutputGuard,
  FakeRedaction,
  FakeSealedDocuments,
  FakeVault,
  fakeChildEnvironmentValues,
  goneTargetAdapter,
  inputHoldsConformance,
  inputTargetConformance,
  outputGuardConformance,
  redactionConformance,
  sealedDocumentsConformance,
  vaultConformance,
} from '../../contract/testing/index.ts';

inputHoldsConformance('FakeInputHolds', () => new FakeInputHolds());
outputGuardConformance('FakeOutputGuard', () => new FakeOutputGuard());
redactionConformance('FakeRedaction', () => {
  const name = 'API_KEY' as SecretName;
  const value = 'sk-live-abcdef0123456789';
  return { redaction: new FakeRedaction(new Map([[name, value]])), name, value };
});
vaultConformance('FakeVault', () => ({
  vault: new FakeVault((_, env) => ({ stdout: env.API_KEY ?? '', stderr: '' })),
}));
sealedDocumentsConformance('FakeSealedDocuments', () => ({
  port: new FakeSealedDocuments(),
  mine: {} as StatePort,
  theirs: {} as StatePort,
  document: defineSealedDocument({ name: 'oauth-secrets', path: 'oauth-secrets.json' }),
}));
inputTargetConformance('goneTargetAdapter (terminal)', () => ({
  adapter: goneTargetAdapter,
  unknownKey: 'nope',
  kind: 'terminal',
}));
inputTargetConformance('goneTargetAdapter (page)', () => ({
  adapter: goneTargetAdapter,
  unknownKey: 'nope',
  kind: 'page',
}));

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

describe('the sealed store moves byte for byte (spine D16)', () => {
  test('an entry sealed exactly as today (AES-256-GCM, name as AAD) parses and opens unchanged', async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const keyText = `${b64(keyBytes)}\n`;
    expect(isVaultKeyText(keyText)).toBe(true);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = new TextEncoder().encode('API_KEY');
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad },
        key,
        new TextEncoder().encode('v4-value'),
      ),
    );
    // Today's document, with only its envelope key renamed (`v` → `format`); the entry moves byte for byte.
    const today = {
      v: 1,
      cipher: 'AES-256-GCM',
      entries: {
        API_KEY: {
          iv: b64(iv),
          ciphertext: b64(sealed),
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    };
    const { v: _v, ...rest } = today;
    const parsed = VaultDocumentSchema.parse({ format: 1, ...rest });
    const entry = parsed.entries.API_KEY;
    expect(entry).toEqual(today.entries.API_KEY);
    const opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Buffer.from(entry?.iv ?? '', 'base64'), additionalData: aad },
      key,
      Buffer.from(entry?.ciphertext ?? '', 'base64'),
    );
    expect(new TextDecoder().decode(opened)).toBe('v4-value');
  });
  test('a document in today’s spelling is not read (one format)', () => {
    expect(VaultDocumentSchema.safeParse({ v: 1, cipher: 'AES-256-GCM', entries: {} }).success).toBe(false);
  });
  test('a key file that is not 32 bytes is refused, never re-minted', () => {
    expect(isVaultKeyText(`${b64(new Uint8Array(16))}\n`)).toBe(false);
    expect(isVaultKeyText('not base64!')).toBe(false);
  });
});

describe('secrets', () => {
  test('the reference grammar is today’s', () => {
    expect(secretReferencesIn('Bearer ${secret:API_KEY} ${secret:API_KEY} ${secret:OTHER}')).toEqual([
      'API_KEY',
      'OTHER',
    ]);
    expect(malformedSecretReference('x ${secret:lower}')).toBe('${secret:lower}');
  });
  test('a use request defaults as today', () => {
    expect(SecretUseRequestSchema.parse({ command: ['true'], cwd: '/tmp' })).toMatchObject({
      secrets: [],
      env: {},
      timeoutMs: 60_000,
    });
  });
  test('only https or a loopback http host on the allowlist is a destination', () => {
    expect(allowedDestination('https://api.example.test/x', ['api.example.test'])).toBe(true);
    expect(allowedDestination('http://localhost:4000/x', ['localhost:4000'])).toBe(true);
    expect(allowedDestination('http://api.example.test/x', ['api.example.test'])).toBe(false);
    expect(allowedDestination('https://u:p@api.example.test/x', ['api.example.test'])).toBe(false);
  });
  test('a child environment holds the value only for the runner, never in its JSON', async () => {
    const vault = new FakeVault();
    await vault.put('API_KEY' as SecretName, 'sk-live-abcdef0123456789');
    const env = await vault.childEnvironment('f1' as never, { TOKEN: 'Bearer ${secret:API_KEY}' });
    if (!env.ok) throw new Error('expected an environment');
    expect(fakeChildEnvironmentValues(env.value)).toEqual({ TOKEN: 'Bearer sk-live-abcdef0123456789' });
    expect(JSON.stringify(env.value)).toBe('{"names":["TOKEN"]}');
  });
});

describe('input requests', () => {
  test('a raise names one sensitivity or several fields, not both', () => {
    const target = { kind: 'terminal', key: '%terminal:main' } as const;
    expect(InputRaiseSchema.safeParse({ target, prompt: 'sudo password', sensitivity: 'secret' }).success).toBe(true);
    expect(InputRaiseSchema.safeParse({ target, prompt: 'x' }).success).toBe(false);
    const parsed = InputRaiseSchema.parse({ target, prompt: 'x', sensitivity: 'code' });
    expect(parsed.target.key).toBe('main');
    expect(parsed.submit).toBe('offer-owner');
  });
  test('the most careful sensitivity wins', () => {
    expect(strongestSensitivity([{ sensitivity: 'plain' }, { sensitivity: 'secret' }, { sensitivity: 'code' }])).toBe(
      'secret',
    );
  });
  test('page facts are today’s browser facts under the name page', () => {
    expect(
      InputTargetFactsSchema.safeParse({
        kind: 'page',
        pageId: 'p1',
        origin: 'https://example.test',
        secure: true,
        navigationId: 'n1',
        fields: [
          {
            fieldId: 'password',
            frameOrigin: 'https://example.test',
            frameId: 'f',
            backendNodeId: 3,
            field: { tag: 'input', type: 'password' },
            box: { x: 0, y: 0, w: 1, h: 1 },
            visible: true,
          },
        ],
      }).success,
    ).toBe(true);
  });
});
