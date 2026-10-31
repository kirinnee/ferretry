/**
 * SAVED LOGINS: the password manager the input bridge places values from (docs/input-requests.md,
 * "Saved logins"; the wire is `packages/protocol/src/lib/login-entries.ts`).
 *
 * An entry is a label, what it matches, a PLAIN username and up to two SECRET fields (a password and an
 * opt-in 2FA seed). It rests in two files, both `0600`:
 *
 * - the INDEX (`login-entries.json`): label, match, username, which secret fields exist. Nothing in it is
 *   secret; it is what a listing may show.
 * - the SEALED document (`login-secrets.json`): the secret fields, AES-GCM under the vault's key, exactly
 *   as the main vault seals a value. Each is filed under the entry's immutable KEY (`L…_PASSWORD`), never
 *   its handle, so renaming an entry moves nothing that is sealed.
 *
 * THE SAME SPLIT AS THE VAULT, FOR THE SAME REASON:
 *
 * - {@link LoginDirectory} is what a ROUTE is handed. It lists, changes, renames and removes. It seals what
 *   it is given and never opens anything: no method returns a value.
 * - {@link LoginVault} opens. Exactly two things are given one — the redactor (values become masks) and the
 *   input service (a value is typed into the target the owner tapped "Use" for). Neither returns it.
 *
 * The sealed document is NOT the main vault: `fy secret use` cannot spend a saved login and
 * `${secret:…}` cannot name one. A saved login leaves the daemon only into an input request's target.
 */

import { randomBytes } from 'node:crypto';
import {
  type LoginEntryId,
  type LoginEntrySummary,
  type LoginFieldRole,
  MAX_LOGIN_ENTRIES,
  type PutLoginEntry,
  type TotpParameters,
  TotpParametersSchema,
} from '@ferretry/protocol';
import { z } from 'zod';
import type { ClockPort } from '../ports.ts';
import { totpCode } from './totp.ts';
import {
  type SealedSecret,
  type SecretCipherPort,
  type SecretDocumentStore,
  SecretStoreError,
  type SecretVaultDocument,
} from './types.ts';

/** One entry as it rests in the index. `key` never changes; the handle (`id`) is the index's key. */
export const LoginRecordSchema = z.strictObject({
  key: z.string().regex(/^L[0-9A-F]{24}$/u),
  label: z.string().min(1).max(80),
  match: z.array(z.string().min(1).max(320)).max(16),
  username: z.string().min(1).max(256).optional(),
  password: z.boolean(),
  totp: TotpParametersSchema.optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type LoginRecord = z.infer<typeof LoginRecordSchema>;

export const LoginIndexDocumentSchema = z.strictObject({
  v: z.literal(1),
  entries: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u), LoginRecordSchema),
});
export type LoginIndexDocument = z.infer<typeof LoginIndexDocumentSchema>;

/**
 * Durable boundary for the index. `read` answers `undefined` ONLY for an index never written; one that will
 * not parse raises `SecretStoreError('unreadable')`, because damaged is not empty.
 */
export interface LoginIndexStore {
  read(): Promise<LoginIndexDocument | undefined>;
  write(document: LoginIndexDocument): Promise<void>;
}

/** Why a change to a saved login was refused: each is a different thing for the person to do. */
export type LoginRefusal = 'unknown_login' | 'login_exists' | 'label_required' | 'no_such_field';

export class LoginEntryError extends Error {
  constructor(
    readonly refusal: LoginRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'LoginEntryError';
  }
}

/** The sealed name of one secret field: the entry's immutable key, never its handle. */
function sealedName(key: string, role: 'password' | 'totp'): string {
  return `${key}_${role === 'password' ? 'PASSWORD' : 'TOTP'}`;
}

/** A fresh immutable key: 96 random bits. */
export function randomLoginKey(): string {
  return `L${randomBytes(12).toString('hex').toUpperCase()}`;
}

