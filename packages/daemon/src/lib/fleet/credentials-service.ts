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
 * ## One document
 *
 * The machine's configuration files name its credentials and their stores directly. A retired
 * single-file `fleet/config.yaml` is refused as unreadable, with the sentence that says how to set the
 * machine up again.
 */

import { dirname, join } from 'node:path';
import {
  type AccountModel,
  CLAUDE_SECURE_STORAGE_VARIABLE,
  type ClaudeStoreResolution,
  CODEX_CREDENTIAL_STORE_FILE,
  CODEX_CREDENTIAL_STORE_KEY,
  type CodexStoreResolution,
  CREDENTIAL_STATUS_LABELS,
  type Credential,
  type CredentialStatusReason,
  type CredentialStatusView,
  type CredentialStoreInspection,
  type CredentialStorePaths,
  type CredentialStoreResolution,
  type CredentialSubject,
  type CredentialUsage,
  type CredentialViewOptions,
  credentialHarnesses,
  type FleetUsageWindow,
  type HarnessKind,
  HOST_CLAUDE_SECURE_STORAGE,
  type PassiveUsageRecord,
  type ProviderPreset,
  resolveCredentialStore,
  type StoredCredentialResolution,
  storeInspectionWords,
  usableCredentialReading,
} from '@ferretry/fleet';
import {
  type FleetCredentialAct,
  type FleetCredentialList,
  FleetCredentialListSchema,
  type FleetCredentialSignOut,
  type FleetCredentialTestResult,
  type FleetCredentialUsageWindow,
  type FleetCredentialView,
  FleetCredentialViewSchema,
  type FleetProviderPresetCatalog,
  type ProviderQuotaReading,
} from '@ferretry/protocol';
import type { CallerGovernance } from '../api/capability.ts';
import { credentialEnvironmentView } from '../provider-probe/environment-view.ts';
import type { ProviderProbeSubject } from '../provider-probe/service.ts';
import { withProviderQuota } from '../usage/provider-quota/account.ts';

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
  view(subject: CredentialSubject, options?: CredentialViewOptions): Promise<CredentialStatusView>;
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
  /** The machine's account model, or `undefined` when there is no fleet yet. Throws when unreadable. */
  document(): Promise<AccountModel | undefined>;
  readonly paths: CredentialStorePaths;
  /**
   * One store read with its trail — the verdict and every place looked in, never material — so a sign-in
   * that found no usable login can say where it looked and what was there.
   */
  inspect(resolution: StoredCredentialResolution): Promise<CredentialStoreInspection>;
  /** Creates a directory a sign-in writes into (0700). */
  ensureDirectory(path: string): Promise<void>;
}

// ── The catalog: which credentials exist and where each one's login lives ───────────────────────

/** One credential, resolved against this machine. */
export interface CredentialEntry {
  readonly id: string;
  readonly credential: Credential;
  readonly resolution: CredentialStoreResolution;
  /** The runtimes that use it, by name, sorted. */
  readonly usedBy: readonly string[];
}

/** The isolated config directory a Claude `store: ferretry` sign-in runs with, inside its store. */
const CREDENTIAL_SIGN_IN_DIRECTORY = 'sign-in';

/** The file Claude records the signed-in account in, inside a config directory. */
const CLAUDE_ACCOUNT_FILE = '.claude.json';

/**
 * The machine's credentials, read from its fleet document on every call.
 *
 * Read fresh because every fact here can change while the daemon runs — a reviewed change adds a
 * credential, a sign-in fills a slot — and a list that answered from boot would be confidently wrong
 * for exactly the person who just changed it.
 */
export class FleetCredentialCatalog {
  constructor(private readonly deps: FleetCredentialCatalogDeps) {}

