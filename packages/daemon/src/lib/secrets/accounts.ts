/**
 * ACCOUNTS AND SIGN-INS: the store the saved logins became (docs/secrets.md, "Accounts and sign-ins"; the wire and
 * the pure migration are `packages/protocol/src/lib/accounts.ts`).
 *
 * An ACCOUNT is one identity: a label, a PLAIN username, a password and its 2FA keys. A SIGN-IN is how that account
 * signs in at ONE place (a website, or a terminal tool) with its method, recipe and what the daemon saw there. It rests
 * in the same two files a saved login did, both `0600`:
 *
 * - the INDEX (`login-entries.json`, now `v: 2`): accounts by handle and sign-ins by id. Nothing in it is secret.
 * - the SEALED document (`login-secrets.json`): the secret fields, AES-GCM under the vault's key, filed under the
 *   account's immutable KEY. The migration NEVER writes it: an account keeps its saved login's key, so every sealed
 *   name is the one it always was, and only the index moves where it names it from.
 *
 * THE SAME SPLIT AS THE VAULT:
 *
 * - {@link AccountDirectory} is what a ROUTE is handed. It lists, changes, renames, merges and removes. It seals what
 *   it is given and never opens anything: no method returns a value.
 * - {@link AccountVault} opens. The redactor (values become masks) and the input service (a value is typed into the
 *   target the owner tapped "Use" for) hold one; the directory holds only its {@link AccountSealPort} (a merge moves a
 *   sealed value from one account to the other without it ever leaving the vault), and the look-alike route only its
 *   `lookAlike` (handles, never what matched). None of them returns a value.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ADD_TWO_FACTOR_KEY_WHERE,
  type AccountId,
  type AccountIndexDocument,
  AccountIndexDocumentSchema,
  accountIndexProblems,
  type AccountRecord,
  type AccountsMigrationReport,
  type AddTwoFactorKeyRequest,
  accountSeedFields,
  type AccountSummary,
  automaticKeysInOfferOrder,
  type LoginFieldRole,
  type LoginMethod,
  type LoginObservation,
  type LoginRecipeProposal,
  type LoginMethodRecord,
  LOGIN_RECIPE_PROPOSALS_MAX,
  MAX_ACCOUNTS,
  MAX_SIGN_INS,
  MAX_SIGN_INS_PER_ACCOUNT,
  migrateLoginIndex,
  type PatchTwoFactorKeyRequest,
  type Place,
  placeHosts,
  placeKeys,
  type PutAccountRequest,
  type SignInId,
  type SignInRecord,
  type SignInSummary,
  type TotpParameters,
  type TwoFactorId,
  type TwoFactorKeyRecord,
  type TwoFactorKeySummary,
  foldObservation,
  recipeRenamed,
  sealedNamesOf,
  twoFactorKeySummaryOf,
} from '@ferretry/protocol';
import type { ClockPort } from '../ports.ts';
import type { LoginIndexDocument } from './logins.ts';
import { totpCode } from './totp.ts';
import {
  type SealedSecret,
  type SecretCipherPort,
  type SecretDocumentStore,
  SecretStoreError,
  type SecretVaultDocument,
} from './types.ts';

/**
 * What the index file holds, as its store read it: a version 1 saved-login index (with the exact bytes, for the one
 * backup the migration keeps) or a version 2 account index. `undefined`: never written.
 */
export type StoredLoginIndex =
  | { readonly v: 1; readonly document: LoginIndexDocument; readonly bytes: string }
  | { readonly v: 2; readonly document: AccountIndexDocument };

/**
 * Durable boundary for the index. `read` answers `undefined` ONLY for an index never written; one that parses as
 * neither version raises `SecretStoreError('unreadable')`, because damaged is not empty. It WRITES only version 2.
 */
export interface LoginIndexStore {
  read(): Promise<StoredLoginIndex | undefined>;
  write(document: AccountIndexDocument): Promise<void>;
  /**
   * Keeps the version 1 bytes beside the index (`login-entries.v1.json`, `0600`) — ONLY if no such copy exists, so the
   * first one is never overwritten. The manual downgrade path (docs/secrets.md).
   */
  keepVersion1(bytes: string): Promise<void>;
}

/** Why a change to an account or sign-in was refused: each is a different thing for the person to do. */
export type LoginRefusal =
  | 'unknown_login'
  | 'login_exists'
  | 'label_required'
  | 'no_such_field'
  | 'bad_via'
  | 'unknown_proposal'
  | 'stale_proposal'
  | 'unknown_sign_in'
  | 'place_taken'
  | 'invalid_change'
  | 'account_has_sign_ins'
  | 'account_has_2fa_keys'
  | 'no_sign_in'
  | 'merge_refused'
  | 'unknown_2fa_key'
  | 'add_2fa_key_needs_passkey';

export class LoginEntryError extends Error {
  constructor(
    readonly refusal: LoginRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'LoginEntryError';
  }
}

/** A FRESH sealed name for one value of one field: the account's immutable key, the field, a random generation. */
export function freshSealedName(key: string, role: 'password' | 'totp'): string {
  return `${key}_${role === 'password' ? 'PASSWORD' : 'TOTP'}_${randomBytes(4).toString('hex').toUpperCase()}`;
}

/** A fresh immutable account key: 96 random bits. */
export function randomLoginKey(): string {
  return `L${randomBytes(12).toString('hex').toUpperCase()}`;
}

/** A fresh sign-in id: 64 random bits. A migrated one is derived instead (the protocol's `migratedSignInId`). */
export function randomSignInId(): SignInId {
  return `si_${randomBytes(8).toString('hex')}`;
}

/** A fresh 2FA key id: 48 random bits. */
export function randomTwoFactorId(): string {
  return `tf_${randomBytes(6).toString('hex')}`;
}

/**
 * EVERY SEALED NAME AN INDEX POINTS AT, built from the protocol's {@link sealedNamesOf} for every account: its
 * password AND every 2FA key's seed. This is the list a sweep KEEPS. A walk of its own that missed one field would
 * make the next sweep delete that field's ciphertext on every account — every saved 2FA seed at the next boot.
 */
export function referencedSeals(index: Pick<AccountIndexDocument, 'accounts'>): ReadonlySet<string> {
  const names = new Set<string>();
  for (const account of Object.values(index.accounts)) for (const name of sealedNamesOf(account)) names.add(name);
  return names;
}

/** Every sealed name a version 1 index points at: what the migration must find in the sealed document, and keep. */
function referencedByVersion1(index: LoginIndexDocument): ReadonlySet<string> {
  const names = new Set<string>();
  for (const record of Object.values(index.entries))
    for (const name of [record.seals.password, record.seals.totp]) if (name !== undefined) names.add(name);
  return names;
}

const missingFrom = (names: ReadonlySet<string>, sealed: SecretVaultDocument): number =>
  [...names].filter(name => sealed.entries[name] === undefined).length;

const EMPTY_INDEX: AccountIndexDocument = { v: 2, accounts: {}, signIns: {} };

/** The index as a change starts from it, and the version 1 it was migrated from in memory, if it was. */
interface IndexRead {
  readonly document: AccountIndexDocument;
  readonly version1?: {
    readonly bytes: string;
    readonly document: LoginIndexDocument;
    readonly report: AccountsMigrationReport;
  };
}

/**
 * ONE CHANGE AT A TIME FOR THE WHOLE STORE. Every account shares the same two files, and a change reads both, awaits
 * sealing and writes both back whole: two changes that overlapped would each start from the same snapshot, and the
 * later write would silently drop the earlier one's credential. So every mutation, from every caller, runs its read,
 * merge and write inside this one queue. A failed change releases the queue for the next one.
 */
export class LoginStoreLock {
  private tail: Promise<unknown> = Promise.resolve();

  async run<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.tail.then(work);
    this.tail = turn.catch(() => undefined);
    return await turn;
  }
}

/** The two documents, read together, so a change never pairs a fresh index with a stale sealed file. */
class AccountDocuments {
  constructor(
    readonly index: LoginIndexStore,
    readonly sealed: SecretDocumentStore,
    readonly cipher: SecretCipherPort,
    private readonly hostName: string,
    private readonly clock: ClockPort,
  ) {}

  /**
   * The index as version 2. A version 1 index not yet migrated is migrated IN MEMORY with the same pure function the
   * boot step commits with (same ids), so every reader agrees before and after that commit; nothing here writes it.
   */
  async read(): Promise<IndexRead> {
    const stored = await this.index.read();
    if (stored === undefined) return { document: EMPTY_INDEX };
    if (stored.v === 2) return { document: stored.document };
    const migrated = migrateLoginIndex(stored.document, { hostName: this.hostName, now: this.clock.now() });
    if (!migrated.ok)
      throw new SecretStoreError('unreadable', `the saved logins cannot become accounts: ${migrated.error}`);
    return {
      document: migrated.value.document,
      version1: { bytes: stored.bytes, document: stored.document, report: migrated.value.report },
    };
  }

