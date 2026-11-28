/**
 * THE ONE PLACE A RUNTIME IS GIVEN A NAME A PERSON UNDERSTANDS (O9-5).
 *
 * A runtime's stored name is plumbing: a machine-made one reads `claude-you` or `claude-default`, which means nothing to
 * the owner. Every surface that names a runtime or its login calls {@link runtimeDisplayName}, so two screens cannot
 * word one runtime two ways. It is display only: the stored id, name and wrapper are never changed, and nothing is
 * migrated.
 *
 * - **A name the owner chose wins** and is shown as typed. The record says so (`namedByOwner`, set when a person types a
 *   name: `fy runtime add`, a rename, a name given in setup), and that is the whole proof. A record without it is read the
 *   way it always was: machine-made when its name is its login's id (a runtime derived from a ready login) or starts with
 *   its own CLI word and nothing else (`claude-you`, `codex-default-2`). A `claude-work` typed before records said so
 *   still reads that way until it is renamed or re-added; that is the declared limit.
 * - Otherwise it is "<Harness> · <where its sign-in comes from>": the CLI the person already uses in a terminal, a
 *   sign-in made inside Ferretry, or a key or endpoint of a provider.
 * - A label the owner put on the login is appended: `Claude · your terminal sign-in (work)`.
 * - Two that would read the same are told apart by the ACCOUNT (the login's email, else its plan: what the login view
 *   already shows, never a credential), then by profile, then by the runtime's own name.
 *
 * Pure: no filesystem, no clock.
 */
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import { z } from 'zod';
import type { CredentialStore } from './wire/shared.ts';

// Words by harness key, read by lookup so a harness this table does not know still has a name (its own key) and no
// branch here names a harness.
/** The harness as a person says it. */
const HARNESS_WORD: Readonly<Record<string, string>> = { 'claude-code': 'Claude', codex: 'Codex' };

/** The word a machine-made runtime name starts with: the CLI's short name, not the wire harness key. */
const CLI_WORD: Readonly<Record<string, string>> = { 'claude-code': 'claude', codex: 'codex' };

/** Where a ferretry-store sign-in comes from, which is the harness maker's own account. */
const FERRETRY_SIGN_IN: Readonly<Record<string, string>> = {
  'claude-code': 'Claude.ai sign-in',
  codex: 'ChatGPT sign-in',
};

/** A harness as a person says it: "Claude", "Codex". */
export const harnessWord = (harness: HarnessKey): string => HARNESS_WORD[harness] ?? harness;

const cliWordOf = (harness: HarnessKey): string => CLI_WORD[harness] ?? harness;

/** What {@link runtimeDisplayName} reads: the fields `GET /v1/runtimes` already carries. */
export interface RuntimeNameSource {
  /** The stored name (what `--agent` takes). */
  readonly name: string;
  readonly harness: HarnessKey;
  readonly harnessDisplayName?: string;
  /** Set when the owner typed the name: it is shown as typed. Absent: the name's own shape decides. */
  readonly namedByOwner?: true;
  readonly credential: {
    readonly id: string;
    readonly store: CredentialStore;
    /** The owner's own label for the login. */
    readonly label?: string | undefined;
  };
  /** The profile it starts with: the plain word that tells two runtimes on one login apart. */
  readonly profile?: string | undefined;
  /** The login's provider, when it reads a model catalog (`models.catalog.label`). */
  readonly models?: { readonly catalog: { readonly label: string } } | undefined;
}

/** Whether a stored name is one the machine made: not typed by the owner, and its login's id or its own CLI word with plain suffixes. */
export const isMachineMadeRuntimeName = (
  source: Pick<RuntimeNameSource, 'name' | 'harness' | 'credential' | 'namedByOwner'>,
): boolean =>
  source.namedByOwner !== true &&
  (source.name === source.credential.id ||
    new RegExp(`^${cliWordOf(source.harness)}(-[a-z0-9]+)*$`, 'u').test(source.name));

/** Where the sign-in a runtime spends comes from, in plain words. */
const signInSource = (source: RuntimeNameSource): string => {
  switch (source.credential.store) {
    case 'host':
      return 'your terminal sign-in';
    case 'ferretry':
      return FERRETRY_SIGN_IN[source.harness] ?? 'sign-in';
    case 'environment':
      return source.models?.catalog.label ?? 'API key';
  }
};

/** The words for a machine-made runtime's login, before anything tells two runtimes on one login apart. */
const baseName = (source: RuntimeNameSource): string => {
  const label = source.credential.label?.trim();
  const named = `${source.harnessDisplayName ?? harnessWord(source.harness)} · ${signInSource(source)}`;
  return label === undefined || label === '' ? named : `${named} (${label})`;
};

/** What {@link runtimeAccounts} reads of a login: the words its own screen shows for who it is. */
export interface LoginAccountSource {
  readonly id: string;
  readonly email?: string | undefined;
  readonly status: { readonly planType?: string | undefined };
}

/** Who a login is, by login id: the email the harness recorded, else the plan it is on. A login that shows neither is absent. */
export type RuntimeAccounts = ReadonlyMap<string, string>;

const NO_ACCOUNTS: RuntimeAccounts = new Map();

/** Who each login is, in the words its own screen uses. Display only: never a credential. */
export const runtimeAccounts = (logins: readonly LoginAccountSource[]): RuntimeAccounts =>
  new Map(
    logins.flatMap(login => {
      const words = login.email ?? login.status.planType;
      return words === undefined ? [] : [[login.id, words] as const];
    }),
  );

/**
 * The part of `GET /v1/logins` the account words read, and nothing else (a loose object: Logins owns the rest of the
 * shape, and a login this does not understand simply tells nobody apart). A read that does not parse gives no accounts.
 */
