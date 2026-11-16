import { afterEach, beforeEach, expect, test } from 'bun:test';
import { SealedDocumentSchema } from '@ferretry/core-vault/contract';
import {
  AccountIndexDocumentSchema,
  LOGIN_SECRETS,
  SignInRulesDocumentSchema,
} from '@ferretry/plugin-accounts/contract';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  accountsStep,
  V5_ACCOUNT_INDEX,
  V5_COPY_RULES,
  V5_LOGIN_SECRETS,
  V5_SIGN_IN_RULES,
  V5CopyRulesBodySchema,
} from '../../src/steps/accounts.ts';
import { STEPS } from '../../src/steps/index.ts';
import { V5_VAULT_KEY_FILE, vaultStep } from '../../src/steps/secrets.ts';
import { AT, fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

type Json = Record<string, unknown>;

// ── FAKE v4 documents (no real account, value or ciphertext) ──────────────────────────────────────────────────────

const KEY = `L${'0123456789AB'.repeat(2)}`;
const OTHER_KEY = `L${'BA9876543210'.repeat(2)}`;
const PASSWORD_SEAL = `${KEY}_PASSWORD_0000000A`;
const TOTP_SEAL = `${KEY}_TOTP_0000000B`;
const SIGN_IN = 'si_0123456789abcdef';
const FACTOR = 'tf_0123456789ab';
const RULE = `sr_${'ab'.repeat(12)}`;
const DEVICE = `fy_device_id_${'A'.repeat(22)}`;
const LATER = '2026-11-08T00:00:00.000Z';

const account = (overrides: Json = {}): Json => ({
  key: KEY,
  label: 'Fake GitHub',
  username: 'fake-user',
  seals: { password: PASSWORD_SEAL },
  factors: [
    {
      id: FACTOR,
      kind: 'totp',
      label: 'Authenticator app',
      seal: TOTP_SEAL,
      params: { algorithm: 'SHA1', digits: 6, period: 30 },
      addedAt: AT,
      addedBy: 'migration',
    },
    { id: 'tf_ba9876543210', kind: 'sms', label: 'Phone', endsWith: '42', addedAt: AT, addedBy: 'owner' },
  ],
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

const v4Index = (extra: Json = {}): Json => ({
  v: 2,
  accounts: {
    WORK_GITHUB: account(),
    FAKE_SUDO: { key: OTHER_KEY, label: 'Fake sudo', seals: {}, createdAt: AT, updatedAt: AT },
  },
  signIns: {
    [SIGN_IN]: {
      account: KEY,
      place: { kind: 'site', domains: ['github.com'], match: [] },
      recipe: 'Type the username, then the password.',
      recipeVersion: 1,
      createdAt: AT,
      updatedAt: AT,
    },
    si_fedcba9876543210: {
      account: OTHER_KEY,
      place: { kind: 'terminal', tool: 'sudo', host: 'fake-box' },
      createdAt: AT,
      updatedAt: AT,
    },
  },
  migrated: { from: 1, at: AT, entries: 1 },
  ...extra,
});

const rule = (): Json => ({
  body: {
    v: 1,
    id: RULE,
    revision: 1,
    signIn: SIGN_IN,
    surface: 'page',
    fields: ['username', 'password'],
    pins: {
      accountKey: KEY,
      account: 'WORK_GITHUB',
      username: 'fake-user',
      placeKeys: ['github.com'],
      recipeVersion: 1,
      identities: ['0123456789abcdef'],
      factors: 'f'.repeat(64),
    },
    scope: { kind: 'session', session: 'fake-ferret' },
    createdAt: AT,
    expiresAt: LATER,
    uses: 5,
    approvedBy: { deviceId: DEVICE },
  },
  proof: {
    deviceId: DEVICE,
    credentialId: 'RkFLRS1DUkVE',
    clientDataJSON: 'RkFLRS1DTElFTlQ',
    authenticatorData: 'RkFLRS1BVVRI',
    signature: 'RkFLRS1TSUc',
    stage: `srs_${'cd'.repeat(12)}`,
    nonce: `${'A'.repeat(42)}A`,
  },
  narrowed: { uses: 3 },
  usage: { count: 1, lastUsedAt: AT, lastSession: 'fake-ferret' },
});

const pasteRule = (): Json => ({
  id: '0123456789abcdef0123456789abcdef',
  from: { kind: 'command', program: 'gh' },
  to: { kind: 'terminal', program: 'vercel' },
  sessionId: 'fake-ferret',
  remaining: 2,
  used: 1,
  createdAt: AT,
  createdBy: { kind: 'host' },
});

const readOut = async (path: string): Promise<Json> => JSON.parse(await readFile(join(f.to, path), 'utf8')) as Json;
/** The kernel's reading of a stamped document: `format` first, checked, then the rest is the body. */
const unstamped = (document: Json): Json => {
  expect(Object.keys(document)[0]).toBe('format');
  const { format, ...body } = document;
  expect(format).toBe(1);
  return body;
};

// ── the index and the rules ───────────────────────────────────────────────────────────────────────────────────

test('the index keeps every id; only the envelope, the upgrade record and the migration origin change', async () => {
  await f.put('state/login-entries.json', v4Index());
  const report = await accountsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept).toEqual([
    { what: 'website accounts', count: 2 },
    { what: 'sign-ins', count: 2 },
    { what: '2FA keys', count: 2 },
  ]);
  expect(report.note).toContain("1 2FA key(s) v4 marked as moved from a saved login are the owner's");

  const written = await readOut(V5_ACCOUNT_INDEX);
  expect(Object.keys(written)[0]).toBe('format');
  const index = AccountIndexDocumentSchema.parse(written);
  const v4 = v4Index();
  const accounts = v4.accounts as Record<string, Json>;
  expect(index).toEqual({
    format: 1,
    accounts: {
      WORK_GITHUB: {
        ...accounts.WORK_GITHUB,
        factors: [
          { ...((accounts.WORK_GITHUB?.factors as Json[])[0] as Json), addedBy: 'owner' },
          (accounts.WORK_GITHUB?.factors as Json[])[1],
        ],
      },
      FAKE_SUDO: accounts.FAKE_SUDO,
    },
    signIns: v4.signIns,
  } as never);
  expect('migrated' in written).toBe(false);
  expect((await stat(join(f.to, V5_ACCOUNT_INDEX))).mode & 0o777).toBe(0o600);
});

test('standing sign-in rules and paste rules are carried as the same values, format stamped first', async () => {
  await f.put('state/accounts/sign-in-rules.json', { v: 1, rules: [rule()] });
  await f.put('state/secure-copy/rules.json', { v: 1, rules: [pasteRule()] });
  const report = await accountsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept).toEqual([
    { what: 'standing sign-in rules', count: 1 },
    { what: 'paste (secure copy) rules', count: 1 },
  ]);

  // The signed body, its proof and the narrowing overlay are the same JSON values: the owner's passkey still holds.
  const rules = unstamped(await readOut(V5_SIGN_IN_RULES));
  expect(SignInRulesDocumentSchema.parse(rules)).toEqual({ v: 1, rules: [rule()] } as never);
  expect(rules).toEqual({ v: 1, rules: [rule()] });
  // An absent `settings` is what v4 read it as: profile targets off.
  const copy = unstamped(await readOut(V5_COPY_RULES));
  expect(V5CopyRulesBodySchema.parse(copy)).toEqual({
    v: 1,
    rules: [pasteRule()],
    settings: { allowProfileTargets: false },
  } as never);
  for (const path of [V5_SIGN_IN_RULES, V5_COPY_RULES]) expect((await stat(join(f.to, path))).mode & 0o777).toBe(0o600);
});

test('paste settings the owner turned on stay on', async () => {
  await f.put('state/secure-copy/rules.json', { v: 1, rules: [], settings: { allowProfileTargets: true } });
  expect((await accountsStep.run(f.ctx())).status).toBe('converted');
  expect(unstamped(await readOut(V5_COPY_RULES))).toEqual({
    v: 1,
    rules: [],
    settings: { allowProfileTargets: true },
  });
});

test('a home with no accounts converts with nothing written', async () => {
  const report = await accountsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept).toEqual([]);
  expect(report.note).toBe('this home has no website accounts or rules');
  expect(await stat(join(f.to, 'state/accounts')).catch(() => undefined)).toBeUndefined();
});