  async entries(): Promise<{ readonly format: 2; readonly entries: readonly CredentialEntry[] }> {
    let document: AccountModel | undefined;
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
    return { format: 2, entries: document === undefined ? [] : this.#modelEntries(document) };
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
      credential,
      resolution: resolveCredentialStore(id, credential, this.deps.paths),
      usedBy: Object.entries(model.runtimes)
        .filter(([, runtime]) => runtime.credential === id)
        .map(([name]) => name)
        .sort(),
    }));
  }

  /** Where the harness recorded this login's email, for display. */
  emailSource(entry: CredentialEntry): CredentialEmailSource | undefined {
    const resolution = stored(entry.resolution);
    if (resolution === undefined) return undefined;
    if (resolution.harness === 'codex') return { harness: 'codex', resolution };
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
   * A sign-in launches the harness's own login with the credential's STORE in its environment, so a
   * slot no runtime uses yet can be signed in (E12, E31):
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
    const resolution = entry.resolution;
    if (resolution.store === 'environment') return refusedSignIn(entry, environmentReason(entry));
    if ('unavailable' in resolution) return refusedSignIn(entry, resolution.unavailable);
    const inspect = this.deps.inspect;
    const check = async (): Promise<SignInCheck> => {
      let inspection: CredentialStoreInspection;
      try {
        inspection = await inspect(resolution);
      } catch {
        return { signedIn: false, finding: 'The store this login is kept in could not be read.' };
      }
      return usableCredentialReading(inspection.reading)
        ? { signedIn: true }
        : { signedIn: false, finding: storeInspectionWords(inspection) };
    };
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
      check,
    };
  }
}

/**
 * Whether a sign-in left a usable login in its store — and, when it did not, what looking there found:
 * which places were checked and what each held, in words, never a value.
 */
export type SignInCheck = { readonly signedIn: true } | { readonly signedIn: false; readonly finding: string };

/** What a sign-in by credential id resolves to. */
export type CredentialSignInTarget =
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
      /** Whether the store now holds a usable login, and what was found when it does not. Re-reads every call. */
      check(): Promise<SignInCheck>;
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
  return undefined;
}

/** Whether a person may press Check now on this credential, and why not when they may not. */
function checkAct(entry: CredentialEntry): FleetCredentialAct {
  if (entry.credential.store === 'environment') {
    return { available: false, reason: 'This login comes from environment variables, so there is nothing to check.' };
  }
  const resolution = entry.resolution;
  if ('unavailable' in resolution) return { available: false, reason: resolution.unavailable };
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
  /** This machine's name, as the sign-out sentence says it. */
  machineName(): string;
  /** The harness command, located by this daemon's one rule. `undefined` when it is not installed. */
  locate(harness: HarnessKind): string | undefined;
  /** Runs one harness child to completion; the exit code. */
  run(spec: CredentialHarnessRun): Promise<number>;
  /** The environment a harness child starts from, already sanitized of inherited provider state. */
  baseEnvironment(): Readonly<Record<string, string | undefined>>;
  /**
   * What an environment login's row and its Test need (docs/provider-presets.md): the presets this
   * machine offers, the secret NAMES the store holds (`undefined` when it cannot be listed), and the
   * Test itself. Absent on a daemon that has none, where an environment login shows no variables.
   */
  readonly environment?: CredentialEnvironmentDeps;
  /**
   * An environment login's last provider quota reading (`lib/usage/provider-quota`). A cache read:
   * listing logins never asks a provider anything; whoever is watching asks the reader first.
   */
  readonly providerQuota?: { peek(id: string): ProviderQuotaReading | undefined };
  /**
   * How long one list answers every caller that asks for the same view of the same catalogue. Absent, a
   * list is shared only by the callers that ask while it is being made.
   */
  readonly listCache?: CredentialListCache;
}

/** The list's short keep: a clock, and how long a made list is answered again. */
export interface CredentialListCache {
  now(): number;
  readonly freshMs: number;
}

/**
 * How long the daemon answers a made credentials list again. Short: the list is a view of what is already
 * known and nothing a person does waits on it — a Check now, a sign-out and every usage pass drop it.
 */
export const CREDENTIAL_LIST_FRESH_MS = 2_000;

/** One list, made or being made, and what it was made from. */
interface KeptList {
  readonly key: string;
  readonly list: Promise<FleetCredentialList>;
  /** When it was made; absent while it is being made. */
  at?: number;
}

/** The harness's own sign-out arguments. Neither touches a model. */
const LOGOUT_ARGV: Readonly<Record<HarnessKind, readonly string[]>> = {
  claude: ['auth', 'logout'],
  codex: ['logout'],
};

/** The environment-login half of the credentials surface. */
export interface CredentialEnvironmentDeps {
  /** The catalogue the Add a login flow offers. */
  catalog(): Promise<FleetProviderPresetCatalog>;
  presets(): Promise<readonly ProviderPreset[]>;
  secretNames(): Promise<ReadonlySet<string> | undefined>;
  test(
    subject: ProviderProbeSubject,
    consent: { readonly allowInference: boolean },
  ): Promise<FleetCredentialTestResult>;
}