  async readSealed(): Promise<SecretVaultDocument> {
    const stored = await this.sealed.read();
    if (stored === undefined) return { v: 1, cipher: this.cipher.algorithm, entries: {} };
    if (stored.cipher !== this.cipher.algorithm)
      throw new SecretStoreError('unreadable', `the saved logins were sealed with ${stored.cipher}`);
    return stored;
  }

  /**
   * Whether a version 1 index may become this version 2 one: every name it points at is in the sealed document, and
   * the version 2 index points at every one of them. Either failing is a DAMAGED store: nothing is migrated, and
   * nothing is swept against it.
   */
  version1Problem(version1: LoginIndexDocument, next: AccountIndexDocument, sealed: SecretVaultDocument) {
    const before = referencedByVersion1(version1);
    const missing = missingFrom(before, sealed);
    if (missing > 0) return `the saved logins name ${String(missing)} sealed value(s) that are not there`;
    const after = referencedSeals(next);
    const lost = [...before].filter(name => !after.has(name)).length;
    return lost > 0 ? `the accounts would lose ${String(lost)} sealed value(s) the saved logins point at` : undefined;
  }

  /**
   * THE ONE COMMIT POINT: the index, written atomically by its store. A change still on an index migrated in memory
   * first keeps the version 1 bytes (only if no copy exists) and checks it may migrate at all, so the downgrade path
   * exists before the first version 2 write, wherever that write comes from.
   */
  async commit(read: IndexRead, next: AccountIndexDocument, sealed: SecretVaultDocument): Promise<void> {
    const checked = AccountIndexDocumentSchema.safeParse(next);
    if (!checked.success)
      throw new LoginEntryError('invalid_change', checked.error.issues[0]?.message ?? 'the change breaks the store');
    if (read.version1 !== undefined) {
      const problem = this.version1Problem(read.version1.document, checked.data, sealed);
      if (problem !== undefined) throw new SecretStoreError('unreadable', `${problem}; nothing was changed`);
      await this.index.keepVersion1(read.version1.bytes);
    }
    await this.index.write(checked.data);
  }
}

/**
 * What the boot step did: migrated a version 1 index (in counts, and the handles of providers whose link was
 * dropped), swept unreferenced sealed values, or why it did neither. `damaged`: NOTHING was migrated or swept.
 */
export interface AccountsBoot {
  readonly swept: number;
  readonly damaged?: string;
  readonly migrated?: AccountsMigrationReport & {
    /**
     * Accounts a saved login signed in VIA whose link the migration dropped (the provider signs in on no site, is
     * gone, or the link went round). Named, because nothing ties them to that site's page any more (secrev-1201 L5).
     */
    readonly providersWithoutLink: readonly AccountId[];
  };
}

/** A sweep's result, as before: how many sealed values went, or why none did. */
export interface LoginSweep {
  readonly swept: number;
  readonly damaged?: string;
}

/** Moves a sealed value between accounts INSIDE the vault: the plaintext never reaches the directory. */
export interface AccountSealPort {
  /** The value sealed under `from`, sealed again under `to`. */
  reseal(from: string, to: string): Promise<{ readonly iv: string; readonly ciphertext: string }>;
  /** Whether two sealed values are the same, compared in constant time. */
  sameValue(left: string, right: string): Promise<boolean>;
}

/** A change in progress: copies of the two record maps, the sealed document read with them, and what it seals. */
export interface AccountDraft {
  readonly accounts: Record<string, AccountRecord>;
  readonly signIns: Record<string, SignInRecord>;
  readonly sealed: SecretVaultDocument;
  readonly added: Record<string, SealedSecret>;
  readonly at: string;
}

export interface AccountDirectoryOptions {
  /** This machine's host name: where a migrated ssh sign-in's prompt runs. */
  readonly hostName?: string;
  readonly newKey?: () => string;
  readonly newSignInId?: () => SignInId;
  readonly newTwoFactorId?: () => string;
  readonly newSealedName?: (key: string, role: 'password' | 'totp') => string;
  readonly lock?: LoginStoreLock;
  /** What a merge moves a sealed value with. Absent: a merge that would move one is refused. */
  readonly seals?: AccountSealPort;
}

/** The listing a route answers from: every account by label, and every sign-in in the account's order. */
export interface AccountListing {
  readonly accounts: readonly AccountSummary[];
  readonly signIns: readonly SignInSummary[];
}

/** The handle each account key has right now. */
const handlesByKey = (accounts: Readonly<Record<string, AccountRecord>>): ReadonlyMap<string, string> =>
  new Map(Object.entries(accounts).map(([handle, account]) => [account.key, handle]));

/** An account's sign-ins, in the index's order. */
export function signInsOf(
  signIns: Readonly<Record<string, SignInRecord>>,
  key: string,
): readonly (readonly [SignInId, SignInRecord])[] {
  return Object.entries(signIns).filter(([, signIn]) => signIn.account === key);
}

/** The account's sign-ins with its site ones first: the first is its PRIMARY (what the compat projection reads). */
export function primaryFirst(
  own: readonly (readonly [SignInId, SignInRecord])[],
): readonly (readonly [SignInId, SignInRecord])[] {
  return [
    ...own.filter(([, signIn]) => signIn.place.kind === 'site'),
    ...own.filter(([, signIn]) => signIn.place.kind !== 'site'),
  ];
}

