/**
 * The account model's credentials, as this daemon serves them (docs/design/account-model.md §3.2, §7,
 * §8.1.2, §8.2.2, §9.4): every login on this machine with its status, its usage, the runtimes that use
 * it and what signing it out would do — plus the explicit **Check now**, the sign-in a credential with
 * no runtime yet needs, and the sign-out a reviewed change runs.
 *
 * ## Status and usage only
 *
 * Nothing here holds a credential. Status comes from `CredentialStatusService` (fleet), which reduces
 * every read to a word, a closed-set reason and some instants; usage is two percentages and their
 * reset times. The wire shapes in `@ferretry/protocol` are strict and carry no field a token or a
 * digest could occupy, and every answer is parsed through them on the way out.
 *
 * ## Zero unattended spend
 *
 * - {@link FleetCredentialsService.list} reads what is already known: the local store and the last
 *   heads. It makes no network call.
 * - {@link FleetCredentialsService.observeAll} rides the EXISTING usage pass. It is the passive
 *   reading, then — only when that is older than the pass interval — the one free usage read. Never a
 *   refresh, never a harness launch.
 * - {@link FleetCredentialsService.check} is the ONLY thing that may refresh a Codex credential, and
 *   only because a person pressed Check now.
 * - A sign-in or a sign-out launches the harness, and only on an explicit request.
 *
 * ## One document, either version
 *
 * The machine's `config.yaml` is read through `readFleetDocument`. A version-2 document names its
 * credentials and their stores directly. A version-1 document is read through the in-memory conversion
 * (§10.4): each credential is one old `<kind>:<identity>` group, and until the machine is migrated its
 * login still lives as a COPY in each runtime's own directory. So a version-1 credential is read from
 * the FRESHEST copy its runtimes hold, and two acts are refused on it in words:
 *
 * - **Check now on a Codex group with more than one copy.** A Codex refresh spends a single-use token;
 *   refreshing one copy would sign every other copy out (§9.1).
 * - **Sign-out.** It would sign out one copy and leave the others signed in.
 *
 * A version-1 sign-in goes through the existing account flow, which already walks the whole group.
 */
import {
  type AccountModel,
  type CodexStoreResolution,
  CREDENTIAL_STATUS_LABELS,
  type ClaudeStoreResolution,
  CLAUDE_SECURE_STORAGE_VARIABLE,
  CODEX_CREDENTIAL_FILE,
  CODEX_CREDENTIAL_STORE_FILE,
  CODEX_CREDENTIAL_STORE_KEY,
  type Credential,
  type CredentialStatusReason,
  type CredentialStatusView,
  type CredentialStoreResolution,
  type CredentialStorePaths,
  type CredentialSubject,
  type CredentialUsage,
  type FleetDocument,
  type FleetManifest,
  type FleetUsageWindow,
  type HarnessKind,
  HOST_CLAUDE_SECURE_STORAGE,
  type LocalCredentialReading,
  type PassiveUsageRecord,
  resolveCredentialStore,
  type StoredCredentialResolution,
} from '@ferretry/fleet';
import {
  type FleetCredentialAct,
  type FleetCredentialCheckRequest,
  type FleetCredentialList,
  FleetCredentialListSchema,
  type FleetCredentialSignOut,
  type FleetCredentialUsageWindow,
  type FleetCredentialView,
  FleetCredentialViewSchema,
} from '@ferretry/protocol';
import { dirname, join } from 'node:path';
import type { CallerGovernance, ChangeConfirmation } from '../api/capability.ts';

// ── Refusals ─────────────────────────────────────────────────────────────────────────────────────

export type FleetCredentialRefusalCode =
  | 'fleet_credential_unknown'
  | 'fleet_credential_unavailable'
  | 'fleet_credential_unauthorized'
  | 'fleet_credentials_unreadable';

/** Every refusal this surface answers with, so a client branches on cause rather than on prose. */
export class FleetCredentialRefusal extends Error {
  constructor(
    readonly code: FleetCredentialRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'FleetCredentialRefusal';
  }
}

// ── Ports ────────────────────────────────────────────────────────────────────────────────────────

/** What the status service offers, narrowed to the three calls this surface makes. */
export interface CredentialStatusReader {
  view(subject: CredentialSubject): Promise<CredentialStatusView>;
  observe(subject: CredentialSubject): Promise<CredentialStatusView>;
  checkNow(subject: CredentialSubject): Promise<CredentialStatusView>;
}

