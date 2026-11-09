/**
 * Plain keys in a v4 login file: a key v4 saved in clear text in `logins/<id>.yaml` `env` (Paste variables could) is
 * moved into the v5 vault, and the v5 login file names it as `${secret:LOGIN_<ID>_<VAR>}`.
 *
 * v5 refuses a raw secret in a file (docs/config-files.md), so without this step such a login would fail the Settings
 * step or, worse, be kept in clear. There are two halves, in two steps, because the vault is moved by its own step:
 *
 * 1. {@link takeLoginKeys} (Settings, per login file): finds each env value the ONE shared rule calls a key, rewrites it
 *    in the yaml document as the reference and parks the value in a {@link LoginKeyHold}. The value lives only in this
 *    process's memory from there on; it is never written, logged, put in an error or the report.
 * 2. {@link loginKeysStep} (after the vault step): seals the parked values into `state/vault/vault.json` under the vault
 *    key and drains the hold. If it cannot, the step FAILS (naming login, variable and path) and the run has no
 *    `home.json`: a key is never left plain.
 *
 * THE RULE is `storedEnvironmentIssue` in `packages/plugins/logins/contract/secret-shape.ts`: the very check a v5 login
 * file's schema applies, so what this moves is exactly what v5 would otherwise refuse. It is exported from the logins
 * contract; there is no second copy of it here.
 *
 * THE SEAL is the vault's documented format (`packages/core/vault/contract/store.ts`): AES-256-GCM under `vault.key`,
 * a random 96-bit IV per entry, the secret's NAME as additional authenticated data, `iv` and `ciphertext` base64. The
 * vault's own writer lives in the daemon half, which this tool may not import; `tests/unit/login-keys.test.ts` proves
 * the two agree by opening this tool's output with the vault's own reader.
 *
 * The key is read once into one Buffer, imported as a non-extractable CryptoKey, and the Buffer is zeroed at once and
 * again in `finally`. Existing vault entries are copied byte for byte and never decrypted.
 */
import {
  MAX_SECRET_NAME_LENGTH,
  MAX_SECRET_VALUE_LENGTH,
  MAX_SECRETS_PER_DAEMON,
  MIN_SECRET_VALUE_LENGTH,
  SECRET_CIPHER_ALGORITHM,
  SECRET_IV_BYTES,
  SecretNameSchema,
  SecretValueSchema,
  secretReference,
  secretReferencesIn,
  VAULT_KEY_BYTES,
  VaultDocumentSchema,
  type VaultDocument,
} from '@ferretry/core-vault/contract';
import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isMap, isScalar, type Document } from 'yaml';
import { storedEnvironmentIssue } from '@ferretry/plugin-logins/contract';
import type { KeptItem, StepReport } from '../report.ts';
import { V4InputError } from '../v4/documents.ts';
import { V5_VAULT_FILE, V5_VAULT_KEY_FILE } from './secrets.ts';
import type { Step, StepContext } from './index.ts';

const KEY_COUNT_LIMIT = MAX_SECRETS_PER_DAEMON;

/** One key waiting to be sealed. The value is held in a closure-free private field and never serialised. */
export interface HeldLoginKey {
  readonly login: string;
  readonly variable: string;
  readonly name: string;
}

/**
 * The values taken out of login files in this run, until the vault step has run and {@link loginKeysStep} seals them.
 * Memory only: it has no serialiser (`toJSON` and `inspect` give names, never values).
 */
export class LoginKeyHold {
  readonly #items: { key: HeldLoginKey; value: string }[] = [];
  readonly #taken = new Set<string>();

  /** Names already in use: the v4 vault's and the ones given out in this run. */
  reserve(names: Iterable<string>): void {
    for (const name of names) this.#taken.add(name);
  }

  /** A free `LOGIN_<ID>_<VAR>`, de-duplicated with `_2`, `_3`; the name is reserved. */
  claim(login: string, variable: string): string {
    const clean = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]+/gu, '_');
    const base = `LOGIN_${clean(login)}_${clean(variable)}`.replace(/_+$/u, '').slice(0, MAX_SECRET_NAME_LENGTH);
    let name = base;
    for (let n = 2; this.#taken.has(name); n++) {
      const suffix = `_${String(n)}`;
      name = `${base.slice(0, MAX_SECRET_NAME_LENGTH - suffix.length)}${suffix}`;
    }
    this.#taken.add(name);
    return name;
  }

  add(key: HeldLoginKey, value: string): void {
    this.#items.push({ key, value });
  }

  get size(): number {
    return this.#items.length;
  }

  /** The names (never values), for a plan and the report. */
  keys(): readonly HeldLoginKey[] {
    return this.#items.map(item => item.key);
  }

  /** The held values for sealing. Only the sealer calls this; it empties the hold. */
  drain(): readonly { key: HeldLoginKey; value: string }[] {
    return this.#items.splice(0);
  }

  clear(): void {
    this.#items.length = 0;
  }

  toJSON(): readonly HeldLoginKey[] {
    return this.keys();
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `LoginKeyHold(${String(this.#items.length)} key(s))`;
  }
}

