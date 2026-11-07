// GAP(ferrets): no mount point until Ferrets' new-ferret page (ports-pending.json › pendingAppPorts).
// GAP(usage): a hand copy of Usage's contract; it must read Usage's contract when mounted.
/**
 * PURE PROJECTION FOR THE RUNTIME PICKER.
 *
 * `account-picker-catalog.ts` and `account-picker-store.ts` own the daemon reads and their null-vs-empty discipline;
 * this module turns their raw shapes into option records a picker can render and search without re-deriving any of
 * that discipline itself.
 *
 * RUNTIMES. `accountPickerOptions` takes the machine's runtimes, the cached quota feed and the login health map as
 * THREE SEPARATE inputs, because they are three independent reads with three independent failure modes: the runtimes
 * are `GET /v1/runtimes`, quota rides the existing cached usage feed (keyed by wrapper — `UsageAccountView.agent`),
 * and health is each login's status word from `GET /v1/logins`. Options are joined onto each runtime: quota by
 * `wrapper`, health by `credentialId`. A missing quota or health row stays missing on the option (`null`), never a
 * zero or a healthy guess. An unreadable roster projects to `null`; a positively empty one projects to `[]`.
 *
 * NO SILENT DEFAULTS. A blank model stays blank (`normalizedModelSelection` never consults an account's
 * `defaultModel`).
 */

import type { PickerAccount, PickerAccountHealth } from './account-picker-catalog.ts';

/**
 * The cached quota feed's own row, narrowed to what a picker renders. The Usage plugin owns that feed; the caller
 * hands its rows in, so this half names only the fields it reads.
 */
export interface AccountUsageRow {
  readonly agent: string;
  readonly fiveHourPercent?: number;
  readonly weeklyPercent?: number;
  readonly fiveHourResetAt?: number;
  readonly weeklyResetAt?: number;
  readonly atLimit?: boolean;
  readonly authOk?: boolean;
}

export interface AccountPickerOption {
  /** Stable option identity: the runtime's id. */
  readonly key: string;
  /** The value a caller types as `agent` when starting or migrating a session. */
  readonly value: string;
  readonly id: string;
  readonly wrapper: string;
  readonly displayName: string;
  readonly kind: PickerAccount['kind'];
  /** An agent runtime: the only kind the daemon starts a session on. */
  readonly agent: boolean;
  /** The login it uses; its health is that login's status. */
  readonly credentialId: string;
  readonly defaultModel: string | null;
  readonly models: PickerAccount['models'];
  /** The login's model catalog, when it reads one (docs/model-catalog.md). */
  readonly modelCatalog?: PickerAccount['modelCatalog'];
  readonly available: boolean;
  readonly unavailableReason: string | null;
  /** The cached quota row joined by `wrapper`, or `null` when the feed has none. */
  readonly quota: AccountUsageRow | null;
  /** The login's status joined by `credentialId`, or `null` while it is unread. */
  readonly health: PickerAccountHealth | null;
  /** Lowercased haystack: display name, harness, wrapper, default model, declared model ids. */
  readonly searchText: string;
}

/**
 * How a person reads one runtime: its name — the one the Runtimes tab shows —
 * and, beneath it, the wrapper a session is started with.
 *
 * The id is plumbing. It stays reachable because it IS the submitted value and
 * two runtimes can share a display name, but it never leads. When the wrapper is
 * the name, printing it twice adds nothing, so `id` is then `null`. Both halves are wire fields read
 * verbatim: nothing here derives a name from an id's spelling.
 *
 * Every surface that names an offered account — the closed box, each row, the
 * migrate sheet's "current" and "requested" lines — reads this one projection,
 * so no two of them can disagree about which half leads.
 */
export interface AccountLabel {
  readonly name: string;
  readonly id: string | null;
}

export const accountLabel = (account: Pick<AccountPickerOption, 'displayName' | 'wrapper'>): AccountLabel => ({
  name: account.displayName,
  id: account.displayName === account.wrapper ? null : account.wrapper,
});

/**
 * How a person reads the account a SESSION runs on, from the wrapper id its
 * config records (`config.agent`) — the same `accountLabel` the pickers use, so
 * the sessions list, the header and the pickers cannot name one account two ways.
 *
 * A wrapper the roster does not hold — the account was removed, or renamed since
 * the session started — is shown as its id, because that id is then the only
 * true thing left to say. Whether to render anything while the roster is still
 * unread is the caller's decision, not a guess made here.
 */