/** Where a credential's display email is recorded. A file the harness writes, or its Codex store. */
export type CredentialEmailSource =
  | { readonly harness: 'claude'; readonly accountFile: string }
  | { readonly harness: 'codex'; readonly resolution: CodexStoreResolution };

/** One harness child the daemon starts for a sign-out, and the code it ended with. */
export interface CredentialHarnessRun {
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface FleetCredentialCatalogDeps {
  /** The machine's fleet document, or `undefined` when there is no fleet yet. */
  document(): Promise<FleetDocument | undefined>;
  /** The published manifest: where a version-1 group's copies live. */
  manifest(): Promise<Pick<FleetManifest, 'accounts'>>;
  readonly paths: CredentialStorePaths;
  /** The local classification of one store. Never material. */
  classify(resolution: StoredCredentialResolution): Promise<LocalCredentialReading>;
  /** Creates a directory a sign-in writes into (0700). */
  ensureDirectory(path: string): Promise<void>;
}

// ── The catalog: which credentials exist and where each one's login lives ───────────────────────

/** One credential, resolved against this machine. */
export interface CredentialEntry {
  readonly id: string;
  readonly format: 1 | 2;
  readonly credential: Credential;
  readonly resolution: CredentialStoreResolution;
  /** The runtimes that use it, by name, sorted. */
  readonly usedBy: readonly string[];
  /** Version 1: the directories that hold a copy of this login. Version 2: none (one store). */
  readonly copies: readonly string[];
  /** Version 1: the account a sign-in for this group goes through. */
  readonly signInAccount?: string;
}

/** The isolated config directory a Claude `store: ferretry` sign-in runs with, inside its store. */
const CREDENTIAL_SIGN_IN_DIRECTORY = 'sign-in';

/** The file Claude records the signed-in account in, inside a config directory. */
const CLAUDE_ACCOUNT_FILE = '.claude.json';

const usable = (reading: LocalCredentialReading): boolean =>
  reading.state === 'valid' || reading.state === 'refreshable';

/** A version-1 copy, read as a store: the old directory IS the store Claude or Codex reads it from. */
function legacyResolution(harness: HarnessKind, home: string): StoredCredentialResolution {
  return harness === 'claude'
    ? {
        harness: 'claude',
        store: 'ferretry',
        // The keychain item a v1 copy lives under is named from its config directory, which is
        // exactly how a secure-storage value names one (`keychainService(home)`).
        secureStorage: home,
        storageDirectory: home,
        credentialFile: join(home, '.credentials.json'),
      }
    : { harness: 'codex', store: 'ferretry', canonicalFile: join(home, CODEX_CREDENTIAL_FILE) };
}

/**
 * The machine's credentials, read from its fleet document on every call.
 *
 * Read fresh because every fact here can change while the daemon runs — a reviewed change adds a
 * credential, a sign-in fills a slot — and a list that answered from boot would be confidently wrong
 * for exactly the person who just changed it.
 */
export class FleetCredentialCatalog {
  constructor(private readonly deps: FleetCredentialCatalogDeps) {}