/** Whether an env value is a key to move: the shared rule says secret, it is long enough for the vault, and it is no reference. */
export function isPlainLoginKey(variable: string, value: string): boolean {
  if (value.length < MIN_SECRET_VALUE_LENGTH || secretReferencesIn(value).length > 0) return false;
  return storedEnvironmentIssue(variable, value) === 'secret';
}

/**
 * The names of the v4 vault's entries (names only: the file is read for its keys and no value is looked at), so a new
 * name never lands on an existing secret. An unreadable file gives none here: the vault step fails on it in this run.
 */
export async function v4VaultNames(path: string): Promise<readonly string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    const entries = (parsed as { entries?: unknown } | null)?.entries;
    return typeof entries === 'object' && entries !== null ? Object.keys(entries) : [];
  } catch {
    return [];
  }
}

/**
 * Takes each plain key out of a login document's `env`: the value becomes `${secret:NAME}` in the document and is parked
 * in the hold. Throws, naming login and variable only, for a key the vault cannot hold (over its size limit).
 */
export function takeLoginKeys(document: Document, login: string, hold: LoginKeyHold): number {
  const env = document.get('env', true);
  if (!isMap(env)) return 0;
  let taken = 0;
  for (const pair of env.items) {
    const variable = isScalar(pair.key) ? pair.key.value : undefined;
    const node = pair.value;
    if (typeof variable !== 'string' || !isScalar(node) || typeof node.value !== 'string') continue;
    if (!isPlainLoginKey(variable, node.value)) continue;
    const value = node.value;
    if (!SecretValueSchema.safeParse(value).success)
      throw new V4InputError(
        `config/logins/${login}.yaml: env.${variable} is a key the vault cannot hold (over ${String(MAX_SECRET_VALUE_LENGTH)} characters)`,
      );
    const name = hold.claim(login, variable);
    hold.add({ login, variable, name }, value);
    node.value = secretReference(SecretNameSchema.parse(name));
    taken++;
  }
  return taken;
}

// ── sealing ─────────────────────────────────────────────────────────────────────────────────────────────────────

const utf8 = (text: string): Uint8Array<ArrayBuffer> => {
  const bytes = new TextEncoder().encode(text);
  const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  owned.set(bytes);
  return owned;
};

export interface SealedValue {
  readonly name: string;
  readonly iv: string;
  readonly ciphertext: string;
}

/**
 * Seals each value under `keyBytes` exactly as the vault does (AES-256-GCM, fresh 96-bit IV, the NAME as AAD). The key
 * Buffer is imported as a non-extractable CryptoKey and zeroed straight away, and zeroed again on any exit.
 */
export async function sealValues(
  keyBytes: Buffer,
  values: readonly { readonly name: string; readonly value: string }[],
): Promise<readonly SealedValue[]> {
  try {
    if (keyBytes.length !== VAULT_KEY_BYTES) throw new Error('the vault key is not 32 bytes');
    // WebCrypto takes a plain-ArrayBuffer view: a copy, zeroed with the Buffer as soon as the key is imported.
    const material = new Uint8Array(new ArrayBuffer(keyBytes.length));
    material.set(keyBytes);
    const key = await crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt']);
    material.fill(0);
    keyBytes.fill(0);
    const sealed: SealedValue[] = [];
    for (const { name, value } of values) {
      const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(SECRET_IV_BYTES)));
      const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(name) }, key, utf8(value));
      sealed.push({
        name,
        iv: Buffer.from(iv).toString('base64'),
        ciphertext: Buffer.from(new Uint8Array(cipher)).toString('base64'),
      });
    }
    return sealed;
  } finally {
    keyBytes.fill(0);
  }
}

/** A new file, written `0600` beside its target and renamed over it; the temporary file is removed on any failure. */
export async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** The vault key's bytes (one Buffer; the caller zeroes it), or `undefined` when the file is absent. */
async function readKeyBytes(path: string): Promise<Buffer | undefined> {
  let file: Buffer;
  try {
    file = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const bytes = Buffer.from(file.toString('latin1').trim(), 'base64');
    if (bytes.length !== VAULT_KEY_BYTES) {
      bytes.fill(0);
      throw new Error('the vault key file does not hold a 32-byte key');
    }
    return bytes;
  } finally {
    file.fill(0);
  }
}