test('a version 1 index (saved logins) fails by name: v4 upgrades it only when its daemon starts', async () => {
  await f.put('state/login-entries.json', { v: 1, entries: {} });
  const report = await accountsStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toContain('state/login-entries.json: is still a version 1 index');
});

test('a document v5 refuses fails naming the file and the field path, never a value', async () => {
  const broken = v4Index();
  (broken.accounts as Record<string, Json>).WORK_GITHUB = account({ label: '' });
  await f.put('state/login-entries.json', broken);
  const report = await accountsStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toBe('state/login-entries.json: does not fit the v5 account index at accounts.WORK_GITHUB.label');

  await f.put('state/login-entries.json', v4Index());
  await f.put('state/accounts/sign-in-rules.json', { v: 1, rules: [{ ...rule(), usage: { count: -1 } }] });
  const rules = await accountsStep.run(f.ctx());
  expect(rules.status).toBe('failed');
  expect(rules.note).toContain('state/accounts/sign-in-rules.json: does not fit v5');
  expect(rules.note).not.toContain('fake-user');
});

// ── the sealed values: moved with the vault key, still opened by it ──────────────────────────────────────────────

/** v4's sealing (`WebCryptoSecretCipher`): AES-256-GCM, a 96-bit IV, the entry name as the AAD. FAKE values only. */
async function seal(key: CryptoKey, name: string, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(name) },
      key,
      new TextEncoder().encode(value),
    ),
  );
  return {
    iv: Buffer.from(iv).toString('base64'),
    ciphertext: Buffer.from(ciphertext).toString('base64'),
    createdAt: AT,
    updatedAt: AT,
  };
}
/** v5's opening (`KernelSealedDocuments`): the same, with `LOGIN_SECRETS.additionalData` before the name. */
async function open(key: CryptoKey, name: string, entry: { iv: string; ciphertext: string }) {
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: Buffer.from(entry.iv, 'base64'),
      additionalData: new TextEncoder().encode(`${LOGIN_SECRETS.additionalData}${name}`),
    },
    key,
    Buffer.from(entry.ciphertext, 'base64'),
  );
  return new TextDecoder().decode(plain);
}
const importKey = async (base64: string) =>
  await crypto.subtle.importKey('raw', Buffer.from(base64.trim(), 'base64'), 'AES-GCM', false, ['encrypt', 'decrypt']);