  async entries(): Promise<{ readonly format: 1 | 2; readonly entries: readonly CredentialEntry[] }> {
    let document: FleetDocument | undefined;
    try {
      document = await this.deps.document();
    } catch (error) {
      throw new FleetCredentialRefusal(
        'fleet_credentials_unreadable',
        `this machine's fleet configuration could not be read, so its logins cannot be listed: ${
          error instanceof Error && error.message.length > 0 ? error.message : 'unreadable'
        }`,
      );
    }
    if (document === undefined) return { format: 2, entries: [] };
    if (document.version === 2) return { format: 2, entries: this.#modelEntries(document.model) };
    return { format: 1, entries: await this.#legacyEntries(document) };
  }

  /** One credential, or a refusal naming the id. */
  async entry(id: string): Promise<CredentialEntry> {
    const found = (await this.entries()).entries.find(entry => entry.id === id);
    if (found === undefined) {
      throw new FleetCredentialRefusal('fleet_credential_unknown', `no login "${id}" exists on this machine`);
    }
    return found;
  }

  #modelEntries(model: AccountModel): readonly CredentialEntry[] {
    return Object.entries(model.credentials).map(([id, credential]) => ({
      id,
      format: 2,
      credential,
      resolution: resolveCredentialStore(id, credential, this.deps.paths),
      usedBy: Object.entries(model.runtimes)
        .filter(([, runtime]) => runtime.credential === id)
        .map(([name]) => name)
        .sort(),
      copies: [],
    }));
  }

  async #legacyEntries(document: Extract<FleetDocument, { version: 1 }>): Promise<readonly CredentialEntry[]> {
    const manifest = await this.deps.manifest().catch((): Pick<FleetManifest, 'accounts'> => ({ accounts: [] }));
    const homes = new Map(manifest.accounts.map(account => [account.id, account] as const));
    const { conversion } = document;
    const entries: CredentialEntry[] = [];
    for (const [id, credential] of Object.entries(conversion.model.credentials)) {
      const origin = conversion.credentials[id];
      const usedBy = Object.entries(conversion.runtimes)
        .filter(([, runtime]) => origin?.routeIds.includes(runtime.routeId) === true)
        .map(([name]) => name)
        .sort();
      if (credential.store === 'environment') {
        entries.push({
          id,
          format: 1,
          credential,
          resolution: resolveCredentialStore(id, credential, this.deps.paths),
          usedBy,
          copies: [],
        });
        continue;
      }
      const members = (origin?.routeIds ?? []).flatMap(routeId => {
        const account = homes.get(routeId);
        return account === undefined ? [] : [account];
      });
      const copies = members.map(member => member.home);
      const freshest = await this.#freshest(credential.harness, copies);
      const signInAccount = (members.find(member => member.available) ?? members[0])?.id;
      entries.push({
        id,
        format: 1,
        credential,
        resolution:
          freshest === undefined
            ? resolveCredentialStore(id, credential, this.deps.paths)
            : legacyResolution(credential.harness, freshest),
        usedBy,
        copies,
        ...(signInAccount === undefined ? {} : { signInAccount }),
      });
    }
    return entries;
  }

  /** The copy whose login is usable and expires last; else the first copy; else none (§10.2.1). */
  async #freshest(harness: HarnessKind, copies: readonly string[]): Promise<string | undefined> {
    let best: { readonly home: string; readonly expiresAt: number } | undefined;
    for (const home of copies) {
      const reading = await this.deps
        .classify(legacyResolution(harness, home))
        .catch((): LocalCredentialReading => ({ state: 'unreadable' }));
      if (!usable(reading)) continue;
      const expiresAt = reading.expiresAt ?? 0;
      if (best === undefined || expiresAt > best.expiresAt) best = { home, expiresAt };
    }
    return best?.home ?? copies[0];
  }

  /** Where the harness recorded this login's email, for display. */
  emailSource(entry: CredentialEntry): CredentialEmailSource | undefined {
    const resolution = stored(entry.resolution);
    if (resolution === undefined) return undefined;
    if (resolution.harness === 'codex') return { harness: 'codex', resolution };
    if (entry.format === 1)
      return { harness: 'claude', accountFile: join(resolution.storageDirectory, CLAUDE_ACCOUNT_FILE) };
    return {
      harness: 'claude',
      accountFile:
        resolution.ownedDirectory === undefined
          ? join(this.deps.paths.userHome, CLAUDE_ACCOUNT_FILE)
          : join(resolution.ownedDirectory, CREDENTIAL_SIGN_IN_DIRECTORY, CLAUDE_ACCOUNT_FILE),
    };
  }

