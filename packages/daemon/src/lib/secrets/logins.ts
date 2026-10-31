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
  LOGIN_MATCH_MAX,
  LoginDomainSchema,
  type LoginMethod,
  type LoginObservation,
  LoginObservedSchema,
  type LoginRecipeProposal,
  LoginRecipeProposalSchema,
  LOGIN_OBSERVED_MAX,
  LOGIN_RECIPE_PROPOSALS_MAX,
  foldObservation,
  recipeRenamed,
  LoginMethodSchema,
  MAX_LOGIN_ENTRIES,
  PASSWORD_METHOD,
  webHostsOf,
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

const SEALED_NAME = /^L[0-9A-F]{24}_(?:PASSWORD|TOTP)_[0-9A-F]{8}$/u;

/** One entry as it rests in the index. `key` never changes; the handle (`id`) is the index's key. */
export const LoginRecordSchema = z.strictObject({
  key: z.string().regex(/^L[0-9A-F]{24}$/u),
  label: z.string().min(1).max(80),
  match: z.array(z.string().min(1).max(320)).max(16),
  /** How it signs in. Absent: an entry from before methods, which signs in with its password. */
  method: LoginMethodSchema.optional(),
  /** Where the sign-in happens. Absent: an entry from before login domains, which reads as its web `match` hosts. */
  domains: z.array(LoginDomainSchema).max(16).optional(),
  username: z.string().min(1).max(256).optional(),
  /**
   * WHERE each secret field rests in the sealed document right now. A change seals a new value under a FRESH
   * name and only then points the index at it, so the index is the one commit point: until it is written the
   * old value is still the entry's and still sealed (so still masked). Absent: the entry has no such field.
   */
  seals: z.strictObject({
    password: z.string().regex(SEALED_NAME).optional(),
    totp: z.string().regex(SEALED_NAME).optional(),
  }),
  /** How the 2FA code is made; present exactly when `seals.totp` is. */
  totp: TotpParametersSchema.optional(),
  /** The owner's sign-in steps (Markdown). Not secret; a change holding a value is refused before it gets here. */
  recipe: z.string().min(1).max(4_000).optional(),
  /** A ferret's proposal applies without asking. Absent: it waits for the owner. */
  autoApplyRecipe: z.literal(true).optional(),
  /** `ferret`: the recipe is an auto-applied proposal nobody reviewed. Cleared by any owner edit or approval. */
  recipeBy: z.literal('ferret').optional(),
  /** What the daemon saw while typing this login. Written only by the input service. */
  observed: z.array(LoginObservedSchema).max(LOGIN_OBSERVED_MAX).optional(),
  /** Ferrets' recipes waiting for the owner. */
  proposals: z.array(LoginRecipeProposalSchema).max(LOGIN_RECIPE_PROPOSALS_MAX).optional(),
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
export type LoginRefusal =
  | 'unknown_login'
  | 'login_exists'
  | 'label_required'
  | 'no_such_field'
  | 'bad_via'
  | 'unknown_proposal'
  | 'stale_proposal';

export class LoginEntryError extends Error {
  constructor(
    readonly refusal: LoginRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'LoginEntryError';
  }
}

/**
 * A FRESH sealed name for one value of one field: the entry's immutable key (never its handle), the field, and a
 * random generation. Every write of a secret field gets a new name, so writing it never overwrites the value the
 * index still points at.
 */
export function freshSealedName(key: string, role: 'password' | 'totp'): string {
  return `${key}_${role === 'password' ? 'PASSWORD' : 'TOTP'}_${randomBytes(4).toString('hex').toUpperCase()}`;
}

/** How many sealed names the index points at that the sealed document does not hold. */
function missingReferences(index: LoginIndexDocument, sealed: SecretVaultDocument): number {
  return [...referenced(index)].filter(name => sealed.entries[name] === undefined).length;
}

/** Every sealed name an index points at. */
function referenced(index: LoginIndexDocument): ReadonlySet<string> {
  const names = new Set<string>();
  for (const record of Object.values(index.entries))
    for (const name of [record.seals.password, record.seals.totp]) if (name !== undefined) names.add(name);
  return names;
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
    method: record.method ?? PASSWORD_METHOD,
    domains: [...(record.domains ?? webHostsOf(record.match))],
    ...(record.username === undefined ? {} : { username: record.username }),
    fields: { password: record.seals.password !== undefined, totp: record.seals.totp !== undefined },
    ...(record.totp === undefined ? {} : { totp: record.totp }),
    ...(record.recipe === undefined ? {} : { recipe: record.recipe }),
    ...(record.recipe === undefined || record.recipeBy === undefined ? {} : { recipeBy: record.recipeBy }),
    ...(record.autoApplyRecipe === true ? { autoApplyRecipe: true } : {}),
    ...(record.observed === undefined ? {} : { observed: [...record.observed] }),
    ...(record.proposals === undefined ? {} : { proposals: [...record.proposals] }),
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
 * ONE CHANGE AT A TIME FOR THE WHOLE STORE. Every entry shares the same two files, and a change reads both,
 * awaits sealing and writes both back whole: two changes that overlapped would each start from the same
 * snapshot, and the later write would silently drop the earlier one's credential — and with it the only
 * ciphertext that keeps that value masked. So every mutation, from every caller (a route, the CLI, a card's
 * "Save as"), runs its read, merge and write inside this one queue. A per-entry or per-session lock is not
 * enough: the files are shared. A failed change releases the queue for the next one.
 */
export class LoginStoreLock {
  private tail: Promise<unknown> = Promise.resolve();

  async run<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.tail.then(work);
    this.tail = turn.catch(() => undefined);
    return await turn;
  }
}

/**
 * What a boot sweep did: how many unreferenced sealed values it removed, or why it removed none. `damaged` is a
 * committed index that names ciphertext the sealed document does not hold: with a reference that cannot be
 * trusted, NOTHING is swept, so no value can lose its masking on the strength of a broken index.
 */
export interface LoginSweep {
  readonly swept: number;
  readonly damaged?: string;
}

/** The fields a card keeps in one saved login at once: the plain username, the secret password, or both. */
export interface LoginFieldValues {
  readonly username?: string;
  readonly password?: string;
}

/**
 * The management surface. Seals what it is given; opens nothing; returns names, labels and flags only. Every
 * change runs under the store's {@link LoginStoreLock}; the composition root builds ONE directory, so every
 * caller shares it.
 */
export class LoginDirectory {
  private readonly documents: LoginDocuments;

  constructor(
    index: LoginIndexStore,
    sealed: SecretDocumentStore,
    cipher: SecretCipherPort,
    private readonly clock: ClockPort,
    private readonly newKey: () => string = randomLoginKey,
    private readonly lock: LoginStoreLock = new LoginStoreLock(),
    private readonly newSealedName: (key: string, role: 'password' | 'totp') => string = freshSealedName,
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
    return await this.lock.run(async () => await this.change(id, change));
  }

  /**
   * Keeps typed values in a saved login in ONE change: a new entry labelled `label`, or the existing one (its
   * label kept, `match` added to what it already matches). The read of what exists and the write that
   * merges into it are one step under the store lock, so a Settings edit or another card cannot slip between
   * them. The username and the password of one login card are kept together or not at all.
   */
  async saveFields(
    id: LoginEntryId,
    label: string,
    match: string | undefined,
    fields: LoginFieldValues,
  ): Promise<LoginEntrySummary> {
    return await this.lock.run(async () => {
      const existing = (await this.documents.readIndex()).entries[id];
      const matches = [...new Set([...(existing?.match ?? []), ...(match === undefined ? [] : [match])])].slice(
        -LOGIN_MATCH_MAX,
      );
      const domains =
        existing?.domains === undefined || match === undefined || webHostsOf([match]).length === 0
          ? undefined
          : [...new Set([...existing.domains, match])].slice(-LOGIN_MATCH_MAX);
      return await this.change(id, {
        ...(existing === undefined ? { label } : {}),
        match: matches,
        ...(domains === undefined ? {} : { domains }),
        ...(fields.username === undefined ? {} : { username: fields.username }),
        ...(fields.password === undefined ? {} : { password: fields.password }),
      });
    });
  }

  /**
   * One change, read to write, ALL OR NOTHING. Callers hold the store lock.
   *
   * 1. New secret values are sealed under FRESH names and ADDED to the sealed document; nothing the index points
   *    at is touched. A failure here changes nothing.
   * 2. The index is written pointing at the new names, with the new username, label and match: THE commit. A
   *    failure here leaves the entry exactly as it was (old username, old password), and the old ciphertext still
   *    sealed and masked; the new ciphertext is an orphan, still masked, swept by the next change.
   * 3. Sealed values nothing points at any more are swept. Best effort: a failure leaves orphans, still masked,
   *    and the change has already committed.
   */
  private async change(id: LoginEntryId, change: PutLoginEntry): Promise<LoginEntrySummary> {
    const index = await this.documents.readIndex();
    const sealed = await this.documents.readSealed();
    const existing = index.entries[id];
    if (existing === undefined && Object.keys(index.entries).length >= MAX_LOGIN_ENTRIES)
      throw new SecretStoreError('full', `this daemon already keeps ${MAX_LOGIN_ENTRIES} saved logins`);
    if (existing === undefined && change.label === undefined)
      throw new LoginEntryError('label_required', `a new saved login needs a label; ${id} does not exist yet`);
    checkVia(id, change.method, index);
    const at = this.clock.now();
    const key = existing?.key ?? this.newKey();
    const seals: { password?: string; totp?: string } = { ...existing?.seals };
    const added: Record<string, SealedSecret> = {};
    const seal = async (role: 'password' | 'totp', value: string | null | undefined): Promise<void> => {
      if (value === undefined) return;
      if (value === null) {
        delete seals[role];
        return;
      }
      const previous = seals[role] === undefined ? undefined : sealed.entries[seals[role] as string];
      const name = this.newSealedName(key, role);
      added[name] = {
        ...(await this.documents.cipher.seal(name, value)),
        createdAt: previous?.createdAt ?? at,
        updatedAt: at,
      };
      seals[role] = name;
    };
    await seal('password', change.password);
    await seal('totp', change.totp === undefined ? undefined : (change.totp?.seed ?? null));
    const staged: SecretVaultDocument = { ...sealed, entries: { ...sealed.entries, ...added } };
    if (Object.keys(added).length > 0) await this.documents.sealed.write(staged);
    const record = nextRecord(existing, key, change, at, seals);
    const committed: LoginIndexDocument = { ...index, entries: { ...index.entries, [id]: record } };
    await this.documents.index.write(committed);
    await this.sweep(committed, staged);
    return summary(id, record);
  }

  /**
   * AT BOOT: drops sealed values the index does not point at — what a change left when the daemon stopped between
   * staging new ciphertext and committing the index, or before its sweep. Until then they are masked like any
   * sealed value. Never sweeps against an index that was never written or cannot be read: with no commit to trust,
   * everything is kept (and masked). Runs under the store lock, so no change can be mid-flight.
   */
  async sweepUnreferenced(): Promise<LoginSweep> {
    return await this.lock.run(async () => {
      const index = await this.documents.index.read();
      if (index === undefined) return { swept: 0 };
      const sealed = await this.documents.readSealed();
      const missing = missingReferences(index, sealed);
      if (missing > 0) return { swept: 0, damaged: `the index names ${missing} sealed value(s) that are not there` };
      const before = Object.keys(sealed.entries).length;
      await this.sweep(index, sealed);
      return { swept: before - Object.keys((await this.documents.readSealed()).entries).length };
    });
  }

  /** Drops sealed values the committed index no longer points at. Best effort: an orphan is still masked. */
  private async sweep(committed: LoginIndexDocument, sealed: SecretVaultDocument): Promise<void> {
    // A reference to ciphertext that is not there means the index cannot be trusted: keep everything.
    if (missingReferences(committed, sealed) > 0) return;
    const keep = referenced(committed);
    const kept = Object.fromEntries(Object.entries(sealed.entries).filter(([name]) => keep.has(name)));
    if (Object.keys(kept).length === Object.keys(sealed.entries).length) return;
    await this.documents.sealed.write({ ...sealed, entries: kept }).catch(() => undefined);
  }

  /**
   * Folds what the input service SAW while typing this login into its facts (login-recipes.ts). Only the input
   * service calls this, from its own observation of a real target; no route or agent tool reaches it. An entry
   * that is gone is ignored: the delivery happened, there is just nothing left to remember it on. Facts are not an
   * owner's edit, so `updatedAt` is kept.
   */
  async observe(id: LoginEntryId, seen: LoginObservation): Promise<void> {
    await this.lock.run(async () => {
      const index = await this.documents.readIndex();
      const record = index.entries[id];
      if (record === undefined) return;
      const observed = [...foldObservation(record.observed ?? [], seen, this.clock.now())];
      await this.documents.index.write({ ...index, entries: { ...index.entries, [id]: { ...record, observed } } });
    });
  }

  /**
   * Files a ferret's recipe proposal on the entry, or applies it at once when the owner turned auto-apply on for
   * this login. A fourth proposal pushes out the oldest, which is answered back so its card can close. The caller
   * has already refused a recipe that holds a value.
   */
  async propose(
    id: LoginEntryId,
    proposal: LoginRecipeProposal,
  ): Promise<{ readonly applied: boolean; readonly dropped: readonly LoginRecipeProposal[] }> {
    return await this.lock.run(async () => {
      const index = await this.documents.readIndex();
      const record = index.entries[id];
      if (record === undefined) throw new LoginEntryError('unknown_login', `there is no saved login ${id}`);
      if (record.autoApplyRecipe === true) {
        const applied: LoginRecord = {
          ...record,
          recipe: proposal.recipe,
          recipeBy: 'ferret',
          updatedAt: this.clock.now(),
        };
        await this.documents.index.write({ ...index, entries: { ...index.entries, [id]: applied } });
        return { applied: true, dropped: [] };
      }
      const waiting = [...(record.proposals ?? []), proposal];
      const dropped = waiting.slice(0, Math.max(0, waiting.length - LOGIN_RECIPE_PROPOSALS_MAX));
      const proposals = waiting.slice(-LOGIN_RECIPE_PROPOSALS_MAX);
      await this.documents.index.write({ ...index, entries: { ...index.entries, [id]: { ...record, proposals } } });
      return { applied: false, dropped };
    });
  }

  /** Remembers the agenda card a proposal was raised on, so settling it closes that card. */
  async proposalCard(id: LoginEntryId, proposalId: string, agendaItemId: string): Promise<void> {
    await this.lock.run(async () => {
      const index = await this.documents.readIndex();
      const record = index.entries[id];
      if (record?.proposals?.some(proposal => proposal.id === proposalId) !== true) return;
      const proposals = record.proposals.map(proposal =>
        proposal.id === proposalId ? { ...proposal, agendaItemId } : proposal,
      );
      await this.documents.index.write({ ...index, entries: { ...index.entries, [id]: { ...record, proposals } } });
    });
  }

  /**
   * The owner's answer to a proposal. `approve` makes it the recipe, but only while the recipe is still the one it
   * was proposed against: the owner was shown a diff from THAT text, so approving it over a newer edit would undo
   * the edit unseen (`stale_proposal`; decline it, or edit the recipe by hand). Either answer removes it.
   */
  async decide(
    id: LoginEntryId,
    proposalId: string,
    decision: 'approve' | 'decline',
  ): Promise<{ readonly entry: LoginEntrySummary; readonly proposal: LoginRecipeProposal }> {
    return await this.lock.run(async () => {
      const index = await this.documents.readIndex();
      const record = index.entries[id];
      if (record === undefined) throw new LoginEntryError('unknown_login', `there is no saved login ${id}`);
      const proposal = record.proposals?.find(waiting => waiting.id === proposalId);
      if (proposal === undefined)
        throw new LoginEntryError(
          'unknown_proposal',
          `${id} has no recipe proposal ${proposalId}; it was answered or replaced`,
        );
      if (decision === 'approve' && record.recipe !== proposal.base)
        throw new LoginEntryError(
          'stale_proposal',
          `the recipe of ${id} changed after this proposal was made; decline it, or edit the recipe yourself`,
        );
      const proposals = (record.proposals ?? []).filter(waiting => waiting.id !== proposalId);
      const { proposals: _old, recipeBy, ...rest } = record;
      const next: LoginRecord = {
        ...rest,
        ...(proposals.length === 0 ? {} : { proposals }),
        // An approved recipe is the owner's: whoever wrote it before, a person has now read it.
        ...(decision === 'approve'
          ? { recipe: proposal.recipe, updatedAt: this.clock.now() }
          : recipeBy === undefined
            ? {}
            : { recipeBy }),
      };
      await this.documents.index.write({ ...index, entries: { ...index.entries, [id]: next } });
      return { entry: summary(id, next), proposal };
    });
  }

  /** A new handle for an entry. Its sealed values stay where they are, filed under the entry's key. */
  async rename(from: LoginEntryId, to: LoginEntryId): Promise<LoginEntrySummary> {
    return await this.lock.run(async () => await this.move(from, to));
  }

  private async move(from: LoginEntryId, to: LoginEntryId): Promise<LoginEntrySummary> {
    const index = await this.documents.readIndex();
    const record = index.entries[from];
    if (record === undefined) throw new LoginEntryError('unknown_login', `there is no saved login ${from}`);
    if (from === to) return summary(to, record);
    if (index.entries[to] !== undefined)
      throw new LoginEntryError('login_exists', `${to} is already a saved login; pick another name`);
    const { [from]: _moved, ...rest } = index.entries;
    const renamed = { ...record, updatedAt: this.clock.now() };
    await this.documents.index.write({ ...index, entries: { ...repointed(rest, from, to), [to]: renamed } });
    return summary(to, renamed);
  }

  /**
   * Removes an entry: the index first (the commit), so it is gone at once, then a sweep of what nothing points at.
   * A failure of the sweep leaves sealed values no entry names, which are still masked and never typed.
   */
  async remove(id: LoginEntryId): Promise<boolean> {
    return await this.lock.run(async () => await this.drop(id));
  }

  private async drop(id: LoginEntryId): Promise<boolean> {
    const index = await this.documents.readIndex();
    const record = index.entries[id];
    if (record === undefined) return false;
    const { [id]: _removed, ...rest } = index.entries;
    const committed: LoginIndexDocument = { ...index, entries: repointed(rest, id, undefined) };
    await this.documents.index.write(committed);
    await this.sweep(
      committed,
      await this.documents.readSealed().catch(() => ({ v: 1 as const, cipher: '', entries: {} })),
    );
    return true;
  }
}

/**
 * A method that goes VIA another saved login names one that exists, and not itself: a dangling or circular link
 * would send the ferret to a provider page nothing can fill.
 */
function checkVia(id: LoginEntryId, method: LoginMethod | undefined, index: LoginIndexDocument): void {
  const via = method?.via;
  if (via === undefined) return;
  if (via === id)
    throw new LoginEntryError('bad_via', `${id} cannot sign in via itself; pick the provider's saved login`);
  if (index.entries[via] === undefined)
    throw new LoginEntryError(
      'bad_via',
      `there is no saved login ${via} to sign in via; save the provider's login first`,
    );
  // Follow the provider's own links: one that leads back here would send the ferret round in a circle.
  const seen = new Set<string>([id]);
  for (let next: string | undefined = via; next !== undefined; next = index.entries[next]?.method?.via) {
    if (seen.has(next))
      throw new LoginEntryError(
        'bad_via',
        `${id} via ${via} leads back to ${next}; a provider cannot go via a site that uses it`,
      );
    seen.add(next);
  }
}

/**
 * Every OTHER entry whose method goes via `from`, pointed at `to` (a rename), or no longer via anything (a
 * delete). Only the link changes; nothing sealed is touched.
 */
function repointed(
  entries: Readonly<Record<string, LoginRecord>>,
  from: string,
  to: string | undefined,
): Record<string, LoginRecord> {
  return Object.fromEntries(
    Object.entries(entries).map(([handle, record]) => {
      // A recipe that names `[[from]]` names the renamed login; after a delete the name stays, and reads as missing.
      const named =
        to === undefined || record.recipe === undefined
          ? record
          : { ...record, recipe: recipeRenamed(record.recipe, from, to) };
      if (named.method?.via !== from) return [handle, named];
      const { via: _gone, ...method } = named.method;
      return [handle, { ...named, method: to === undefined ? method : { ...method, via: to } }];
    }),
  );
}

function nextRecord(
  existing: LoginRecord | undefined,
  key: string,
  change: PutLoginEntry,
  at: string,
  seals: LoginRecord['seals'],
): LoginRecord {
  const username = change.username === undefined ? existing?.username : (change.username ?? undefined);
  const method = change.method ?? existing?.method;
  const domains = change.domains ?? existing?.domains;
  const recipe = change.recipe === undefined ? existing?.recipe : (change.recipe ?? undefined);
  // An owner's own edit makes the recipe theirs; anything else keeps who wrote it.
  const recipeBy = change.recipe === undefined ? existing?.recipeBy : undefined;
  const autoApply = change.autoApplyRecipe ?? existing?.autoApplyRecipe === true;
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
    ...(method === undefined ? {} : { method }),
    ...(domains === undefined ? {} : { domains: [...new Set(domains)] }),
    ...(username === undefined ? {} : { username }),
    seals,
    ...(totp === undefined || seals.totp === undefined ? {} : { totp }),
    ...(recipe === undefined ? {} : { recipe }),
    ...(recipe === undefined || recipeBy === undefined ? {} : { recipeBy }),
    ...(autoApply ? { autoApplyRecipe: true as const } : {}),
    ...(existing?.observed === undefined ? {} : { observed: existing.observed }),
    ...(existing?.proposals === undefined ? {} : { proposals: existing.proposals }),
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
        const name = record.seals[role];
        if (name === undefined) continue;
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
    const name = record.seals[role];
    if (name === undefined || (role === 'totp' && record.totp === undefined))
      throw new LoginEntryError(
        'no_such_field',
        `${record.label} has no ${role === 'password' ? 'password' : '2FA seed'} saved`,
      );
    const sealed = await this.documents.readSealed();
    const entry = sealed.entries[name];
    if (entry === undefined) throw new LoginEntryError('no_such_field', `${record.label} has lost its ${role}`);
    const value = (await this.documents.cipher.openAll({ [name]: entry })).get(name);
    if (value === undefined) throw new LoginEntryError('no_such_field', `${record.label} has lost its ${role}`);
    if (role === 'password') return value;
    const code = totpCode(value, record.totp as TotpParameters, nowMs);
    if (code === undefined)
      throw new LoginEntryError('no_such_field', `${record.label} has a 2FA seed that is not base32`);
    return code;
  }
}