export const sessionAccountLabel = (accounts: readonly PickerAccount[], agent: string): AccountLabel => {
  const account = accounts.find(candidate => candidate.wrapper === agent);
  return account === undefined ? { name: agent, id: null } : accountLabel(account);
};

const accountSearchText = (account: PickerAccount): string =>
  [
    account.displayName,
    account.kind,
    account.wrapper,
    account.defaultModel ?? '',
    ...account.models.map(model => model.id),
  ]
    .join(' ')
    .toLowerCase();

const accountPickerOption = (
  account: PickerAccount,
  usage: readonly AccountUsageRow[],
  health: ReadonlyMap<string, PickerAccountHealth> | null,
): AccountPickerOption => ({
  key: account.id,
  value: account.wrapper,
  id: account.id,
  wrapper: account.wrapper,
  displayName: account.displayName,
  kind: account.kind,
  agent: account.agent,
  credentialId: account.credentialId,
  defaultModel: account.defaultModel,
  models: account.models,
  ...(account.modelCatalog === undefined ? {} : { modelCatalog: account.modelCatalog }),
  available: account.available,
  unavailableReason: account.unavailableReason,
  quota: usage.find(row => row.agent === account.wrapper) ?? null,
  health: health?.get(account.credentialId) ?? null,
  searchText: accountSearchText(account),
});

/**
 * One option per runtime, in the daemon's own order. `null` when
 * the roster itself could not be read — distinct from a positively empty
 * fleet, which projects to `[]`. Unavailable accounts stay in the list as
 * disabled options carrying their `unavailableReason`; a caller decides how
 * to render that, this projection only refuses to hide it.
 */
export const accountPickerOptions = (
  accounts: readonly PickerAccount[] | null,
  usage: readonly AccountUsageRow[],
  health: ReadonlyMap<string, PickerAccountHealth> | null,
): readonly AccountPickerOption[] | null =>
  accounts === null ? null : accounts.map(account => accountPickerOption(account, usage, health));

/**
 * Narrow to one harness for a migration target, where cross-CLI migration is
 * never offered. An unreadable roster stays unreadable — filtering a `null`
 * roster is still a `null` roster, not an empty list that would read as "no
 * accounts exist".
 */
export const sameHarnessAccountOptions = (
  options: readonly AccountPickerOption[] | null,
  harness: PickerAccount['kind'],
): readonly AccountPickerOption[] | null =>
  options === null ? null : options.filter(option => option.kind === harness);

/**
 * Narrow to the runtimes the daemon can run a session on: its AGENT runtimes. A runtime without the
 * agent flag is the person's own CLI, and offering it only sets up a refusal. Read from the runtime's
 * own `agent` flag — never from the wrapper's spelling. An unreadable roster stays unreadable.
 */
export const sessionCapableAccountOptions = (
  options: readonly AccountPickerOption[] | null,
): readonly AccountPickerOption[] | null => (options === null ? null : options.filter(option => option.agent));

/**
 * The account a new-session form fills in before anybody chooses: the first one
 * offered that the machine says can launch, in the daemon's own order. `null`
 * when nothing offered is usable — the form then leaves the box empty rather than
 * pre-filling a row that would be refused.
 */
export const firstUsableAccountOption = (options: readonly AccountPickerOption[] | null): AccountPickerOption | null =>
  options?.find(option => option.available) ?? null;

/**
 * The runtime a launch hint names (`?agent=<name>`), by wrapper or by runtime name, honoured only
 * when it is offered AND can launch — a hint never pre-fills a row the daemon would refuse.
 */
export const hintedAccountOption = (
  options: readonly AccountPickerOption[] | null,
  hint: string | undefined,
): AccountPickerOption | null =>
  hint === undefined
    ? null
    : (options?.find(option => option.available && (option.wrapper === hint || option.displayName === hint)) ?? null);

/** How a harness reads on screen. */
export const fleetHarnessLabel = (harness: PickerAccount['kind']): 'Claude' | 'Codex' =>
  harness === 'claude-code' ? 'Claude' : 'Codex';

/** The option for a chosen wrapper, or `null` when it is absent or the roster is unread. */
export const findAccountOption = (
  options: readonly AccountPickerOption[] | null,
  wrapper: string,
): AccountPickerOption | null => options?.find(option => option.wrapper === wrapper) ?? null;

/**
 * Normalizes typed model text with no reference to any account: blank stays
 * blank (`null`, meaning "use the account's own default"). This signature
 * cannot pin a default even by accident, because it is never handed one.
 */
export const normalizedModelSelection = (model: string): string | null => {
  const trimmed = model.trim();
  return trimmed === '' ? null : trimmed;
};