  /**
   * What a sign-in for this credential launches, or why there is none.
   *
   * Version 1 signs in through the account flow (which walks the whole group). Version 2 launches the
   * harness's own login with the credential's STORE in its environment, so a slot no runtime uses yet
   * can be signed in (E12, E31):
   *
   * - Claude `ferretry`: `CLAUDE_SECURESTORAGE_CONFIG_DIR=<store>` and an isolated `CLAUDE_CONFIG_DIR`
   *   inside it, so the account file lands beside the login rather than in the person's own config.
   * - Claude `host`: the empty secure-storage value and NO config directory — exactly the person's own
   *   `claude auth login`, because that is the login being signed in.
   * - Codex: `CODEX_HOME` is the directory of the canonical `auth.json`, with file storage forced, so
   *   the one file every runtime links to is the one written.
   *
   * The real `HOME` is never touched: on macOS the keychain is found through it (measured).
   */
  signInTarget(entry: CredentialEntry): CredentialSignInTarget {
    if (entry.format === 1) {
      if (entry.credential.store === 'environment') return refusedSignIn(entry, environmentReason(entry));
      return entry.signInAccount === undefined
        ? refusedSignIn(
            entry,
            'no runtime that uses this login is published on this machine, so there is nothing to sign in through',
          )
        : { kind: 'account', credentialId: entry.id, accountId: entry.signInAccount };
    }
    const resolution = entry.resolution;
    if (resolution.store === 'environment') return refusedSignIn(entry, environmentReason(entry));
    if ('unavailable' in resolution) return refusedSignIn(entry, resolution.unavailable);
    const classify = this.deps.classify;
    const signedIn = async (): Promise<boolean> =>
      usable(await classify(resolution).catch((): LocalCredentialReading => ({ state: 'unreadable' })));
    const launch = credentialLaunch(resolution);
    const ensure = this.deps.ensureDirectory;
    return {
      kind: 'store',
      credentialId: entry.id,
      harness: resolution.harness,
      environment: launch.environment,
      arguments: launch.arguments,
      prepare: async () => {
        for (const directory of launch.directories) await ensure(directory);
      },
      signedIn,
    };
  }
}

/** What a sign-in by credential id resolves to. */
export type CredentialSignInTarget =
  | { readonly kind: 'account'; readonly credentialId: string; readonly accountId: string }
  | {
      readonly kind: 'store';
      readonly credentialId: string;
      readonly harness: HarnessKind;
      /** Set on top of the sanitized environment. Names a store, never a credential value. */
      readonly environment: Readonly<Record<string, string>>;
      /** Arguments that go BEFORE the harness's own login arguments. */
      readonly arguments: readonly string[];
      /** Creates the directories the login writes into. */
      prepare(): Promise<void>;
      /** Whether the store now holds a usable login. */
      signedIn(): Promise<boolean>;
    }
  | { readonly kind: 'refused'; readonly credentialId: string; readonly reason: string };

const refusedSignIn = (entry: CredentialEntry, reason: string): CredentialSignInTarget => ({
  kind: 'refused',
  credentialId: entry.id,
  reason,
});

const environmentReason = (entry: CredentialEntry): string =>
  `"${entry.id}" is authenticated by its environment variables, so there is nothing to sign in to`;

/** The environment, arguments and directories a harness launch against this store needs. */
export function credentialLaunch(resolution: StoredCredentialResolution): {
  readonly environment: Readonly<Record<string, string>>;
  readonly arguments: readonly string[];
  readonly directories: readonly string[];
} {
  if (resolution.harness === 'claude') return claudeLaunch(resolution);
  const home = dirname(resolution.canonicalFile);
  return {
    environment: { CODEX_HOME: home },
    arguments: ['-c', `${CODEX_CREDENTIAL_STORE_KEY}="${CODEX_CREDENTIAL_STORE_FILE}"`],
    directories: resolution.ownedDirectory === undefined ? [] : [resolution.ownedDirectory],
  };
}

function claudeLaunch(resolution: ClaudeStoreResolution): {
  readonly environment: Readonly<Record<string, string>>;
  readonly arguments: readonly string[];
  readonly directories: readonly string[];
} {
  if (resolution.ownedDirectory === undefined) {
    return {
      environment: { [CLAUDE_SECURE_STORAGE_VARIABLE]: HOST_CLAUDE_SECURE_STORAGE },
      arguments: [],
      directories: [],
    };
  }
  const config = join(resolution.ownedDirectory, CREDENTIAL_SIGN_IN_DIRECTORY);
  return {
    environment: { [CLAUDE_SECURE_STORAGE_VARIABLE]: resolution.secureStorage, CLAUDE_CONFIG_DIR: config },
    arguments: [],
    directories: [resolution.ownedDirectory, config],
  };
}

/** The resolution, when it names a store a login can be read from. */
function stored(resolution: CredentialStoreResolution): StoredCredentialResolution | undefined {
  if (resolution.store === 'environment' || 'unavailable' in resolution) return undefined;
  return resolution;
}

// ── The words a surface shows ────────────────────────────────────────────────────────────────────

