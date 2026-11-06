/**
 * THE ACCOUNT, SIGN-IN, 2FA AND PASSKEY STORES, as a machine that is signed in actually has them (docs/secrets.md,
 * "Accounts and sign-ins"), seeded with FAKE data and read back through the daemon's own readers.
 *
 * A re-copy must never touch these (design §14.4), so a copy test seeds them, snapshots their bytes, copies, and
 * compares. A stand-in file the daemon never reads would prove nothing, so nothing here is invented:
 *
 * - `state/login-entries.json`: the account index (`FileLoginIndexStore`), one account with a password seal and
 *   three 2FA keys of the real kinds (an automatic TOTP key that holds a sealed seed, an SMS number and a security
 *   key), and the sign-in that account has at one site.
 * - `state/login-secrets.json`: the sealed document the index points into, holding the password and the TOTP seed
 *   under exactly the names `sealedNamesOf` lists. A fake cipher stands in for the real one: the bytes are fake,
 *   the shape is the daemon's.
 * - `state/passkeys.json`: one registered passkey (`StatePasskeyStore`), public key and counter only.
 *
 * Every value is invented; no real account, seed, key or device is read or written.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type AccountIndexDocument,
  AccountIndexDocumentSchema,
  type AccountRecord,
  type SignInRecord,
  sealedNamesOf,
} from '@ferretry/protocol';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import {
  FileLoginIndexStore,
  LOGIN_INDEX_DOCUMENT,
  LOGIN_SECRETS_DOCUMENT,
} from '../../../src/adapters/secrets/file-login-index-store.ts';
import { parseVaultDocument } from '../../../src/adapters/secrets/file-secret-document-store.ts';
import { StatePasskeyStore } from '../../../src/adapters/step-up/state-passkey-store.ts';
import type { FoundationPaths } from '../../../src/lib/index.ts';

/** The passkey document's file name under the state home. */
const PASSKEYS_DOCUMENT = 'passkeys.json';

/** Every file the account, sign-in, factor and passkey stores rest in, under the state home. */
const ACCOUNT_STORE_FILES = [LOGIN_INDEX_DOCUMENT, LOGIN_SECRETS_DOCUMENT, PASSKEYS_DOCUMENT] as const;

const ACCOUNT_KEY = 'L0123456789ABCDEF01234567';
const PASSWORD_SEAL = `${ACCOUNT_KEY}_PASSWORD_AABBCCDD`;
const TOTP_SEAL = `${ACCOUNT_KEY}_TOTP_11223344`;
const SIGN_IN = 'si_0123456789abcdef';
const WHEN = '2026-09-01T09:00:00.000Z';

/** What the seeded stores hold, so a test can say which factor it is claiming to have preserved. */
const SEEDED_ACCOUNT = {
  handle: 'KIRIN_ACCOUNT',
  key: ACCOUNT_KEY,
  signIn: SIGN_IN,
  seals: [PASSWORD_SEAL, TOTP_SEAL],
  factorKinds: ['totp', 'sms', 'security-key'],
  credentialId: 'fakeCredentialId0123456789',
  deviceId: 'fy_device_id_0123456789abcdefghijkl',
} as const;

const account: AccountRecord = {
  key: ACCOUNT_KEY,
  label: 'Kirin (example)',
  username: 'kirin@example.test',
  seals: { password: PASSWORD_SEAL },
  factors: [
    {
      id: 'tf_0123456789ab',
      kind: 'totp',
      label: 'Authenticator',
      addedAt: WHEN,
      addedBy: 'owner',
      params: { algorithm: 'SHA1', digits: 6, period: 30 },
      seal: TOTP_SEAL,
    },
    { id: 'tf_ba9876543210', kind: 'sms', label: 'Phone', addedAt: WHEN, addedBy: 'owner', endsWith: '42' },
    { id: 'tf_00ff00ff00ff', kind: 'security-key', label: 'Desk key', addedAt: WHEN, addedBy: 'owner' },
  ],
  createdAt: WHEN,
  updatedAt: WHEN,
};