async function readVault(path: string): Promise<VaultDocument | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('the vault document is not JSON');
  }
  const document = VaultDocumentSchema.safeParse(parsed);
  if (!document.success) throw new Error('the vault document does not fit the v5 schema');
  return document.data;
}

// ── the step ────────────────────────────────────────────────────────────────────────────────────────────────────

const NOT_CARRIED = [
  {
    what: 'the plain text of each key v4 saved in a login file',
    why: 'it is sealed in the v5 vault under the name listed, and the v5 login file holds ${secret:NAME}; the v4 file in the backup still holds it, so keep that backup private or delete it',
  },
] as const;

export const loginKeysStep: Step = {
  id: 'login-keys',
  title: 'Login keys (plain keys in v4 login files sealed into the vault)',
  owner: ['plugin-logins', 'core-vault'],
  reads: ['config/logins/*.yaml env (values taken by the Settings step)'],
  sealed: [],
  notCarried: [...NOT_CARRIED],
  async run(ctx: StepContext): Promise<StepReport> {
    const base = { id: this.id, title: this.title, notCarried: this.notCarried };
    const hold = ctx.loginKeys;
    const held = hold?.keys() ?? [];
    const named = held.map(
      (key): KeptItem => ({ what: `${key.name} (login ${key.login}, variable ${key.variable})`, count: 1 }),
    );
    if (hold === undefined || held.length === 0)
      return { ...base, status: 'converted', note: 'no login holds a plain key', kept: [], sealed: [] };
    if (ctx.dryRun) {
      hold.clear();
      return { ...base, status: 'converted', note: 'dry run: nothing sealed', kept: named, sealed: [] };
    }

    const vaultPath = ctx.v5.resolve(V5_VAULT_FILE);
    const keyPath = ctx.v5.resolve(V5_VAULT_KEY_FILE);
    const first = held[0];
    const listed = held.map(key => `login ${key.login} variable ${key.variable}`).join(', ');
    try {
      const existing = (await readVault(vaultPath)) ?? {
        format: 1 as const,
        cipher: SECRET_CIPHER_ALGORITHM,
        entries: {},
      };
      if (Object.keys(existing.entries).length + held.length > KEY_COUNT_LIMIT)
        throw new V4InputError(
          `${V5_VAULT_FILE}: the vault would hold more than ${String(KEY_COUNT_LIMIT)} secrets with the login keys (login ${first?.login ?? ''}, variable ${first?.variable ?? ''}, and ${String(held.length - 1)} more)`,
        );
      for (const key of held)
        if (existing.entries[key.name] !== undefined)
          throw new V4InputError(
            `${V5_VAULT_FILE}: ${key.name} already exists, so login ${key.login} variable ${key.variable} cannot be sealed under it`,
          );

      let keyBytes = await readKeyBytes(keyPath);
      let minted = false;
      if (keyBytes === undefined) {
        if (Object.keys(existing.entries).length > 0)
          throw new V4InputError(`${V5_VAULT_KEY_FILE}: the vault holds secrets but its key is missing`);
        keyBytes = Buffer.from(crypto.getRandomValues(new Uint8Array(VAULT_KEY_BYTES)));
        await writeAtomic(keyPath, `${keyBytes.toString('base64')}\n`);
        minted = true;
      }
      const values = hold.drain().map(item => ({ name: item.key.name, value: item.value }));
      const sealed = await sealValues(keyBytes, values);
      values.length = 0;
      const at = new Date().toISOString();
      const entries: VaultDocument['entries'] = { ...existing.entries };
      for (const item of sealed)
        entries[item.name] = { iv: item.iv, ciphertext: item.ciphertext, createdAt: at, updatedAt: at };
      const written = VaultDocumentSchema.parse({ format: 1, cipher: SECRET_CIPHER_ALGORITHM, entries });
      const text = `${JSON.stringify(written, null, 2)}\n`;
      await writeAtomic(vaultPath, text);
      return {
        ...base,
        status: 'converted',
        kept: named,
        sealed: [
          { file: V5_VAULT_FILE, bytes: Buffer.byteLength(text) },
          ...(minted ? [{ file: V5_VAULT_KEY_FILE, bytes: Math.ceil(VAULT_KEY_BYTES / 3) * 4 + 1 }] : []),
        ],
      };
    } catch (error) {
      hold.clear();
      // The message is this tool's own sentence (a path and names), never a value: a system error is replaced.
      const detail = error instanceof V4InputError ? error.message : `${V5_VAULT_FILE} cannot be read or written`;
      return {
        ...base,
        status: 'failed',
        note: `cannot seal the login keys (${listed}): ${detail}`,
        kept: [],
        sealed: [],
      };
    }
  },
};