/** One plain sentence per reason. The daemon owns the code; this is the sentence that goes with it. */
const REASON_SENTENCES: Readonly<Record<CredentialStatusReason, string>> = {
  provider_accepted: 'The provider accepted this login on its last check.',
  usage_scope_unavailable: 'The provider accepted this login. Its usage cannot be read with this kind of login.',
  passive_usage_seen: 'A recent session on this login reported its usage, so the login works.',
  access_current: 'This login is current.',
  refresh_accepted: 'This login was renewed successfully.',
  not_checked_yet: 'This login is present and current. Nothing has checked it with the provider yet.',
  api_key: 'This login uses an API key, so there is nothing to renew.',
  from_environment: 'This login comes from environment variables, so there is no sign-in to check.',
  credential_unreadable: 'This login could not be read just now. Nothing is wrong with it as far as anyone knows.',
  access_expired_refreshable: 'The access token has expired. It renews itself the next time it is used.',
  access_expiring: 'The access token expires within five minutes. It renews the next time it is used.',
  last_refresh_old: 'This login has not been renewed for over eight days. It renews the next time it is used.',
  not_signed_in: 'Nothing is signed in here yet.',
  access_expired_no_refresh: 'The access token has expired and cannot renew itself. Sign in again.',
  provider_rejected: 'The provider rejected this login. Sign in again.',
  refresh_expired: 'This login expired. Sign in again.',
  refresh_revoked: 'This login was signed out somewhere else, or replaced. Sign in again.',
  refresh_rejected: 'The provider refused to renew this login. Sign in again.',
  store_unreachable: 'This login cannot be reached on this machine.',
  check_in_flight: 'A check is running now.',
};

const instant = (milliseconds: number): string => new Date(Math.trunc(milliseconds)).toISOString();

function windowOf(window: FleetUsageWindow): FleetCredentialUsageWindow {
  return {
    ...(window.usedPercent === undefined ? {} : { usedPercent: window.usedPercent }),
    ...(window.resetAt === undefined ? {} : { resetsAt: instant(window.resetAt) }),
  };
}