const LoginAccountsAnswerSchema = z.looseObject({
  logins: z.array(
    z.looseObject({
      id: z.string(),
      email: z.string().optional(),
      status: z.looseObject({ planType: z.string().optional() }),
    }),
  ),
});

/** The account words out of a `GET /v1/logins` answer; none when it is not one. */
export const runtimeAccountsFrom = (answer: unknown): RuntimeAccounts => {
  const parsed = LoginAccountsAnswerSchema.safeParse(answer);
  return parsed.success ? runtimeAccounts(parsed.data.logins) : NO_ACCOUNTS;
};

/**
 * "Claude · your terminal sign-in", "Codex · ChatGPT sign-in", "Claude · API key", or the owner's own name.
 *
 * `others` is the machine's other runtimes, when the caller has the list (a picker, the Runtimes list). Two machine-made
 * runtimes can read the same (two sign-ins of one kind, or two profiles on one sign-in). Each of them then also says
 * which ACCOUNT it is (`Claude · your terminal sign-in — kirin@example.com`, from `accounts`); when the account does not
 * tell them apart (the same account, or one the login does not show) it says its profile (`— Fast profile`), and its
 * stored name when the profile does not either. A caller with one runtime alone passes none.
 */
export const runtimeDisplayName = (
  source: RuntimeNameSource,
  others: readonly RuntimeNameSource[] = [],
  accounts: RuntimeAccounts = NO_ACCOUNTS,
): string => {
  if (!isMachineMadeRuntimeName(source)) return source.name;
  const base = baseName(source);
  const twins = others.filter(
    other => other.name !== source.name && isMachineMadeRuntimeName(other) && baseName(other) === base,
  );
  if (twins.length === 0) return base;
  const account = accounts.get(source.credential.id);
  if (account !== undefined && twins.every(twin => accounts.get(twin.credential.id) !== account))
    return `${base} — ${account}`;
  const { profile } = source;
  return profile !== undefined && twins.every(twin => twin.profile !== profile)
    ? `${base} — ${profileDisplayName(profile)} profile`
    : `${base} — ${source.name}`;
};

/** What {@link loginDisplayName} reads of a login: the fields `GET /v1/logins` already carries. Never a credential. */
export interface LoginNameSource extends LoginAccountSource {
  readonly harness: HarnessKey;
  readonly store: CredentialStore;
  /** The owner's own label for the login. */
  readonly label?: string | undefined;
  /** An environment login's preset: the provider it is a key for. */
  readonly environment?: { readonly preset?: { readonly label: string } | undefined } | undefined;
}

/** A login read as a runtime made from it, so one set of words names both (a runtime's id is its login's id). */
const loginAsRuntime = (login: LoginNameSource): RuntimeNameSource => ({
  name: login.id,
  harness: login.harness,
  credential: { id: login.id, store: login.store, label: login.label },
  ...(login.environment?.preset === undefined
    ? {}
    : { models: { catalog: { label: login.environment.preset.label } } }),
});

/**
 * A login named the way its runtime is: `Claude · your terminal sign-in`, `Claude · Anthropic (work)`, told apart from
 * its peers by account, never by its stored id. The id stays out of the name; a surface shows it on an "id" line.
 */
export const loginDisplayName = (
  login: LoginNameSource,
  others: readonly LoginNameSource[] = [],
  accounts: RuntimeAccounts = NO_ACCOUNTS,
): string =>
  runtimeDisplayName(
    loginAsRuntime(login),
    others.map(loginAsRuntime),
    accounts.size > 0 ? accounts : runtimeAccounts([login, ...others]),
  );

/**
 * A profile in words. The built-ins carry a plumbing name (`ferretry-codex`, `ferretry-claude-pinned-opus-4`) and so do the
 * two an import makes per tool (`claude-default`, `codex-starter`); a profile the owner made is shown as they named it.
 */
export const profileDisplayName = (name: string): string => {
  const imported = /^(claude|codex)-(default|starter)(?:-(\d+))?$/u.exec(name);
  if (imported?.[1] !== undefined && imported[2] !== undefined) {
    const tool = imported[1] === 'codex' ? 'Codex' : 'Claude';
    const words = imported[2] === 'default' ? `Your ${tool} setup` : `${tool} starter`;
    return imported[3] === undefined ? words : `${words} (${imported[3]})`;
  }
  const standard = /^ferretry-(claude-code|claude|codex)$/u.exec(name);
  if (standard?.[1] !== undefined) return `Ferretry standard for ${standard[1] === 'codex' ? 'Codex' : 'Claude'}`;
  const pinned = /^ferretry-(claude-code|claude|codex)-pinned-(.+)$/u.exec(name);
  return pinned?.[1] === undefined || pinned[2] === undefined
    ? name
    : `Ferretry standard for ${pinned[1] === 'codex' ? 'Codex' : 'Claude'}, pinned to ${pinned[2]}`;
};

/**
 * A model as a person says it: the label its login's model catalog gives that id (`Opus 5.5`), else the id itself (a model
 * the catalog does not list, a custom id). `choices` is the runtime's own catalog choices, when it reads one.
 */
export const modelDisplayName = (
  id: string,
  choices: readonly { readonly id: string; readonly label?: string | undefined }[] = [],
): string => choices.find(choice => choice.id === id)?.label ?? id;

/**
 * What a login in the `ready` state says when the sign-in is the person's own terminal one (`store: host`): Ferretry cannot see
 * that sign-in, so it never calls it "ready", and uses the words onboarding uses (sentence case; a surface that shows it lowercase lowercases it). `undefined` when "ready" is true as it stands.
 */
export const terminalSignInWords = (store: CredentialStore, word: string): string | undefined =>
  store === 'host' && word === 'ready' ? 'Uses your terminal sign-in' : undefined;