function summary(id: LoginEntryId, record: LoginRecord): LoginEntrySummary {
  return {
    id,
    label: record.label,
    match: [...record.match],
    ...(record.username === undefined ? {} : { username: record.username }),
    fields: { password: record.password, totp: record.totp !== undefined },
    ...(record.totp === undefined ? {} : { totp: record.totp }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** The two documents, read together, so a change never pairs a fresh index with a stale sealed file. */
class LoginDocuments {
  constructor(
    readonly index: LoginIndexStore,
    readonly sealed: SecretDocumentStore,
    readonly cipher: SecretCipherPort,
  ) {}

  async readIndex(): Promise<LoginIndexDocument> {
    return (await this.index.read()) ?? { v: 1, entries: {} };
  }

  async readSealed(): Promise<SecretVaultDocument> {
    const stored = await this.sealed.read();
    if (stored === undefined) return { v: 1, cipher: this.cipher.algorithm, entries: {} };
    if (stored.cipher !== this.cipher.algorithm)
      throw new SecretStoreError('unreadable', `the saved logins were sealed with ${stored.cipher}`);
    return stored;
  }
}

/**
 * The management surface. Seals what it is given; opens nothing; returns names, labels and flags only.
 */
export class LoginDirectory {
  private readonly documents: LoginDocuments;

  constructor(
    index: LoginIndexStore,
    sealed: SecretDocumentStore,
    cipher: SecretCipherPort,
    private readonly clock: ClockPort,
    private readonly newKey: () => string = randomLoginKey,
  ) {
    this.documents = new LoginDocuments(index, sealed, cipher);
  }

  /** Every entry, by label. Raises `SecretStoreError` when it cannot tell — never an empty list. */
  async list(): Promise<readonly LoginEntrySummary[]> {
    const index = await this.documents.readIndex();
    await this.documents.readSealed();
    return Object.entries(index.entries)
      .map(([id, record]) => summary(id, record))
      .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  }

  /**
   * Creates the entry or changes the parts named: a field left out is kept, `null` removes it. The secret
   * fields are sealed and written BEFORE the index names them, so an index never claims a value that is not
   * there; a failure between the two leaves an unused sealed value, never a missing one.
   */
  async put(id: LoginEntryId, change: PutLoginEntry): Promise<LoginEntrySummary> {
    const index = await this.documents.readIndex();
    const sealed = await this.documents.readSealed();
    const existing = index.entries[id];
    if (existing === undefined && Object.keys(index.entries).length >= MAX_LOGIN_ENTRIES)
      throw new SecretStoreError('full', `this daemon already keeps ${MAX_LOGIN_ENTRIES} saved logins`);
    if (existing === undefined && change.label === undefined)
      throw new LoginEntryError('label_required', `a new saved login needs a label; ${id} does not exist yet`);
    const at = this.clock.now();
    const key = existing?.key ?? this.newKey();
    const entries: Record<string, SealedSecret> = { ...sealed.entries };
    let changed = false;
    const seal = async (role: 'password' | 'totp', value: string | null | undefined): Promise<void> => {
      if (value === undefined) return;
      const name = sealedName(key, role);
      changed = true;
      if (value === null) {
        delete entries[name];
        return;
      }
      entries[name] = {
        ...(await this.documents.cipher.seal(name, value)),
        createdAt: entries[name]?.createdAt ?? at,
        updatedAt: at,
      };
    };
    await seal('password', change.password);
    await seal('totp', change.totp === undefined ? undefined : (change.totp?.seed ?? null));
    if (changed) await this.documents.sealed.write({ ...sealed, entries });
    const record = nextRecord(existing, key, change, at);
    await this.documents.index.write({ ...index, entries: { ...index.entries, [id]: record } });
    return summary(id, record);
  }

  /** A new handle for an entry. Its sealed values stay where they are, filed under the entry's key. */
  async rename(from: LoginEntryId, to: LoginEntryId): Promise<LoginEntrySummary> {
    const index = await this.documents.readIndex();
    const record = index.entries[from];
    if (record === undefined) throw new LoginEntryError('unknown_login', `there is no saved login ${from}`);
    if (from === to) return summary(to, record);
    if (index.entries[to] !== undefined)
      throw new LoginEntryError('login_exists', `${to} is already a saved login; pick another name`);
    const { [from]: _moved, ...rest } = index.entries;
    const renamed = { ...record, updatedAt: this.clock.now() };
    await this.documents.index.write({ ...index, entries: { ...rest, [to]: renamed } });
    return summary(to, renamed);
  }

  /**
   * Removes an entry: the index first, so it is gone at once, then its sealed values. A failure after the
   * first write leaves sealed values no entry names, which are still masked and never typed.
   */
  async remove(id: LoginEntryId): Promise<boolean> {
    const index = await this.documents.readIndex();
    const record = index.entries[id];
    if (record === undefined) return false;
    const { [id]: _removed, ...rest } = index.entries;
    await this.documents.index.write({ ...index, entries: rest });
    const sealed = await this.documents.readSealed();
    const {
      [sealedName(record.key, 'password')]: _password,
      [sealedName(record.key, 'totp')]: _totp,
      ...kept
    } = sealed.entries;
    await this.documents.sealed.write({ ...sealed, entries: kept });
    return true;
  }
}

function nextRecord(
  existing: LoginRecord | undefined,
  key: string,
  change: PutLoginEntry,
  at: string,
): LoginRecord {
  const username = change.username === undefined ? existing?.username : (change.username ?? undefined);
  const totp: TotpParameters | undefined =
    change.totp === undefined
      ? existing?.totp
      : change.totp === null
        ? undefined
        : TotpParametersSchema.parse(change.totp.parameters ?? {});
  return {
    key,
    label: change.label ?? (existing?.label as string),
    match: [...new Set(change.match ?? existing?.match ?? [])],
    ...(username === undefined ? {} : { username }),
    password: change.password === undefined ? (existing?.password ?? false) : change.password !== null,
    ...(totp === undefined ? {} : { totp }),
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
  };
}

/**
 * The plaintext side. Given only to the redactor and the input service; nothing it answers leaves the
 * daemon except into an input request's target.
 */
export class LoginVault {
  private readonly documents: LoginDocuments;

  constructor(index: LoginIndexStore, sealed: SecretDocumentStore, cipher: SecretCipherPort) {
    this.documents = new LoginDocuments(index, sealed, cipher);
  }

  /**
   * Every saved secret field, opened, for MASKING: keyed `login:<ID>:password` / `login:<ID>:totp`, a shape no
   * vault secret name can take, so the two stores can share one redaction map without one hiding the other.
   * A sealed value no entry names (a half-finished remove) is still masked, and so is every sealed value when
   * the INDEX cannot be read: masking needs only the sealed values, so a damaged index costs the names in the
   * masks, never a scrub. A sealed document that cannot be opened rejects, and the redactor fails closed.
   */
  async values(): Promise<ReadonlyMap<string, string>> {
    const sealed = await this.documents.readSealed();
    const index = await this.documents.readIndex().catch((error: unknown) => {
      if (error instanceof SecretStoreError) return { v: 1 as const, entries: {} };
      throw error;
    });
    if (Object.keys(sealed.entries).length === 0) return new Map();
    const opened = await this.documents.cipher.openAll(sealed.entries);
    const byName = new Map<string, string>();
    const named = new Set<string>();
    for (const [id, record] of Object.entries(index.entries)) {
      for (const role of ['password', 'totp'] as const) {
        const name = sealedName(record.key, role);
        const value = opened.get(name);
        if (value === undefined) continue;
        named.add(name);
        byName.set(`login:${id}:${role}`, value);
      }
    }
    for (const [name, value] of opened) if (!named.has(name)) byName.set(`login:unnamed:${name}`, value);
    return byName;
  }

  /**
   * The value an entry's field types, made inside the use boundary: the username as stored, the password
   * opened, or the 2FA code generated from the seed at `nowMs` (the seed itself never leaves here). Raises
   * `LoginEntryError` for an entry or field that does not exist.
   */
  async fill(id: LoginEntryId, role: LoginFieldRole, nowMs: number): Promise<string> {
    const index = await this.documents.readIndex();
    const record = index.entries[id];
    if (record === undefined) throw new LoginEntryError('unknown_login', `there is no saved login ${id}`);
    if (role === 'username') {
      if (record.username === undefined)
        throw new LoginEntryError('no_such_field', `${record.label} has no username saved`);
      return record.username;
    }
    if (role === 'password' ? !record.password : record.totp === undefined)
      throw new LoginEntryError(
        'no_such_field',
        `${record.label} has no ${role === 'password' ? 'password' : '2FA seed'} saved`,
      );
    const sealed = await this.documents.readSealed();
    const name = sealedName(record.key, role);
    const entry = sealed.entries[name];
    if (entry === undefined) throw new LoginEntryError('no_such_field', `${record.label} has lost its ${role}`);
    const value = (await this.documents.cipher.openAll({ [name]: entry })).get(name);
    if (value === undefined) throw new LoginEntryError('no_such_field', `${record.label} has lost its ${role}`);
    if (role === 'password') return value;
    const code = totpCode(value, record.totp as TotpParameters, nowMs);
    if (code === undefined) throw new LoginEntryError('no_such_field', `${record.label} has a 2FA seed that is not base32`);
    return code;
  }
}