function usageOf(usage: CredentialUsage): FleetCredentialView['usage'] {
  return {
    fiveHour: windowOf(usage.fiveHour),
    weekly: windowOf(usage.weekly),
    ...(usage.source === undefined ? {} : { source: usage.source }),
    ...(usage.at === undefined ? {} : { at: instant(usage.at) }),
  };
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** Who a sentence names: the email and label, or whichever one there is, or the id. */
function whoOf(entry: CredentialEntry, email: string | undefined): string {
  const label = entry.credential.label;
  if (email !== undefined) return label === undefined ? email : `${email} (${label})`;
  return label ?? entry.id;
}

/** The sign-out confirm card's question, its consequences included (C7, E25). */
export function signOutSentence(
  entry: CredentialEntry,
  email: string | undefined,
  machine: string,
): FleetCredentialSignOut {
  const host = entry.credential.store === 'host';
  const runtimes = entry.usedBy.length;
  const terminal = host ? ` This also signs out ${entry.credential.harness} in your terminal on ${machine}.` : '';
  const consequence =
    runtimes === 0 ? ' No runtime uses it.' : ` ${plural(runtimes, 'runtime', 'runtimes')} will need sign-in.`;
  return {
    available: signOutRefusal(entry) === undefined,
    sentence: `Sign out of ${whoOf(entry, email)}?${terminal}${consequence}`,
    runtimesAffected: runtimes,
    signsOutTerminal: host,
  };
}

/** Why this credential cannot be signed out here, or nothing when it can. */
function signOutRefusal(entry: CredentialEntry): string | undefined {
  if (entry.credential.store === 'environment') return environmentReason(entry).replace('sign in to', 'sign out of');
  if (stored(entry.resolution) === undefined) return 'this login cannot be reached on this machine';
  if (entry.format === 1) {
    return 'this machine still uses the old account format, where each runtime keeps its own copy of this login, so signing out here would leave the other copies signed in; migrate this machine first';
  }
  return undefined;
}

/** Whether a person may press Check now on this credential, and why not when they may not. */
function checkAct(entry: CredentialEntry): FleetCredentialAct {
  if (entry.credential.store === 'environment') {
    return { available: false, reason: 'This login comes from environment variables, so there is nothing to check.' };
  }
  const resolution = entry.resolution;
  if ('unavailable' in resolution) return { available: false, reason: resolution.unavailable };
  if (entry.format === 1 && entry.credential.harness === 'codex' && entry.copies.length > 1) {
    return {
      available: false,
      reason: `This machine still uses the old account format, where ${plural(entry.copies.length, 'runtime keeps', 'runtimes each keep')} a copy of this login. Checking it renews one copy and signs the others out, so migrate this machine first.`,
    };
  }
  return { available: true };
}

function signInAct(target: CredentialSignInTarget): FleetCredentialAct {
  return target.kind === 'refused' ? { available: false, reason: sentence(target.reason) } : { available: true };
}

/** A clause as a sentence: capitalised and full-stopped. */
const sentence = (clause: string): string =>
  `${clause.charAt(0).toUpperCase()}${clause.slice(1)}${clause.endsWith('.') ? '' : '.'}`;

// ── The service ──────────────────────────────────────────────────────────────────────────────────

export interface FleetCredentialsServiceDeps {
  readonly catalog: FleetCredentialCatalog;
  readonly status: CredentialStatusReader;
  /** The display email of one login, when the harness recorded one. */
  email(source: CredentialEmailSource): Promise<string | undefined>;
  /** Proves the operator password for ONE change: the same closure every confirmed act takes. */
  confirmChange(password: string): Promise<ChangeConfirmation>;
  /** This machine's name, as the sign-out sentence says it. */
  machineName(): string;
  /** What a person types to run this binary, so a refusal names a command they have. */
  readonly clientName: string;
  /** The harness command, located by this daemon's one rule. `undefined` when it is not installed. */
  locate(harness: HarnessKind): string | undefined;
  /** Runs one harness child to completion; the exit code. */
  run(spec: CredentialHarnessRun): Promise<number>;
  /** The environment a harness child starts from, already sanitized of inherited provider state. */
  baseEnvironment(): Readonly<Record<string, string | undefined>>;
}

/** The harness's own sign-out arguments. Neither touches a model. */
const LOGOUT_ARGV: Readonly<Record<HarnessKind, readonly string[]>> = {
  claude: ['auth', 'logout'],
  codex: ['logout'],
};

export type FleetCredentialSignOutOutcome =
  | { readonly outcome: 'signed-out'; readonly credential: FleetCredentialView }
  | { readonly outcome: 'failed'; readonly reason: string; readonly credential: FleetCredentialView };

export class FleetCredentialsService {
  constructor(private readonly deps: FleetCredentialsServiceDeps) {}

  /** Every credential on this machine, from what is already known. No network, no refresh. */
  async list(): Promise<FleetCredentialList> {
    const { format, entries } = await this.deps.catalog.entries();
    const emails = await this.#emails(entries);
    const credentials: FleetCredentialView[] = [];
    for (const entry of entries) {
      credentials.push(this.#row(entry, await this.deps.status.view(subjectOf(entry)), emails, entries));
    }
    return FleetCredentialListSchema.parse({ format, machine: this.deps.machineName(), credentials });
  }

  /**
   * What the EXISTING usage pass runs: per credential, the passive reading and — only when it is older
   * than the pass interval — the one free usage read. Never a refresh, never a harness launch.
   * Never rejects: a pass that could not read leaves each credential's last known word.
   */
  async observeAll(): Promise<void> {
    let entries: readonly CredentialEntry[];
    try {
      entries = (await this.deps.catalog.entries()).entries;
    } catch {
      return;
    }
    await Promise.allSettled(
      entries
        .filter(entry => stored(entry.resolution) !== undefined)
        .map(entry => this.deps.status.observe(subjectOf(entry))),
    );
  }

  /**
   * A person's **Check now**: for Claude the free usage read, forced; for Codex one refresh under the
   * per-credential lock, then the free read. The only door to a Codex refresh in this daemon.
   *
   * Confirmed against the operator password for a governed caller, exactly as a sign-in is, because
   * a Codex refresh the provider refuses leaves the login needing a person — and every refusal that
   * can be answered from the document is answered BEFORE a password attempt is spent.
   */
  async check(
    id: string,
    request: FleetCredentialCheckRequest,
    governance: CallerGovernance | undefined,
  ): Promise<FleetCredentialView> {
    if (governance === undefined) {
      throw new FleetCredentialRefusal(
        'fleet_credential_unauthorized',
        'this daemon cannot say whether this caller may check this machine’s logins',
      );
    }
    const { entries } = await this.deps.catalog.entries();
    const entry = entries.find(candidate => candidate.id === id);
    if (entry === undefined) {
      throw new FleetCredentialRefusal('fleet_credential_unknown', `no login "${id}" exists on this machine`);
    }
    const act = checkAct(entry);
    if (!act.available) throw new FleetCredentialRefusal('fleet_credential_unavailable', act.reason);
    if (governance.confirmChange) await this.#confirm(id, request.operatorPassword, 'was not checked');
    const view = await this.deps.status.checkNow(subjectOf(entry));
    return this.#row(entry, view, await this.#emails(entries), entries);
  }

  /**
   * Sign one credential out: the harness's own logout against the one store (§9.4), so Claude revokes
   * the refresh token and Codex removes the canonical file. Every runtime on it needs sign-in after.
   *
   * The executor a reviewed `credential.signout` change runs. The change review is what authorizes it;
   * this proves nothing about the caller, and must only be reached from an applied proposal.
   */
  async signOut(id: string): Promise<FleetCredentialSignOutOutcome> {
    const { entries } = await this.deps.catalog.entries();
    const entry = entries.find(candidate => candidate.id === id);
    if (entry === undefined) {
      throw new FleetCredentialRefusal('fleet_credential_unknown', `no login "${id}" exists on this machine`);
    }
    const refusal = signOutRefusal(entry);
    const resolution = stored(entry.resolution);
    if (refusal !== undefined || resolution === undefined) {
      throw new FleetCredentialRefusal(
        'fleet_credential_unavailable',
        sentence(refusal ?? 'this login cannot be reached'),
      );
    }
    const answer = async (): Promise<FleetCredentialView> =>
      this.#row(entry, await this.deps.status.view(subjectOf(entry)), await this.#emails(entries), entries);
    const binary = this.deps.locate(resolution.harness);
    if (binary === undefined) {
      return {
        outcome: 'failed',
        reason: `the ${resolution.harness} command is not installed on this machine, so its login could not be signed out`,
        credential: await answer(),
      };
    }
    const launch = credentialLaunch(resolution);
    const code = await this.deps.run({
      command: [binary, ...launch.arguments, ...LOGOUT_ARGV[resolution.harness]],
      environment: { ...this.deps.baseEnvironment(), ...launch.environment },
    });
    const credential = await answer();
    if (credential.status.word === 'needs_sign_in') return { outcome: 'signed-out', credential };
    return {
      outcome: 'failed',
      reason:
        code === 0
          ? 'the harness said it signed out, but a login is still there'
          : `the harness could not sign out (it exited with code ${code})`,
      credential,
    };
  }

  async #confirm(id: string, password: string | undefined, undone: string): Promise<void> {
    const refuse = (message: string): never => {
      throw new FleetCredentialRefusal('fleet_credential_unauthorized', message);
    };
    if (password === undefined) {
      return refuse(`checking "${id}" from off this machine needs its operator password, entered for this check`);
    }
    const outcome = await this.deps.confirmChange(password);
    if (outcome.kind === 'confirmed') return;
    if (outcome.reason === 'rate-limited') {
      return refuse(
        `too many wrong operator passwords have been tried on this machine, so it is not checking any more of them for now; "${id}" ${undone}. Wait for the lockout to pass, or clear it on the host with \`${this.deps.clientName} daemon password set\`.`,
      );
    }
    if (outcome.reason === 'no-password') {
      return refuse(`this machine has no operator password, so the confirmation for "${id}" could not be checked`);
    }
    return refuse(`that is not this machine's operator password, so "${id}" ${undone}`);
  }

  async #emails(entries: readonly CredentialEntry[]): Promise<ReadonlyMap<string, string>> {
    const found = new Map<string, string>();
    for (const entry of entries) {
      const source = this.deps.catalog.emailSource(entry);
      if (source === undefined) continue;
      const email = await this.deps.email(source).catch(() => undefined);
      if (email !== undefined) found.set(entry.id, email);
    }
    return found;
  }

  #row(
    entry: CredentialEntry,
    view: CredentialStatusView,
    emails: ReadonlyMap<string, string>,
    entries: readonly CredentialEntry[],
  ): FleetCredentialView {
    const email = emails.get(entry.id);
    const status = view.status;
    return FleetCredentialViewSchema.parse({
      id: entry.id,
      harness: entry.credential.harness,
      store: entry.credential.store,
      ...(email === undefined ? {} : { email }),
      ...(entry.credential.label === undefined ? {} : { label: entry.credential.label }),
      needsLabel: needsLabel(entry, email, emails, entries),
      ...(entry.credential.clonedFrom === undefined ? {} : { clonedFrom: entry.credential.clonedFrom }),
      sharedWithTerminal: entry.credential.store === 'host',
      status: {
        word: status.word,
        label: CREDENTIAL_STATUS_LABELS[status.word],
        reason: status.reason,
        explanation: REASON_SENTENCES[status.reason],
        ...(status.since === undefined ? {} : { since: instant(status.since) }),
        ...(status.lastCheckedAt === undefined ? {} : { lastCheckedAt: instant(status.lastCheckedAt) }),
        lastCheckInconclusive: status.lastCheckInconclusive,
        ...(status.planType === undefined ? {} : { planType: status.planType }),
      },
      usage: usageOf(view.usage),
      usedBy: entry.usedBy,
      signIn: signInAct(this.deps.catalog.signInTarget(entry)),
      checkNow: checkAct(entry),
      signOut: signOutSentence(entry, email, this.deps.machineName()),
    });
  }
}