/** An account as the owner reads it: which fields exist, its 2FA keys without their seals, its sign-ins. */
export function accountSummary(
  id: AccountId,
  account: AccountRecord,
  signIns: Readonly<Record<string, SignInRecord>>,
): AccountSummary {
  const factors = (account.factors ?? []).map(twoFactorKeySummaryOf);
  const seed = accountSeedFields(factors);
  return {
    id,
    label: account.label,
    ...(account.username === undefined ? {} : { username: account.username }),
    fields: { password: account.seals.password !== undefined, totp: seed.totp },
    ...(seed.params === undefined ? {} : { totp: seed.params }),
    factors,
    signIns: signInsOf(signIns, account.key).map(([signInId]) => signInId),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

/** A sign-in as the owner reads it: its provider by handle (and that provider's first site sign-in). */
export function signInSummary(
  id: SignInId,
  signIn: SignInRecord,
  accounts: Readonly<Record<string, AccountRecord>>,
  signIns: Readonly<Record<string, SignInRecord>>,
): SignInSummary {
  const handles = handlesByKey(accounts);
  const viaKey = signIn.method?.viaKey;
  const viaHandle = viaKey === undefined ? undefined : handles.get(viaKey);
  const viaAccount = viaHandle === undefined ? undefined : accounts[viaHandle];
  const viaSite =
    viaKey === undefined ? undefined : signInsOf(signIns, viaKey).find(([, other]) => other.place.kind === 'site');
  const method: LoginMethod = {
    kind: signIn.method?.kind ?? 'password',
    ...(signIn.method?.name === undefined ? {} : { name: signIn.method.name }),
    ...(viaHandle === undefined ? {} : { via: viaHandle }),
  };
  return {
    id,
    account: handles.get(signIn.account) as AccountId,
    place: signIn.place,
    method,
    ...(viaHandle === undefined || viaAccount === undefined
      ? {}
      : {
          via: {
            account: { id: viaHandle, label: viaAccount.label },
            ...(viaSite === undefined ? {} : { signIn: viaSite[0] }),
          },
        }),
    ...(signIn.recipe === undefined ? {} : { recipe: signIn.recipe }),
    ...(signIn.recipe === undefined || signIn.recipeVersion === undefined
      ? {}
      : { recipeVersion: signIn.recipeVersion }),
    ...(signIn.recipe === undefined || signIn.recipeBy === undefined ? {} : { recipeBy: signIn.recipeBy }),
    ...(signIn.autoApplyRecipe === true ? { autoApplyRecipe: true } : {}),
    ...(signIn.observed === undefined ? {} : { observed: [...signIn.observed] }),
    ...(signIn.proposals === undefined ? {} : { proposals: [...signIn.proposals] }),
    createdAt: signIn.createdAt,
    updatedAt: signIn.updatedAt,
  };
}

/** The method a sign-in stores, from the method an owner wrote: the provider by KEY, checked to exist. */
export function methodRecord(
  method: LoginMethod,
  accounts: Readonly<Record<string, AccountRecord>>,
  self: AccountId,
): LoginMethodRecord | undefined {
  if (method.kind === 'password' && method.name === undefined && method.via === undefined) return undefined;
  if (method.via === undefined)
    return { kind: method.kind, ...(method.name === undefined ? {} : { name: method.name }) };
  if (method.via === self)
    throw new LoginEntryError('bad_via', `${self} cannot sign in via itself; pick the provider's account`);
  const provider = Object.hasOwn(accounts, method.via) ? accounts[method.via] : undefined;
  if (provider === undefined)
    throw new LoginEntryError('bad_via', `there is no account ${method.via} to sign in via; save the provider first`);
  return { kind: method.kind, ...(method.name === undefined ? {} : { name: method.name }), viaKey: provider.key };
}

/** The facts a sign-in keeps at a new place: only those at one of its match keys (they only ever shorten a lock). */
const factsAt = (signIn: Pick<SignInRecord, 'observed'>, place: Place): SignInRecord['observed'] => {
  const kept = (signIn.observed ?? []).filter(fact => placeKeys(place).includes(fact.at));
  return kept.length === 0 ? undefined : kept;
};

/**
 * A sign-in with a recipe change applied: the owner's edit makes it theirs, and EVERY change bumps its version, a clear
 * included. The counter is kept while there is no recipe (no reader shows it then), so a recipe set after a clear never
 * gets a version an earlier recipe had: (sign-in, version) names one text, ever.
 */
export function withRecipe(signIn: SignInRecord, recipe: string | null | undefined, at: string): SignInRecord {
  if (recipe === undefined) return signIn;
  const { recipe: _old, recipeBy: _by, recipeVersion, ...rest } = signIn;
  // The same text written again is the owner's now, but it is not a change: its version stays. Nor is clearing none.
  if (recipe === signIn.recipe || (recipe === null && signIn.recipe === undefined))
    return {
      ...rest,
      ...(recipe === null ? {} : { recipe }),
      ...(recipeVersion === undefined ? {} : { recipeVersion }),
    };
  const next = (recipeVersion ?? 0) + 1;
  return recipe === null
    ? { ...rest, recipeVersion: next, updatedAt: at }
    : { ...rest, recipe, recipeVersion: next, updatedAt: at };
}

/**
 * The management surface. Seals what it is given; opens nothing; returns names, labels and flags only. Every change
 * runs under the store's {@link LoginStoreLock}; the composition root builds ONE directory, so every caller shares it.
 */
export class AccountDirectory {
  private readonly documents: AccountDocuments;
  private readonly lock: LoginStoreLock;
  private readonly newKey: () => string;
  private readonly newSignInId: () => SignInId;
  private readonly newTwoFactorId: () => string;
  private readonly newSealedName: (key: string, role: 'password' | 'totp') => string;
  private readonly seals: AccountSealPort | undefined;
  readonly hostName: string;

  constructor(
    index: LoginIndexStore,
    sealed: SecretDocumentStore,
    cipher: SecretCipherPort,
    private readonly clock: ClockPort,
    options: AccountDirectoryOptions = {},
  ) {
    this.hostName = options.hostName ?? 'localhost';
    this.documents = new AccountDocuments(index, sealed, cipher, this.hostName, clock);
    this.lock = options.lock ?? new LoginStoreLock();
    this.newKey = options.newKey ?? randomLoginKey;
    this.newSignInId = options.newSignInId ?? randomSignInId;
    this.newTwoFactorId = options.newTwoFactorId ?? randomTwoFactorId;
    this.newSealedName = options.newSealedName ?? freshSealedName;
    this.seals = options.seals;
  }

  /** Every account by label, and every sign-in. Raises `SecretStoreError` when it cannot tell — never an empty list. */
  async list(): Promise<AccountListing> {
    const { document } = await this.documents.read();
    await this.documents.readSealed();
    const accounts = Object.entries(document.accounts)
      .map(([id, account]) => accountSummary(id, account, document.signIns))
      .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
    const order = new Map(accounts.map((account, index) => [account.id, index]));
    const signIns = Object.entries(document.signIns)
      .map(([id, signIn]) => signInSummary(id, signIn, document.accounts, document.signIns))
      .sort((left, right) => (order.get(left.account) ?? 0) - (order.get(right.account) ?? 0));
    return { accounts, signIns };
  }

  /**
   * ONE CHANGE, read to write, ALL OR NOTHING, under the store lock. `work` edits a draft; then:
   *
   * 1. The draft is checked against the store's rules BEFORE anything is written, so a refused change seals nothing.
   * 2. New secret values (`draft.added`, sealed under FRESH names) are ADDED to the sealed document; nothing the index
   *    points at is touched. A failure here changes nothing.
   * 3. The index is written: THE commit. A failure leaves every account exactly as it was; the new ciphertext is an
   *    orphan, still masked, swept by the next change or boot.
   * 4. Sealed values nothing points at any more are swept. Best effort: an orphan is still masked.
   *
   * For the compat projection (`logins.ts`) and this class only: a route is handed the named methods.
   */
  async transact<T>(
    work: (draft: AccountDraft) => Promise<T> | T,
    options: { readonly sealedOptional?: boolean } = {},
  ): Promise<T> {
    return await this.lock.run(async () => {
      const read = await this.documents.read();
      const sealed = await this.documents.readSealed().catch((error: unknown) => {
        if (options.sealedOptional === true && read.version1 === undefined) return undefined;
        throw error;
      });
      const draft: AccountDraft = {
        accounts: { ...read.document.accounts },
        signIns: { ...read.document.signIns },
        sealed: sealed ?? { v: 1, cipher: this.documents.cipher.algorithm, entries: {} },
        added: {},
        at: this.clock.now(),
      };
      const result = await work(draft);
      const next: AccountIndexDocument = {
        v: 2,
        accounts: draft.accounts,
        signIns: draft.signIns,
        ...(read.document.migrated === undefined ? {} : { migrated: read.document.migrated }),
      };
      const problem = accountIndexProblems(next)[0];
      if (problem !== undefined) throw refusalFor(problem.path, problem.message);
      const staged: SecretVaultDocument = { ...draft.sealed, entries: { ...draft.sealed.entries, ...draft.added } };
      if (Object.keys(draft.added).length > 0) await this.documents.sealed.write(staged);
      await this.documents.commit(read, next, staged);
      if (sealed !== undefined) await this.sweep(next, staged);
      return result;
    });
  }

  /** Seals `value` for `role` of `account` under a fresh name, staged in the draft; answers the name. */
  async seal(draft: AccountDraft, key: string, role: 'password' | 'totp', value: string, previous?: string) {
    const name = this.newSealedName(key, role);
    const before = previous === undefined ? undefined : draft.sealed.entries[previous];
    draft.added[name] = {
      ...(await this.documents.cipher.seal(name, value)),
      createdAt: before?.createdAt ?? draft.at,
      updatedAt: draft.at,
    };
    return name;
  }

  /** A fresh sign-in id no sign-in has. */
  freshSignInId(draft: Pick<AccountDraft, 'signIns'>): SignInId {
    for (;;) {
      const id = this.newSignInId();
      if (!Object.hasOwn(draft.signIns, id)) return id;
    }
  }

  /** A fresh 2FA key id no account has. */
  freshTwoFactorId(draft: Pick<AccountDraft, 'accounts'>): string {
    const taken = new Set(Object.values(draft.accounts).flatMap(account => (account.factors ?? []).map(f => f.id)));
    for (;;) {
      const id = this.newTwoFactorId();
      if (!taken.has(id)) return id;
    }
  }

  /** The account a handle names in a draft, or a refusal. */
  accountIn(draft: Pick<AccountDraft, 'accounts'>, id: AccountId): AccountRecord {
    const account = Object.hasOwn(draft.accounts, id) ? draft.accounts[id] : undefined;
    if (account === undefined) throw new LoginEntryError('unknown_login', `there is no account ${id}`);
    return account;
  }

  /** The sign-in an id names in a draft, or a refusal. */
  signInIn(draft: Pick<AccountDraft, 'signIns'>, id: SignInId): SignInRecord {
    const signIn = Object.hasOwn(draft.signIns, id) ? draft.signIns[id] : undefined;
    if (signIn === undefined) throw new LoginEntryError('unknown_sign_in', `there is no sign-in ${id}`);
    return signIn;
  }

  /**
   * Creates the account or changes the parts named: a field left out is kept, `null` removes it. The password is
   * sealed and written BEFORE the index names it, so an index never claims a value that is not there.
   */
  async putAccount(id: AccountId, change: PutAccountRequest): Promise<AccountSummary> {
    return await this.transact(async draft => {
      await this.applyAccount(draft, id, change);
      return accountSummary(id, draft.accounts[id] as AccountRecord, draft.signIns);
    });
  }

  /** The account half of a change, on a draft: create (with a label) or update label, username and password. */
  async applyAccount(draft: AccountDraft, id: AccountId, change: PutAccountRequest): Promise<AccountRecord> {
    const existing = Object.hasOwn(draft.accounts, id) ? draft.accounts[id] : undefined;
    if (existing === undefined && Object.keys(draft.accounts).length >= MAX_ACCOUNTS)
      throw new SecretStoreError('full', `this daemon already keeps ${String(MAX_ACCOUNTS)} accounts`);
    if (existing === undefined && change.label === undefined)
      throw new LoginEntryError('label_required', `a new account needs a label; ${id} does not exist yet`);
    const key = existing?.key ?? this.newKey();
    const seals: { password?: string } = { ...existing?.seals };
    if (change.password === null) delete seals.password;
    else if (change.password !== undefined)
      seals.password = await this.seal(draft, key, 'password', change.password, existing?.seals.password);
    const username = change.username === undefined ? existing?.username : (change.username ?? undefined);
    const { username: _username, ...rest } = existing ?? { key, seals: {}, createdAt: draft.at };
    const next: AccountRecord = {
      ...rest,
      key,
      label: change.label ?? (existing?.label as string),
      ...(username === undefined ? {} : { username }),
      seals,
      createdAt: existing?.createdAt ?? draft.at,
      updatedAt: draft.at,
    } as AccountRecord;
    draft.accounts[id] = next;
    return next;
  }

  /**
   * An older client's `totp` on `PUT /v1/secrets/logins/:id`. Only `null` (remove the seeded keys) does anything: a
   * SEED is refused here, in the store, whoever calls — a seed is saved only by {@link addSeed}, after the passkey
   * proof bound to its stage (docs/secrets.md, "2FA keys"). An account with two or more seeded keys is refused too:
   * which one is meant cannot be read from that body.
   */
  async applySeed(
    draft: AccountDraft,
    id: AccountId,
    seed: { readonly seed: string; readonly parameters: TotpParameters } | null,
  ): Promise<void> {
    if (seed !== null) throw new LoginEntryError('add_2fa_key_needs_passkey', ADD_TWO_FACTOR_KEY_WHERE);
    const account = this.accountIn(draft, id);
    const factors = account.factors ?? [];
    const seeded = factors.filter(factor => factor.kind === 'totp' && factor.seal !== undefined);
    if (seeded.length > 1)
      throw new LoginEntryError(
        'account_has_2fa_keys',
        `${account.label} keeps ${String(seeded.length)} 2FA seeds; update the app or use \`fy account\` to change one`,
      );
    const next = factors.filter(factor => !seeded.includes(factor));
    const { factors: _old, ...rest } = account;
    draft.accounts[id] = { ...rest, ...(next.length === 0 ? {} : { factors: next }), updatedAt: draft.at };
  }

  /**
   * What saving a seed to an account reads of it: its immutable key (a stage is bound to it, so a rename moves
   * nothing), its words for a card and the mismatch check, every place it signs in, its keys' labels, and how many
   * seeds it keeps. Never a value.
   */
  async seedTarget(id: AccountId): Promise<SeedTarget> {
    const { document } = await this.documents.read();
    const account = this.accountIn(document, id);
    const factors = account.factors ?? [];
    return {
      key: account.key,
      label: account.label,
      ...(account.username === undefined ? {} : { username: account.username }),
      places: signInsOf(document.signIns, account.key).map(([, signIn]) => signIn.place),
      labels: factors.map(factor => factor.label),
      seeds: factors.filter(factor => factor.kind === 'totp' && factor.seal !== undefined).length,
    };
  }

  /** The accounts that sign in at exactly this match key (a login domain, a site's `match` host, a `tool@host`). */
  async accountsAt(matchKey: string): Promise<readonly AccountId[]> {
    const { document } = await this.documents.read();
    const keys = new Set(
      Object.values(document.signIns)
        .filter(signIn => placeKeys(signIn.place).includes(matchKey))
        .map(signIn => signIn.account),
    );
    return Object.entries(document.accounts)
      .filter(([, account]) => keys.has(account.key))
      .map(([handle]) => handle);
  }

  /** A 2FA key with no value (`POST /v1/accounts/:id/factors`). A seed never comes this way: it is staged. */
  async addFactor(id: AccountId, add: AddTwoFactorKeyRequest): Promise<TwoFactorKeySummary> {
    return await this.transact(draft => {
      const account = this.accountIn(draft, id);
      const factors = account.factors ?? [];
      assertLabelFree(factors, add.label, undefined, account.label);
      const key = {
        ...add,
        id: this.freshTwoFactorId(draft),
        addedAt: draft.at,
        addedBy: 'owner',
      } as TwoFactorKeyRecord;
      draft.accounts[id] = { ...account, factors: [...factors, key], updatedAt: draft.at };
      return twoFactorKeySummaryOf(key);
    });
  }

  /** A new label, or the plain facts of the key's kind; `null` removes a fact. Never its kind or its seed. */
  async patchFactor(
    id: AccountId,
    factorId: TwoFactorId,
    patch: PatchTwoFactorKeyRequest,
  ): Promise<TwoFactorKeySummary> {
    return await this.transact(draft => {
      const account = this.accountIn(draft, id);
      const factors = account.factors ?? [];
      const current = factorIn(factors, factorId, account.label);
      if (patch.label !== undefined) assertLabelFree(factors, patch.label, factorId, account.label);
      const facts: Partial<Record<'endsWith' | 'to' | 'app', string | null | undefined>> = {
        ...(current.kind === 'sms' ? { endsWith: patch.endsWith } : {}),
        ...(current.kind === 'email' ? { to: patch.to } : {}),
        ...(current.kind === 'push' ? { app: patch.app } : {}),
      };
      const foreign = (['endsWith', 'to', 'app'] as const).find(
        fact => patch[fact] !== undefined && !Object.hasOwn(facts, fact),
      );
      if (foreign !== undefined)
        throw new LoginEntryError('invalid_change', `a ${current.kind} 2FA key has no ${foreign}; nothing was changed`);
      const next: Record<string, unknown> = {
        ...current,
        ...(patch.label === undefined ? {} : { label: patch.label }),
      };
      for (const [fact, value] of Object.entries(facts)) {
        if (value === null) delete next[fact];
        else if (value !== undefined) next[fact] = value;
      }
      const key = next as TwoFactorKeyRecord;
      draft.accounts[id] = {
        ...account,
        factors: factors.map(factor => (factor.id === factorId ? key : factor)),
        updatedAt: draft.at,
      };
      return twoFactorKeySummaryOf(key);
    });
  }

  /**
   * Removes a 2FA key: the index first (the commit), then its seed is swept with everything nothing points at. Never
   * asks for a passkey: removing a key only narrows what this machine can do. `false`: there was no such key.
   */
  async removeFactor(id: AccountId, factorId: TwoFactorId): Promise<boolean> {
    return await this.transact(draft => {
      const account = this.accountIn(draft, id);
      const factors = account.factors ?? [];
      if (!factors.some(factor => factor.id === factorId)) return false;
      const left = factors.filter(factor => factor.id !== factorId);
      const { factors: _old, ...rest } = account;
      draft.accounts[id] = { ...rest, ...(left.length === 0 ? {} : { factors: left }), updatedAt: draft.at };
      return true;
    });
  }

  /**
   * THE SEED SAVE, for {@link TwoFactorSeedStages} only, after it took the passkey proof bound to the stage: the seed is
   * sealed under a FRESH `…_TOTP_…` name of the account the stage was bound to (by its immutable key, so a rename in
   * between moves nothing), then the index names it — the store's one all-or-nothing change. `undefined`: that
   * account is gone.
   */
  async addSeed(
    accountKey: string,
    seed: string,
    meta: {
      readonly label?: string;
      readonly params: TotpParameters;
      readonly issuer?: string;
      readonly accountName?: string;
    },
  ): Promise<{ readonly account: AccountId; readonly factor: TwoFactorKeySummary } | undefined> {
    return await this.transact(async draft => {
      const handle = handlesByKey(draft.accounts).get(accountKey);
      if (handle === undefined) return undefined;
      const account = this.accountIn(draft, handle);
      const factors = account.factors ?? [];
      const labels = new Set(factors.map(factor => factor.label.toLowerCase()));
      if (meta.label !== undefined) assertLabelFree(factors, meta.label, undefined, account.label);
      const key: TwoFactorKeyRecord = {
        id: this.freshTwoFactorId(draft),
        kind: 'totp',
        label: meta.label ?? freeLabel(labels, DEFAULT_SEED_LABEL),
        seal: await this.seal(draft, account.key, 'totp', seed),
        params: meta.params,
        ...(meta.issuer === undefined ? {} : { issuer: meta.issuer }),
        ...(meta.accountName === undefined ? {} : { accountName: meta.accountName }),
        addedAt: draft.at,
        addedBy: 'owner',
      };
      draft.accounts[handle] = { ...account, factors: [...factors, key], updatedAt: draft.at };
      return { account: handle, factor: twoFactorKeySummaryOf(key) };
    });
  }

  /** A new handle for an account. Its sign-ins name its key and its sealed values stay where they are. */
  async renameAccount(from: AccountId, to: AccountId): Promise<AccountSummary> {
    return await this.transact(draft => {
      const account = this.accountIn(draft, from);
      if (from === to) return accountSummary(to, account, draft.signIns);
      if (Object.hasOwn(draft.accounts, to))
        throw new LoginEntryError('login_exists', `${to} is already an account; pick another name`);
      delete draft.accounts[from];
      draft.accounts[to] = { ...account, updatedAt: draft.at };
      // A recipe that names `[[from]]` names the renamed account.
      for (const [id, signIn] of Object.entries(draft.signIns))
        if (signIn.recipe !== undefined && signIn.recipe.includes(`[[${from}]]`))
          draft.signIns[id] = { ...signIn, recipe: recipeRenamed(signIn.recipe, from, to) };
      return accountSummary(to, draft.accounts[to], draft.signIns);
    });
  }

  /**
   * Removes an account and its sign-ins: the index first (the commit), then a sweep of what nothing points at. Every
   * other sign-in that went via it goes via nothing; every "keep apart" naming it is dropped.
   */
  async removeAccount(id: AccountId): Promise<boolean> {
    return await this.transact(
      draft => {
        const account = Object.hasOwn(draft.accounts, id) ? draft.accounts[id] : undefined;
        if (account === undefined) return false;
        delete draft.accounts[id];
        for (const [signInId] of signInsOf(draft.signIns, account.key)) delete draft.signIns[signInId];
        unlinkVia(draft, account.key);
        dropApart(draft, account.key);
        return true;
      },
      { sealedOptional: true },
    );
  }

  /** One more place an account signs in. A recipe that holds a value is refused before it gets here (the route). */
  async addSignIn(
    accountId: AccountId,
    add: {
      readonly place: Place;
      readonly method?: LoginMethod | undefined;
      readonly recipe?: string | undefined;
      readonly autoApplyRecipe?: boolean | undefined;
    },
  ): Promise<SignInSummary> {
    return await this.transact(draft => {
      const account = this.accountIn(draft, accountId);
      if (Object.keys(draft.signIns).length >= MAX_SIGN_INS)
        throw new SecretStoreError('full', `this daemon already keeps ${String(MAX_SIGN_INS)} sign-ins`);
      if (signInsOf(draft.signIns, account.key).length >= MAX_SIGN_INS_PER_ACCOUNT)
        throw new SecretStoreError('full', `an account has at most ${String(MAX_SIGN_INS_PER_ACCOUNT)} sign-ins`);
      assertPlaceFree(draft, account, add.place, undefined, accountId);
      const method = add.method === undefined ? undefined : methodRecord(add.method, draft.accounts, accountId);
      const id = this.freshSignInId(draft);
      draft.signIns[id] = {
        account: account.key,
        place: add.place,
        ...(method === undefined ? {} : { method }),
        ...(add.recipe === undefined ? {} : { recipe: add.recipe, recipeVersion: 1 }),
        ...(add.autoApplyRecipe === true ? { autoApplyRecipe: true as const } : {}),
        createdAt: draft.at,
        updatedAt: draft.at,
      };
      return signInSummary(id, draft.signIns[id], draft.accounts, draft.signIns);
    });
  }

  /** Changes one sign-in: its place (facts at no key of the new place are dropped), method, recipe, auto-apply. */
  async putSignIn(
    id: SignInId,
    change: {
      readonly place?: Place | undefined;
      readonly method?: LoginMethod | undefined;
      readonly recipe?: string | null | undefined;
      readonly autoApplyRecipe?: boolean | undefined;
    },
  ): Promise<SignInSummary> {
    return await this.transact(draft => {
      const current = this.signInIn(draft, id);
      const handle = handlesByKey(draft.accounts).get(current.account) as AccountId;
      const account = draft.accounts[handle] as AccountRecord;
      const place = change.place ?? current.place;
      if (change.place !== undefined) assertPlaceFree(draft, account, place, id, handle);
      let next: SignInRecord = withRecipe(current, change.recipe, draft.at);
      const { method: _method, observed: _observed, autoApplyRecipe: _auto, ...rest } = next;
      const method = change.method === undefined ? current.method : methodRecord(change.method, draft.accounts, handle);
      const observed = change.place === undefined ? current.observed : factsAt(current, place);
      const autoApply = change.autoApplyRecipe ?? current.autoApplyRecipe === true;
      next = {
        ...rest,
        place,
        ...(method === undefined ? {} : { method }),
        ...(autoApply ? { autoApplyRecipe: true as const } : {}),
        ...(observed === undefined ? {} : { observed }),
        updatedAt: draft.at,
      };
      draft.signIns[id] = next;
      return signInSummary(id, next, draft.accounts, draft.signIns);
    });
  }

  /** Removes one sign-in. Its account stays, with its secret fields. */
  async removeSignIn(id: SignInId): Promise<boolean> {
    return await this.transact(
      draft => {
        if (!Object.hasOwn(draft.signIns, id)) return false;
        delete draft.signIns[id];
        return true;
      },
      { sealedOptional: true },
    );
  }

  /**
   * Folds what the input service SAW while typing at this sign-in into its facts. Only the input service calls this,
   * from its own observation of a real target; no route reaches it. A sign-in that is gone, or a fact at a place that
   * is none of its keys, is ignored. Facts are not an owner's edit, so `updatedAt` is kept.
   */
  async observeSignIn(id: SignInId, seen: LoginObservation): Promise<void> {
    await this.transact(draft => {
      const signIn = Object.hasOwn(draft.signIns, id) ? draft.signIns[id] : undefined;
      if (signIn === undefined || !placeKeys(signIn.place).includes(seen.at)) return;
      draft.signIns[id] = { ...signIn, observed: [...foldObservation(signIn.observed ?? [], seen, draft.at)] };
    });
  }

  /** Files a ferret's recipe proposal on a sign-in, or applies it at once when THAT sign-in has auto-apply on. */
  async proposeSignIn(
    id: SignInId,
    proposal: LoginRecipeProposal,
  ): Promise<{ readonly applied: boolean; readonly dropped: readonly LoginRecipeProposal[] }> {
    return await this.transact(draft => proposeOn(draft, id, this.signInIn(draft, id), proposal));
  }

  /** Remembers the agenda card a proposal was raised on, so settling it closes that card. */
  async proposalCardSignIn(id: SignInId, proposalId: string, agendaItemId: string): Promise<void> {
    await this.transact(draft => cardOn(draft, id, proposalId, agendaItemId));
  }

  /**
   * The owner's answer to a proposal on a sign-in. `approve` makes it the recipe, but only while the recipe is still the
   * one it was proposed against (`stale_proposal`). Either answer removes it.
   */
  async decideSignIn(
    id: SignInId,
    proposalId: string,
    decision: 'approve' | 'decline',
  ): Promise<{ readonly signIn: SignInSummary; readonly proposal: LoginRecipeProposal }> {
    return await this.transact(draft => {
      const { proposal } = decideOn(draft, id, this.signInIn(draft, id), proposalId, decision);
      return { signIn: signInSummary(id, draft.signIns[id] as SignInRecord, draft.accounts, draft.signIns), proposal };
    });
  }

  /**
   * "THESE LOOK LIKE ONE ACCOUNT" → MERGE: `from`'s sign-ins move to `keep`, and then `from` is deleted (the commit) and
   * swept. `keep` takes `from`'s password and seeds only when it has none — moved INSIDE the vault ({@link
   * AccountSealPort}), never through here. Refused, with nothing changed, when both keep a different seed, when a moved
   * sign-in would sign in where `keep` already does, or when a via link would point an account at itself. Every via
   * link and `[[FROM]]` in a recipe follows to `keep`.
   */
  async merge(keepId: AccountId, fromId: AccountId): Promise<AccountSummary> {
    if (keepId === fromId) throw new LoginEntryError('merge_refused', 'an account cannot be merged into itself');
    return await this.transact(async draft => {
      const keep = this.accountIn(draft, keepId);
      const from = this.accountIn(draft, fromId);
      const kept = new Set(signInsOf(draft.signIns, keep.key).flatMap(([, signIn]) => placeHosts(signIn.place)));
      for (const [, signIn] of signInsOf(draft.signIns, from.key))
        for (const host of placeHosts(signIn.place))
          if (kept.has(host))
            throw new LoginEntryError(
              'merge_refused',
              `both ${keep.label} and ${from.label} sign in at ${host}; remove one of those sign-ins first`,
            );
      for (const [, signIn] of Object.entries(draft.signIns)) {
        const via = signIn.method?.viaKey;
        const owner = signIn.account === from.key ? keep.key : signIn.account;
        const target = via === from.key ? keep.key : via;
        if (target !== undefined && target === owner)
          throw new LoginEntryError(
            'merge_refused',
            `a sign-in of ${keep.label} would sign in via itself; change its method first`,
          );
      }
      const seals = await this.mergedSeals(draft, keep, from);
      const factors = await this.mergedFactors(draft, keep, from);
      const apart = [...new Set([...(keep.apartFrom ?? []), ...(from.apartFrom ?? [])])].filter(
        key => key !== keep.key && key !== from.key,
      );
      const { apartFrom: _apart, factors: _factors, username: _username, ...rest } = keep;
      const username = keep.username ?? from.username;
      delete draft.accounts[fromId];
      draft.accounts[keepId] = {
        ...rest,
        ...(username === undefined ? {} : { username }),
        seals,
        ...(factors.length === 0 ? {} : { factors }),
        ...(apart.length === 0 ? {} : { apartFrom: apart }),
        updatedAt: draft.at,
      };
      for (const [id, signIn] of Object.entries(draft.signIns)) {
        const moved = signIn.account === from.key ? { ...signIn, account: keep.key, updatedAt: draft.at } : signIn;
        const linked =
          moved.method?.viaKey === from.key ? { ...moved, method: { ...moved.method, viaKey: keep.key } } : moved;
        draft.signIns[id] =
          linked.recipe !== undefined && linked.recipe.includes(`[[${fromId}]]`)
            ? { ...linked, recipe: recipeRenamed(linked.recipe, fromId, keepId) }
            : linked;
      }
      dropApart(draft, from.key);
      return accountSummary(keepId, draft.accounts[keepId] as AccountRecord, draft.signIns);
    });
  }

  /**
   * `keep`'s password, or `from`'s when `keep` has none. Two DIFFERENT passwords are refused: the one not kept would be
   * swept at the commit and lost for good, exactly as a differing seed would be.
   */
  private async mergedSeals(draft: AccountDraft, keep: AccountRecord, from: AccountRecord) {
    if (from.seals.password === undefined) return { ...keep.seals };
    if (keep.seals.password !== undefined) {
      if (!(await this.anySame(from.seals.password, [keep.seals.password])))
        throw new LoginEntryError(
          'merge_refused',
          `${keep.label} and ${from.label} keep different passwords; change one of them first`,
        );
      return { ...keep.seals };
    }
    return { password: await this.moved(draft, from.seals.password, keep.key, 'password') };
  }

  /**
   * `keep`'s 2FA keys, with `from`'s. A seed moves only when `keep` has none (under a free label if its own is
   * taken: a seed is never dropped), and is the same as one of `keep`'s otherwise; a key with no value moves unless
   * `keep` already has one by that label.
   */
  private async mergedFactors(
    draft: AccountDraft,
    keep: AccountRecord,
    from: AccountRecord,
  ): Promise<TwoFactorKeyRecord[]> {
    const keepKeys = keep.factors ?? [];
    const keepSeeds = keepKeys.flatMap(key => (key.kind === 'totp' && key.seal !== undefined ? [key.seal] : []));
    const labels = new Set(keepKeys.map(key => key.label.normalize('NFKC').toLowerCase()));
    const merged = [...keepKeys];
    for (const key of from.factors ?? []) {
      const seal = key.kind === 'totp' ? key.seal : undefined;
      if (seal !== undefined && keepSeeds.length > 0) {
        if (!(await this.anySame(seal, keepSeeds)))
          throw new LoginEntryError(
            'merge_refused',
            `${keep.label} and ${from.label} keep different 2FA seeds; remove one of them first`,
          );
        continue;
      }
      const folded = key.label.normalize('NFKC').toLowerCase();
      if (seal === undefined || key.kind !== 'totp') {
        if (labels.has(folded)) continue;
        labels.add(folded);
        merged.push(key);
        continue;
      }
      const label = labels.has(folded) ? freeLabel(labels, key.label) : key.label;
      labels.add(label.normalize('NFKC').toLowerCase());
      merged.push({ ...key, label, seal: await this.moved(draft, seal, keep.key, 'totp') });
    }
    return merged;
  }

  private async anySame(seal: string, others: readonly string[]): Promise<boolean> {
    if (this.seals === undefined)
      throw new LoginEntryError('merge_refused', 'this daemon cannot compare sealed values, so it is not merging');
    for (const other of others) if (await this.seals.sameValue(seal, other)) return true;
    return false;
  }

  /** A sealed value moved to another account's key, staged in the draft. */
  private async moved(draft: AccountDraft, name: string, key: string, role: 'password' | 'totp'): Promise<string> {
    if (this.seals === undefined)
      throw new LoginEntryError('merge_refused', 'this daemon cannot move sealed values, so it is not merging');
    const to = this.newSealedName(key, role);
    const before = draft.sealed.entries[name];
    draft.added[to] = {
      ...(await this.seals.reseal(name, to)),
      createdAt: before?.createdAt ?? draft.at,
      updatedAt: draft.at,
    };
    return to;
  }

  /** "THESE ARE NOT ONE ACCOUNT": each account's key in the other's `apartFrom`, so look-alike leaves the pair out. */
  async apart(id: AccountId, otherId: AccountId): Promise<AccountSummary> {
    if (id === otherId) throw new LoginEntryError('invalid_change', 'an account is always one account with itself');
    return await this.transact(draft => {
      const one = this.accountIn(draft, id);
      const other = this.accountIn(draft, otherId);
      const add = (account: AccountRecord, key: string): AccountRecord => ({
        ...account,
        apartFrom: [...new Set([...(account.apartFrom ?? []), key])],
      });
      draft.accounts[id] = add(one, other.key);
      draft.accounts[otherId] = add(other, one.key);
      return accountSummary(id, draft.accounts[id], draft.signIns);
    });
  }

  /**
   * AT BOOT, before any route mounts, under the store lock: migrate a version 1 index, then sweep.
   *
   * 1. Read the index. Absent: nothing to do. Unreadable: DAMAGED — no migration, no write, no sweep.
   * 2. A version 1 index: read the sealed document; every name the index points at must be there, and the migrated
   *    index must point at every one of them. Otherwise DAMAGED, and nothing is migrated or swept.
   * 3. Keep the version 1 bytes (`login-entries.v1.json`, only if no copy exists): the downgrade path.
   * 4. Write the version 2 index: THE commit. The sealed document is not written at all.
   * 5. Sweep against the committed index, as before.
   *
   * A stop before 4 leaves version 1 in place, and the next boot does the same again, to the same bytes but `at`.
   */
  async prepare(): Promise<AccountsBoot> {
    return await this.lock.run(async () => {
      let stored: StoredLoginIndex | undefined;
      try {
        stored = await this.documents.index.read();
      } catch (error) {
        if (error instanceof SecretStoreError) return { swept: 0, damaged: error.message };
        throw error;
      }
      if (stored === undefined) return { swept: 0 };
      const sealed = await this.documents.readSealed();
      let migrated: AccountsBoot['migrated'];
      let committed: AccountIndexDocument;
      if (stored.v === 1) {
        const result = migrateLoginIndex(stored.document, { hostName: this.hostName, now: this.clock.now() });
        if (!result.ok) return { swept: 0, damaged: `the saved logins cannot become accounts: ${result.error}` };
        const problem = this.documents.version1Problem(stored.document, result.value.document, sealed);
        if (problem !== undefined) return { swept: 0, damaged: problem };
        await this.documents.index.keepVersion1(stored.bytes);
        await this.documents.index.write(result.value.document);
        committed = result.value.document;
        migrated = {
          ...result.value.report,
          providersWithoutLink: providersWithoutLink(stored.document, result.value.document),
        };
      } else {
        committed = stored.document;
        const missing = missingFrom(referencedSeals(committed), sealed);
        if (missing > 0)
          return { swept: 0, damaged: `the index names ${String(missing)} sealed value(s) that are not there` };
      }
      const before = Object.keys(sealed.entries).length;
      await this.sweep(committed, sealed);
      const after = Object.keys((await this.documents.readSealed()).entries).length;
      return { swept: before - after, ...(migrated === undefined ? {} : { migrated }) };
    });
  }

  /** Drops sealed values the committed index no longer points at. Best effort: an orphan is still masked. */
  private async sweep(committed: AccountIndexDocument, sealed: SecretVaultDocument): Promise<void> {
    const keep = referencedSeals(committed);
    // A reference to ciphertext that is not there means the index cannot be trusted: keep everything.
    if (missingFrom(keep, sealed) > 0) return;
    const kept = Object.fromEntries(Object.entries(sealed.entries).filter(([name]) => keep.has(name)));
    if (Object.keys(kept).length === Object.keys(sealed.entries).length) return;
    await this.documents.sealed.write({ ...sealed, entries: kept }).catch(() => undefined);
  }
}

/** The label a saved seed gets when the owner gave none, numbered when the account already has one. */
const DEFAULT_SEED_LABEL = 'Authenticator app';

/** What saving a seed reads of an account ({@link AccountDirectory.seedTarget}). */
export interface SeedTarget {
  readonly key: string;
  readonly label: string;
  readonly username?: string;
  readonly places: readonly Place[];
  readonly labels: readonly string[];
  readonly seeds: number;
}

/** Refuses a 2FA key label the account already has (case-folded), other than `except`'s own. */
function assertLabelFree(
  factors: readonly TwoFactorKeyRecord[],
  label: string,
  except: TwoFactorId | undefined,
  account: string,
): void {
  const folded = label.trim().toLowerCase();
  if (factors.some(factor => factor.id !== except && factor.label.trim().toLowerCase() === folded))
    throw new LoginEntryError('invalid_change', `${account} already has a 2FA key called ${label}; pick another label`);
}

/** The 2FA key an id names in an account, or a refusal. */
function factorIn(factors: readonly TwoFactorKeyRecord[], id: TwoFactorId, account: string): TwoFactorKeyRecord {
  const factor = factors.find(each => each.id === id);
  if (factor === undefined) throw new LoginEntryError('unknown_2fa_key', `${account} has no 2FA key ${id}`);
  return factor;
}

/** A label not yet taken in an account: the word, then the word and a number. */
function freeLabel(taken: ReadonlySet<string>, word: string): string {
  if (!taken.has(word.toLowerCase())) return word;
  for (let next = 2; ; next += 1)
    if (!taken.has(`${word} ${String(next)}`.toLowerCase())) return `${word} ${String(next)}`;
}

/** Refuses a place an account already signs in at (another of its sign-ins names one of the same keys). */
function assertPlaceFree(
  draft: Pick<AccountDraft, 'signIns'>,
  account: AccountRecord,
  place: Place,
  except: SignInId | undefined,
  handle: AccountId,
): void {
  const hosts = new Set(placeHosts(place));
  for (const [id, signIn] of signInsOf(draft.signIns, account.key)) {
    if (id === except) continue;
    const shared = placeHosts(signIn.place).find(host => hosts.has(host));
    if (shared !== undefined)
      throw new LoginEntryError('place_taken', `${handle} already signs in at ${shared} (${id}); change that sign-in`);
  }
}

/** Every sign-in that went via `key` goes via nothing: only the link goes, the method's kind stays. */
function unlinkVia(draft: AccountDraft, key: string): void {
  for (const [id, signIn] of Object.entries(draft.signIns)) {
    if (signIn.method?.viaKey !== key) continue;
    const { viaKey: _gone, ...method } = signIn.method;
    draft.signIns[id] = { ...signIn, method };
  }
}

/** No account keeps `key` in its "keep apart" list any more. */
function dropApart(draft: AccountDraft, key: string): void {
  for (const [handle, account] of Object.entries(draft.accounts)) {
    if (account.apartFrom?.includes(key) !== true) continue;
    const { apartFrom, ...rest } = account;
    const left = apartFrom.filter(other => other !== key);
    draft.accounts[handle] = { ...rest, ...(left.length === 0 ? {} : { apartFrom: left }) };
  }
}

export function proposeOn(
  draft: AccountDraft,
  id: SignInId,
  signIn: SignInRecord,
  proposal: LoginRecipeProposal,
): { readonly applied: boolean; readonly dropped: readonly LoginRecipeProposal[] } {
  if (signIn.autoApplyRecipe === true) {
    draft.signIns[id] = { ...withRecipe(signIn, proposal.recipe, draft.at), recipeBy: 'ferret' };
    return { applied: true, dropped: [] };
  }
  const waiting = [...(signIn.proposals ?? []), proposal];
  const dropped = waiting.slice(0, Math.max(0, waiting.length - LOGIN_RECIPE_PROPOSALS_MAX));
  draft.signIns[id] = { ...signIn, proposals: waiting.slice(-LOGIN_RECIPE_PROPOSALS_MAX) };
  return { applied: false, dropped };
}

export function cardOn(draft: AccountDraft, id: SignInId, proposalId: string, agendaItemId: string): void {
  const signIn = Object.hasOwn(draft.signIns, id) ? draft.signIns[id] : undefined;
  if (signIn?.proposals?.some(proposal => proposal.id === proposalId) !== true) return;
  const proposals = signIn.proposals.map(proposal =>
    proposal.id === proposalId ? { ...proposal, agendaItemId } : proposal,
  );
  draft.signIns[id] = { ...signIn, proposals };
}

export function decideOn(
  draft: AccountDraft,
  id: SignInId,
  signIn: SignInRecord,
  proposalId: string,
  decision: 'approve' | 'decline',
): { readonly proposal: LoginRecipeProposal } {
  const proposal = signIn.proposals?.find(waiting => waiting.id === proposalId);
  if (proposal === undefined)
    throw new LoginEntryError(
      'unknown_proposal',
      `${id} has no recipe proposal ${proposalId}; it was answered or replaced`,
    );
  if (decision === 'approve' && signIn.recipe !== proposal.base)
    throw new LoginEntryError(
      'stale_proposal',
      'the recipe changed after this proposal was made; decline it, or edit the recipe yourself',
    );
  const proposals = (signIn.proposals ?? []).filter(waiting => waiting.id !== proposalId);
  const { proposals: _old, ...rest } = signIn;
  const bare: SignInRecord = { ...rest, ...(proposals.length === 0 ? {} : { proposals }) };
  // An approved recipe is the owner's: whoever wrote it before, a person has now read it.
  draft.signIns[id] =
    decision === 'approve'
      ? (() => {
          const { recipeBy: _by, ...owned } = withRecipe(bare, proposal.recipe, draft.at);
          return { ...owned, updatedAt: draft.at };
        })()
      : bare;
  return { proposal };
}

/**
 * The handles of the providers whose via link the migration dropped: a saved login went via them, and the account it
 * became goes via nothing. Nothing on that site's page ties them to it any more.
 */
function providersWithoutLink(version1: LoginIndexDocument, migrated: AccountIndexDocument): readonly AccountId[] {
  const named = new Set<string>();
  for (const [handle, record] of Object.entries(version1.entries)) {
    const via = record.method?.via;
    if (via === undefined || !Object.hasOwn(version1.entries, via)) continue;
    const own = signInsOf(migrated.signIns, record.key);
    if (own.length > 0 && own.every(([, signIn]) => signIn.method?.viaKey === undefined) && handle !== via)
      named.add(via);
  }
  return [...named].sort();
}

/**
 * The refusal a broken store rule reads as: a via problem, a limit, or the rest. A place an account already signs in at
 * is refused by every write before it gets here (`assertPlaceFree`, the merge's own check), so it is not one of them.
 */
function refusalFor(path: readonly (string | number)[], message: string): Error {
  if (path.includes('viaKey') || message.startsWith('via links')) return new LoginEntryError('bad_via', message);
  if (path.length <= 2 && /at most/u.test(message)) return new SecretStoreError('full', message);
  return new LoginEntryError('invalid_change', message);
}

/**
 * The ONLY parts of an {@link AccountVault} handed past the redactor and the input service, as fresh closures: the
 * directory's seal port (a merge) and the look-alike answer (a route). Neither object is the vault, so nothing that
 * holds one can reach `values()` or `fill()`, whatever it is cast to.
 */
export function narrowAccountVault(vault: AccountVault): {
  readonly seals: AccountSealPort;
  readonly lookAlike: { lookAlike(): Promise<readonly (readonly AccountId[])[]> };
} {
  return {
    seals: Object.freeze({
      reseal: async (from: string, to: string) => await vault.reseal(from, to),
      sameValue: async (left: string, right: string) => await vault.sameValue(left, right),
    }),
    lookAlike: Object.freeze({ lookAlike: async () => await vault.lookAlike() }),
  };
}

/** The fields a card keeps in one account at once: the plain username, the secret password, or both. */
export interface LoginFieldValues {
  readonly username?: string;
  readonly password?: string;
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** A username as look-alike compares it: trimmed and case-folded. */
const foldedUsername = (username: string): string => username.trim().normalize('NFKC').toLowerCase();

/**
 * The plaintext side. Given only to the redactor and the input service; the directory holds its seal port and the
 * look-alike route its `lookAlike`. Nothing it answers leaves the daemon except into an input request's target.
 */
export class AccountVault implements AccountSealPort {
  private readonly documents: AccountDocuments;

  constructor(
    index: LoginIndexStore,
    sealed: SecretDocumentStore,
    cipher: SecretCipherPort,
    options: { readonly hostName?: string; readonly clock?: ClockPort } = {},
  ) {
    this.documents = new AccountDocuments(
      index,
      sealed,
      cipher,
      options.hostName ?? 'localhost',
      options.clock ?? { now: () => new Date().toISOString() },
    );
  }

  /**
   * Every saved secret field, opened, for MASKING: keyed `login:<ID>:password`, `login:<ID>:totp` (the account's first
   * seed) and `login:<ID>:totp:<tf_id>` (any other), a shape no vault secret name can take. A sealed value no account
   * names is still masked, and so is every sealed value when the INDEX cannot be read: masking needs only the sealed
   * values. A sealed document that cannot be opened rejects, and the redactor fails closed.
   */
  async values(): Promise<ReadonlyMap<string, string>> {
    const sealed = await this.documents.readSealed();
    const index = await this.documents
      .read()
      .then(read => read.document)
      .catch((error: unknown) => {
        if (error instanceof SecretStoreError) return EMPTY_INDEX;
        throw error;
      });
    if (Object.keys(sealed.entries).length === 0) return new Map();
    const opened = await this.documents.cipher.openAll(sealed.entries);
    const byName = new Map<string, string>();
    const named = new Set<string>();
    const add = (mask: string, name: string | undefined): void => {
      if (name === undefined) return;
      const value = opened.get(name);
      if (value === undefined) return;
      named.add(name);
      byName.set(mask, value);
    };
    // The same walk the sweep keeps ({@link sealedNamesOf}), so every value an account points at is masked under its
    // name; a field this does not know by role is still masked under the account, never left unmasked.
    for (const [id, account] of Object.entries(index.accounts)) {
      const seeded = (account.factors ?? []).filter(key => key.kind === 'totp' && key.seal !== undefined);
      for (const name of sealedNamesOf(account)) {
        const position = seeded.findIndex(key => key.kind === 'totp' && key.seal === name);
        const key = seeded[position];
        if (name === account.seals.password) add(`login:${id}:password`, name);
        else if (key !== undefined) add(position === 0 ? `login:${id}:totp` : `login:${id}:totp:${key.id}`, name);
        else add(`login:${id}:sealed:${name}`, name);
      }
    }
    for (const [name, value] of opened) if (!named.has(name)) byName.set(`login:unnamed:${name}`, value);
    return byName;
  }

  /**
   * The value an account's field types, made inside the use boundary: the username as stored, the password opened, or
   * the 2FA code generated at `nowMs` from the seed of the key a code card offers first (the seed never leaves here).
   */
  async fill(
    id: AccountId,
    role: LoginFieldRole,
    nowMs: number,
    options: { readonly factor?: TwoFactorId } = {},
  ): Promise<string> {
    const { document } = await this.documents.read();
    const account = Object.hasOwn(document.accounts, id) ? document.accounts[id] : undefined;
    if (account === undefined) throw new LoginEntryError('unknown_login', `there is no saved login ${id}`);
    if (role === 'username') {
      if (account.username === undefined)
        throw new LoginEntryError('no_such_field', `${account.label} has no username saved`);
      return account.username;
    }
    // A code from the key named, which must be this account's and hold a seed; else the key a code card offers first.
    const [first] = automaticKeysInOfferOrder((account.factors ?? []).map(twoFactorKeySummaryOf));
    const chosen = options.factor ?? first?.id;
    const key = (account.factors ?? []).find(factor => factor.id === chosen);
    const name = role === 'password' ? account.seals.password : key?.kind === 'totp' ? key.seal : undefined;
    if (name === undefined)
      throw new LoginEntryError(
        'no_such_field',
        `${account.label} has no ${role === 'password' ? 'password' : '2FA seed'} saved`,
      );
    const value = await this.open(name);
    if (value === undefined) throw new LoginEntryError('no_such_field', `${account.label} has lost its ${role}`);
    if (role === 'password') return value;
    const code = key?.kind === 'totp' && key.params !== undefined ? totpCode(value, key.params, nowMs) : undefined;
    if (code === undefined)
      throw new LoginEntryError('no_such_field', `${account.label} has a 2FA seed that is not base32`);
    return code;
  }

  private async open(name: string): Promise<string | undefined> {
    const sealed = await this.documents.readSealed();
    const entry = sealed.entries[name];
    if (entry === undefined) return undefined;
    return (await this.documents.cipher.openAll({ [name]: entry })).get(name);
  }

  async reseal(from: string, to: string): Promise<{ readonly iv: string; readonly ciphertext: string }> {
    const value = await this.open(from);
    if (value === undefined) throw new LoginEntryError('merge_refused', 'a sealed value to move is not there');
    return await this.documents.cipher.seal(to, value);
  }

  async sameValue(left: string, right: string): Promise<boolean> {
    const [one, other] = [await this.open(left), await this.open(right)];
    if (one === undefined || other === undefined) return false;
    return timingSafeEqual(digest(one), digest(other));
  }

  /**
   * "THESE LOOK LIKE ONE ACCOUNT": groups of accounts with the same username (trimmed, case-folded) AND the same
   * password, compared HERE in constant time over equal-length digests. No group ever holds a pair the owner said to
   * keep apart: a set of look-alikes with such a pair inside is answered as its other pairs, two by two, so that
   * "merge this group" can never fold a kept-apart pair together through a third account. The answer is HANDLES ONLY, computed on demand and never written anywhere: "these share a password" is derived
   * from secrets, and the index is a file anyone who can read it may read.
   */
  async lookAlike(): Promise<readonly (readonly AccountId[])[]> {
    const { document } = await this.documents.read();
    const sealed = await this.documents.readSealed();
    const candidates = Object.entries(document.accounts).filter(
      ([, account]) => account.username !== undefined && account.seals.password !== undefined,
    );
    if (candidates.length < 2) return [];
    const names = Object.fromEntries(
      candidates.flatMap(([, account]) => {
        const name = account.seals.password as string;
        const entry = sealed.entries[name];
        return entry === undefined ? [] : [[name, entry] as const];
      }),
    );
    const opened = await this.documents.cipher.openAll(names);
    const digests = new Map(
      candidates.flatMap(([handle, account]) => {
        const value = opened.get(account.seals.password as string);
        return value === undefined ? [] : [[handle, digest(value)] as const];
      }),
    );
    const parent = new Map<string, string>();
    const root = (handle: string): string => {
      let at = handle;
      while (parent.get(at) !== undefined && parent.get(at) !== at) at = parent.get(at) as string;
      return at;
    };
    for (const [handle] of candidates) parent.set(handle, handle);
    for (let i = 0; i < candidates.length; i += 1)
      for (let j = i + 1; j < candidates.length; j += 1) {
        const [leftId, left] = candidates[i] as readonly [string, AccountRecord];
        const [rightId, right] = candidates[j] as readonly [string, AccountRecord];
        if (foldedUsername(left.username as string) !== foldedUsername(right.username as string)) continue;
        const one = digests.get(leftId);
        const other = digests.get(rightId);
        if (one === undefined || other === undefined || !timingSafeEqual(one, other)) continue;
        parent.set(root(rightId), root(leftId));
      }
    const keyOf = new Map(candidates.map(([handle, account]) => [handle, account]));
    const apart = (left: string, right: string): boolean => {
      const one = keyOf.get(left) as AccountRecord;
      const other = keyOf.get(right) as AccountRecord;
      return one.apartFrom?.includes(other.key) === true || other.apartFrom?.includes(one.key) === true;
    };
    const classes = new Map<string, AccountId[]>();
    for (const [handle] of candidates) classes.set(root(handle), [...(classes.get(root(handle)) ?? []), handle]);
    const groups: AccountId[][] = [];
    for (const members of classes.values()) {
      const sorted = members.toSorted();
      const pairs = sorted.flatMap((left, index) => sorted.slice(index + 1).map(right => [left, right] as const));
      if (pairs.every(([left, right]) => !apart(left, right))) {
        if (sorted.length > 1) groups.push(sorted);
        continue;
      }
      for (const [left, right] of pairs) if (!apart(left, right)) groups.push([left, right]);
    }
    return groups.toSorted(
      (left, right) =>
        (left[0] as string).localeCompare(right[0] as string) || (left[1] as string).localeCompare(right[1] as string),
    );
  }
}