test('passwords and 2FA seeds move with the vault key: the moved key opens every moved entry', async () => {
  const keyText = `${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}\n`;
  const v4Key = await importKey(keyText);
  await mkdir(join(f.from, 'state'), { recursive: true, mode: 0o700 });
  await writeFile(join(f.from, 'state/secrets.key'), keyText, { mode: 0o600 });
  const ORPHAN = `${OTHER_KEY}_PASSWORD_0000000C`;
  await writeFile(
    join(f.from, 'state/login-secrets.json'),
    JSON.stringify({
      v: 1,
      cipher: 'AES-256-GCM',
      entries: {
        [PASSWORD_SEAL]: await seal(v4Key, PASSWORD_SEAL, 'FAKE-PASSWORD-VALUE'),
        [TOTP_SEAL]: await seal(v4Key, TOTP_SEAL, 'FAKESEEDVALUE'),
        // No account points at it: v4 swept such a value at every start; v5's start sweeps it the same way.
        [ORPHAN]: await seal(v4Key, ORPHAN, 'FAKE-ORPHAN-VALUE'),
      },
    }),
    { mode: 0o600 },
  );
  await f.put('state/login-entries.json', v4Index());
  const before = await readFile(join(f.from, 'state/login-secrets.json'));

  // The step table's order: the vault step moves the key once, then Accounts moves its sealed document.
  const names = STEPS.map(step => step.id);
  expect(names.indexOf('vault')).toBeLessThan(names.indexOf('accounts'));
  expect((await vaultStep.run(f.ctx())).status).toBe('converted');
  const report = await accountsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept).toContainEqual({ what: 'sealed account values (passwords and 2FA seeds)', count: 3 });
  expect(report.note).toContain("1 sealed value(s) no account points at: carried, and v5's first start sweeps them");

  const v5Key = await importKey(await readFile(join(f.to, V5_VAULT_KEY_FILE), 'utf8'));
  const raw = await readOut(V5_LOGIN_SECRETS);
  expect(Object.keys(raw)[0]).toBe('format');
  const moved = SealedDocumentSchema.parse(raw);
  expect(moved.format).toBe(1);
  expect(await open(v5Key, PASSWORD_SEAL, moved.entries[PASSWORD_SEAL]!)).toBe('FAKE-PASSWORD-VALUE');
  expect(await open(v5Key, TOTP_SEAL, moved.entries[TOTP_SEAL]!)).toBe('FAKESEEDVALUE');
  // Every entry is the same strings: nothing was re-encrypted.
  const v4Entries = (JSON.parse(before.toString('utf8')) as { entries: Json }).entries;
  expect(moved.entries).toEqual(v4Entries as never);
  expect(V5_LOGIN_SECRETS).toBe('state/accounts/login-secrets.json');
  expect((await stat(join(f.to, V5_LOGIN_SECRETS))).mode & 0o777).toBe(0o600);
  expect(report.sealed).toEqual([{ file: V5_LOGIN_SECRETS, bytes: (await stat(join(f.to, V5_LOGIN_SECRETS))).size }]);
  // The v4 backup is untouched, and no value or ciphertext reaches the report.
  expect((await readFile(join(f.from, 'state/login-secrets.json'))).equals(before)).toBe(true);
  const shown = JSON.stringify(report);
  for (const value of ['FAKE-PASSWORD-VALUE', 'FAKESEEDVALUE', moved.entries[PASSWORD_SEAL]!.ciphertext])
    expect(shown).not.toContain(value);
});