/**
 * Two logins of one harness with one email must be told apart by labels that differ (C9, E26).
 * A login whose email nobody recorded cannot collide with anything.
 */
function needsLabel(
  entry: CredentialEntry,
  email: string | undefined,
  emails: ReadonlyMap<string, string>,
  entries: readonly CredentialEntry[],
): boolean {
  if (email === undefined) return false;
  const label = entry.credential.label;
  return entries.some(
    other =>
      other.id !== entry.id &&
      other.credential.harness === entry.credential.harness &&
      emails.get(other.id) === email &&
      (label === undefined || other.credential.label === label),
  );
}

const subjectOf = (entry: CredentialEntry): CredentialSubject => ({ id: entry.id, resolution: entry.resolution });

// ── Passive usage ────────────────────────────────────────────────────────────────────────────────

/** One session this daemon launched, as usage attribution reads it: who ran it and where it wrote. */
export interface CredentialSessionRecord {
  /** The runtime (or version-1 account) the session was started on. */
  readonly agent: string;
  readonly transcript?: { readonly home: string; readonly file?: string };
}

export interface CredentialPassiveUsageDeps {
  readonly catalog: Pick<FleetCredentialCatalog, 'entry'>;
  /** A Claude credential's statusLine file (`FilePassiveUsageStore.read`). */
  claude(id: string): Promise<PassiveUsageRecord | undefined>;
  /** The sessions this daemon has records for. */
  sessions(): Promise<readonly CredentialSessionRecord[]>;
  /** The newest reading across these rollout files (`newestRolloutRateLimits`). */
  newestRollout(files: readonly string[]): Promise<PassiveUsageRecord | undefined>;
}