const signIn: SignInRecord = {
  account: ACCOUNT_KEY,
  place: { kind: 'site', domains: ['accounts.example.test'], match: [] },
  createdAt: WHEN,
  updatedAt: WHEN,
};

const index = (): AccountIndexDocument =>
  AccountIndexDocumentSchema.parse({
    v: 2,
    accounts: { [SEEDED_ACCOUNT.handle]: account },
    signIns: { [SIGN_IN]: signIn },
  });

/** The sealed document, in the vault's shape: the seed and password sealed under the names the index lists. */
const sealed = () => ({
  v: 1,
  cipher: 'FAKE-REVERSED',
  entries: Object.fromEntries(
    sealedNamesOf(account).map(name => [
      name,
      { iv: name, ciphertext: `fake-sealed-${name.toLowerCase()}`, createdAt: WHEN, updatedAt: WHEN },
    ]),
  ),
});

/** Writes the three stores, then reads each back through the daemon's own reader, so a bad fixture fails here. */
export async function seedAccountStores(paths: FoundationPaths): Promise<void> {
  const files = new StateFileSystem(paths);
  const login = new FileLoginIndexStore(paths, files);
  await login.write(index());
  const sealedPath = path.join(paths.state, LOGIN_SECRETS_DOCUMENT);
  await files.writeTextAtomic(sealedPath, `${JSON.stringify(sealed(), undefined, 2)}\n`);
  await files.setMode(sealedPath, 0o600);
  await new StatePasskeyStore(paths, files).add({
    credentialId: SEEDED_ACCOUNT.credentialId,
    deviceId: SEEDED_ACCOUNT.deviceId,
    algorithm: -7,
    publicKeySpki: 'ZmFrZS1zcGtpLW5vdC1hLXJlYWwta2V5',
    signCount: 7,
    origin: 'https://pwa.example.test',
    createdAt: WHEN,
  });
  await assertSeeded(paths);
}

/**
 * The seeded state as the daemon reads it: the account with its three factor kinds and the sign-in, every seal the
 * index names present in the sealed document (and nothing else there), and the passkey on its device.
 */
async function assertSeeded(paths: FoundationPaths): Promise<void> {
  const files = new StateFileSystem(paths);
  const stored = await new FileLoginIndexStore(paths, files).read();
  if (stored?.v !== 2) throw new Error('the account index is not a version 2 index');
  const held = stored.document.accounts[SEEDED_ACCOUNT.handle];
  if (held === undefined) throw new Error('the seeded account is missing');
  const kinds = (held.factors ?? []).map(factor => factor.kind);
  if (kinds.join() !== SEEDED_ACCOUNT.factorKinds.join()) throw new Error(`unexpected factors ${kinds.join()}`);
  if (stored.document.signIns[SIGN_IN]?.account !== ACCOUNT_KEY) throw new Error('the seeded sign-in is missing');
  const document = parseVaultDocument((await files.readText(path.join(paths.state, LOGIN_SECRETS_DOCUMENT))) ?? '');
  const sealedNames = Object.keys(document.entries).toSorted();
  if (sealedNames.join() !== [...sealedNamesOf(held)].toSorted().join())
    throw new Error('the sealed document does not hold exactly the seals the index names');
  const passkeys = await new StatePasskeyStore(paths, files).list(SEEDED_ACCOUNT.deviceId);
  if (passkeys.length !== 1) throw new Error('the seeded passkey is missing');
}

/** Every byte of the three stores, as hex, keyed by file name; a missing file is its own distinct answer. */
export async function accountStoreBytes(paths: FoundationPaths): Promise<Record<string, string>> {
  const bytes: Record<string, string> = {};
  for (const name of ACCOUNT_STORE_FILES) {
    bytes[`state/${name}`] = await readFile(path.join(paths.state, name)).then(
      buffer => buffer.toString('hex'),
      () => 'missing',
    );
  }
  return bytes;
}