export type FleetCredentialSignOutOutcome =
  | { readonly outcome: 'signed-out'; readonly credential: FleetCredentialView }
  | { readonly outcome: 'failed'; readonly reason: string; readonly credential: FleetCredentialView };

export class FleetCredentialsService {
  /** The list per view (`settled` or not), shared — see {@link list}. */
  readonly #lists = new Map<string, KeptList>();

  constructor(private readonly deps: FleetCredentialsServiceDeps) {}

  /**
   * Every credential on this machine, from what is already known. No network, no refresh.
   *
   * `settled` is for a reader that caches the list — the usage feed — and answers each credential's
   * last known word instead of "Checking" for one being read right now (see `CredentialViewOptions`).
   * The usage pass reads its credentials while the feed lists them, so without it the pass itself
   * would cache a working login as "not known" for a whole interval.
   *
   * SHARED. Many readers ask for this — the usage feed, the runtime catalogue, a start's readiness check,
   * the logins page — and making it asks every login's status, which for a Codex login reads the session
   * roster. So callers asking for the same view while one is being made share it (single flight), and a
   * made list answers again for {@link CredentialListCache.freshMs} while the catalogue it was made from
   * and every environment login's quota reading are unchanged. A Check now, a sign-out and each usage pass
   * drop it, so nothing a person did is answered from before they did it.
   */
  async list(options: CredentialViewOptions = {}): Promise<FleetCredentialList> {
    const catalog = await this.deps.catalog.entries();
    const view = JSON.stringify(options);
    const key = JSON.stringify([
      catalog,
      catalog.entries.map(entry =>
        entry.credential.store === 'environment' ? (this.deps.providerQuota?.peek(entry.id) ?? null) : null,
      ),
    ]);
    const kept = this.#lists.get(view);
    const cache = this.deps.listCache;
    if (
      kept !== undefined &&
      kept.key === key &&
      (kept.at === undefined || (cache !== undefined && cache.now() - kept.at < cache.freshMs))
    )
      return await kept.list;
    const made: KeptList = { key, list: this.#list(catalog, options) };
    this.#lists.set(view, made);
    try {
      const list = await made.list;
      if (cache === undefined) this.#forgetList(view, made);
      else made.at = cache.now();
      return list;
    } catch (error) {
      this.#forgetList(view, made);
      throw error;
    }
  }

  /** Drops every kept list: what one would say may just have changed. */
  #forgetLists(): void {
    this.#lists.clear();
  }

  #forgetList(view: string, made: KeptList): void {
    if (this.#lists.get(view) === made) this.#lists.delete(view);
  }