/**
 * The transcripts of the sessions that ran on this credential (§8.2.3): a session started on one of
 * its runtimes, or — version 1 — one whose transcript lives in one of its copies. A rollout this
 * daemon did not launch has no record, so it is never attributed: the shared pool mixes credentials.
 */
export function attributedTranscripts(
  entry: Pick<CredentialEntry, 'usedBy' | 'copies'>,
  sessions: readonly CredentialSessionRecord[],
): readonly string[] {
  const files = new Set<string>();
  for (const session of sessions) {
    const file = session.transcript?.file;
    if (file === undefined) continue;
    const home = session.transcript?.home ?? '';
    if (entry.usedBy.includes(session.agent) || entry.copies.includes(home)) files.add(file);
  }
  return [...files].sort();
}

/** The status service's `passiveUsage` port: Claude's statusLine file, or Codex's attributed rollouts. */
export function credentialPassiveUsage(
  deps: CredentialPassiveUsageDeps,
): (subject: CredentialSubject) => Promise<PassiveUsageRecord | undefined> {
  return async subject => {
    if (subject.resolution.harness === 'claude') return await deps.claude(subject.id);
    const entry = await deps.catalog.entry(subject.id);
    const files = attributedTranscripts(entry, await deps.sessions());
    return files.length === 0 ? undefined : await deps.newestRollout(files);
  };
}

// ── The subsystem ────────────────────────────────────────────────────────────────────────────────

/** Builds the credentials subsystem the composition root mounts. */
export function createFleetCredentialsSubsystem(deps: FleetCredentialsServiceDeps): FleetCredentialsService {
  return new FleetCredentialsService(deps);
}