test('an index naming sealed values that are not there is carried as it is, and the report says how many', async () => {
  await f.put('state/login-entries.json', v4Index());
  const report = await accountsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.note).toContain('the index names 2 sealed value(s) that are not there');
});

test('sealed values with no vault key to open them fail, naming the files only', async () => {
  await mkdir(join(f.from, 'state'), { recursive: true, mode: 0o700 });
  await writeFile(
    join(f.from, 'state/login-secrets.json'),
    '{"v":1,"cipher":"AES-256-GCM","entries":{"FAKE":{"iv":"FAKE-IV","ciphertext":"FAKE-SEALED","createdAt":"x","updatedAt":"x"}}}\n',
    { mode: 0o600 },
  );
  const report = await accountsStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toBe(
    'state/login-secrets.json exists but the vault key state/secrets.key that seals it does not',
  );
  expect(JSON.stringify(report)).not.toContain('FAKE-SEALED');
  expect(await stat(join(f.to, V5_LOGIN_SECRETS)).catch(() => undefined)).toBeUndefined();
});

test('a dry run writes nothing and names the sealed file by its size', async () => {
  await mkdir(join(f.from, 'state'), { recursive: true, mode: 0o700 });
  await writeFile(join(f.from, 'state/secrets.key'), 'FAKE-KEY\n', { mode: 0o600 });
  const sealed = '{"v":1,"cipher":"AES-256-GCM","entries":{}}\n';
  await writeFile(join(f.from, 'state/login-secrets.json'), sealed, { mode: 0o600 });
  await f.put('state/login-entries.json', v4Index());
  const report = await accountsStep.run(f.ctx(true));
  expect(report.status).toBe('converted');
  expect(report.sealed).toEqual([{ file: V5_LOGIN_SECRETS, bytes: sealed.length }]);
  expect(await stat(join(f.to, 'state')).catch(() => undefined)).toBeUndefined();
});

test('the step replaces the pending entry in its slot, after the vault and identity steps', () => {
  const names = STEPS.map(step => step.id);
  expect(names.filter(name => name === 'accounts')).toHaveLength(1);
  expect(STEPS.find(step => step.id === 'accounts')).toBe(accountsStep);
  expect(names.indexOf('identity')).toBeLessThan(names.indexOf('accounts'));
  expect(names.indexOf('accounts')).toBeLessThan(names.indexOf('access'));
});