  async #list(
    { format, entries }: Awaited<ReturnType<FleetCredentialCatalog['entries']>>,
    options: CredentialViewOptions,
  ): Promise<FleetCredentialList> {
    const emails = await this.#emails(entries);
    const environment = await this.#environmentFacts(entries);
    const credentials: FleetCredentialView[] = [];
    for (const entry of entries) {
      const view = await this.deps.status.view(subjectOf(entry), options);
      credentials.push(this.#row(entry, view, emails, entries, environment));
    }
    return FleetCredentialListSchema.parse({ format, machine: this.deps.machineName(), credentials });
  }

  /**
   * What the EXISTING usage pass runs: per credential, the passive reading and — only when it is older
   * than the pass interval — the one free usage read. Never a refresh, never a harness launch.
   * Never rejects: a pass that could not read leaves each credential's last known word. `ids` limits
   * the pass to the credentials due (the fleet reading's schedule); absent, every stored credential.
   */
  async observeAll(ids?: readonly string[]): Promise<void> {
    let entries: readonly CredentialEntry[];
    try {
      entries = (await this.deps.catalog.entries()).entries;
    } catch {
      return;
    }
    await Promise.allSettled(
      entries
        .filter(entry => stored(entry.resolution) !== undefined && (ids === undefined || ids.includes(entry.id)))
        .map(entry => this.deps.status.observe(subjectOf(entry))),
    );
    this.#forgetLists();
  }

  /**
   * A person's **Check now**: for Claude the free usage read, forced; for Codex one refresh under the
   * per-credential lock, then the free read. The only door to a Codex refresh in this daemon.
   *
   * A governed caller reaches here only with a live passkey step-up, exactly as a sign-in does, because
   * a Codex refresh the provider refuses leaves the login needing a person.
   */
  async check(id: string, governance: CallerGovernance | undefined): Promise<FleetCredentialView> {
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
    const view = await this.deps.status.checkNow(subjectOf(entry)).finally(() => this.#forgetLists());
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
    this.#forgetLists();
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

  /**
   * A person's **Test** of an environment login: one request, the cheapest its provider allows. Governed
   * like Check now — it spends the operator's key — so a caller off this machine needs `fleet.configure`
   * and so a passkey step-up.
   */
  async test(
    id: string,
    consent: { readonly allowInference: boolean },
    governance: CallerGovernance | undefined,
  ): Promise<FleetCredentialTestResult> {
    if (governance === undefined) {
      throw new FleetCredentialRefusal(
        'fleet_credential_unauthorized',
        'this daemon cannot say whether this caller may test this machine’s logins',
      );
    }
    const environment = this.deps.environment;
    const entry = await this.deps.catalog.entry(id);
    if (environment === undefined || entry.credential.store !== 'environment') {
      throw new FleetCredentialRefusal(
        'fleet_credential_unavailable',
        'Only a login made from environment variables has a Test. Use Check now for a sign-in.',
      );
    }
    const presets = await environment.presets();
    const preset =
      entry.credential.preset === undefined ? undefined : presets.find(p => p.id === entry.credential.preset);
    return await environment.test({ id, credential: entry.credential, preset }, consent);
  }

  /** The provider presets this machine offers (docs/provider-presets.md); none on a daemon without them. */
  async presets(): Promise<FleetProviderPresetCatalog> {
    return (await this.deps.environment?.catalog()) ?? { presets: [] };
  }

  /** The presets and secret names every environment row needs, read once per list. */
  async #environmentFacts(entries: readonly CredentialEntry[]): Promise<EnvironmentFacts | undefined> {
    const environment = this.deps.environment;
    if (environment === undefined || !entries.some(entry => entry.credential.store === 'environment')) return undefined;
    return { presets: await environment.presets(), held: await environment.secretNames() };
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
    environment?: EnvironmentFacts,
  ): FleetCredentialView {
    const email = emails.get(entry.id);
    const status = view.status;
    return FleetCredentialViewSchema.parse({
      id: entry.id,
      harness: entry.credential.harness,
      harnesses: [...credentialHarnesses(entry.credential)],
      store: entry.credential.store,
      ...(email === undefined ? {} : { email }),
      ...(entry.credential.label === undefined ? {} : { label: entry.credential.label }),
      needsLabel: needsLabel(entry, email, emails, entries),
      ...(entry.credential.clonedFrom === undefined ? {} : { clonedFrom: entry.credential.clonedFrom }),
      ...(entry.credential.clonedFromDaemon === undefined
        ? {}
        : { clonedFromDaemon: entry.credential.clonedFromDaemon }),
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
      usage: withProviderQuota(
        usageOf(view.usage),
        entry.credential.store === 'environment' ? this.deps.providerQuota?.peek(entry.id) : undefined,
      ),
      usedBy: entry.usedBy,
      signIn: signInAct(this.deps.catalog.signInTarget(entry)),
      checkNow: checkAct(entry),
      signOut: signOutSentence(entry, email, this.deps.machineName()),
      ...(environment === undefined || entry.credential.store !== 'environment'
        ? {}
        : { environment: credentialEnvironmentView(entry.credential, environment.presets, environment.held) }),
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

/** What every environment row of one list reads. */
interface EnvironmentFacts {
  readonly presets: readonly ProviderPreset[];
  readonly held: ReadonlySet<string> | undefined;
}

const subjectOf = (entry: CredentialEntry): CredentialSubject => ({ id: entry.id, resolution: entry.resolution });

// ── Passive usage ────────────────────────────────────────────────────────────────────────────────

/** One session this daemon launched, as usage attribution reads it: who ran it and where it wrote. */
export interface CredentialSessionRecord {
  /** The runtime the session was started on. */
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
 * its runtimes. A rollout this
 * daemon did not launch has no record, so it is never attributed: the shared pool mixes credentials.
 */
export function attributedTranscripts(
  entry: Pick<CredentialEntry, 'usedBy'>,
  sessions: readonly CredentialSessionRecord[],
): readonly string[] {
  const files = new Set<string>();
  for (const session of sessions) {
    const file = session.transcript?.file;
    if (file === undefined) continue;
    if (entry.usedBy.includes(session.agent)) files.add(file);
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
