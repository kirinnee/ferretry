/**
 * THE ACCOUNT AND PROJECT FIELDS, as the two write surfaces mount them.
 *
 * `shell/picker-combobox.tsx` is the control and has never heard of an account;
 * `daemon-picker-model.ts` is the projection and has never heard of a slice.
 * This file is the seam between them, and it owns exactly three jobs:
 *
 *   1. ADAPT A SLICE TO A SOURCE. A daemon-scoped slice carries more shapes than
 *      a picker has states, and the mapping is a decision rather than a
 *      formality — see `accountFieldSource` for the whole precedence table and
 *      why each row is what it is. Both adapters are exported and table-tested,
 *      because getting this wrong is how a browser tells somebody their host has
 *      no accounts because a request timed out.
 *   2. RENDER THE ROWS. Quota, health and provenance are the words the control
 *      refuses to know, so they are drawn here through `renderOption`.
 *   3. OFFER THE HEALTH CHECK, AND ONLY ON PURPOSE.
 *
 * WHY HEALTH IS A BUTTON AND QUOTA IS NOT. They look like the same kind of fact
 * and they cost wildly different things. Quota is the daemon's own cached feed,
 * already polled for the badges elsewhere in this app, so joining it onto a row
 * costs one map lookup. Health is a live probe: the host starts each account's
 * agent and asks it to answer a sentinel, which is a real inference call per
 * account, and failures are not cached. Reading that automatically would mean
 * opening a bottom sheet quietly spending money on a machine the reader is not
 * sitting at. So automatic hydration reads the published manifest and nothing
 * else, and `store.checkHealth` runs only from the control below, whose label
 * says out loud what it is about to do.
 *
 * EVERY MISSING FACT STAYS MISSING. An unread roster is not an empty fleet, an
 * account with no quota row is not an account at 0 %, an account nobody has
 * checked is not a healthy one, and a folder a session merely used is not a
 * folder anybody registered. Each of those pairs is one `null` away from being
 * conflated, and each is asserted separately in the tests.
 */

import { Activity, Check, FolderClock, FolderGit2, ShieldQuestion } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  type AccountPickerOption,
  type AccountUsageRow,
  accountHealthLabel,
  accountPickerOptions,
  type ProjectPickerCatalog,
  type ProjectPickerOption,
  sameHarnessAccountOptions,
} from './daemon-picker-model.ts';
import type { PickerAccount, PickerAccountHealth } from '../lib/account-picker-catalog.ts';
import type { DaemonAccountPickerSlice, DaemonAccountPickerStore } from '../lib/account-picker-store.ts';
import { cn } from '../lib/class-names.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import type { DaemonFleetSlice } from '../lib/fleet-store.ts';
import type { DaemonProjectsSlice } from '../lib/projects-store.ts';
import { fleetHarnessLabel } from '../features/fleet/fleet-model.ts';
import { useAccountPickerSlice } from '../hooks/use-account-picker.ts';
import { PickerCombobox } from '../shell/picker-combobox.tsx';
import type { PickerOption, PickerSource } from '../shell/picker-model.ts';
import { Button } from '../shell/primitives.tsx';
import { QuotaReadout } from '../shell/quota-readout.tsx';

/** The projection, wearing the control's option contract. */
export interface AccountFieldOption extends PickerOption {
  readonly account: AccountPickerOption;
}

export interface ProjectFieldOption extends PickerOption {
  readonly project: ProjectPickerOption;
}

// ---------------------------------------------------------------------------
// Slice → source
// ---------------------------------------------------------------------------

/**
 * One row per account, in the daemon's own order, `null` when the roster was
 * never read.
 *
 * An unavailable account is offered as a DISABLED row carrying the manifest's
 * own reason, never hidden: a reader looking for the account they cannot use
 * deserves to find out why rather than to wonder where it went. Its wrapper name
 * stays typeable, because the daemon is the thing that refuses a launch.
 */
export const accountFieldOptions = (
  options: readonly AccountPickerOption[] | null,
): readonly AccountFieldOption[] | null =>
  options?.map(account => ({
    account,
    value: account.wrapper,
    label: account.displayName,
    search: account.searchText,
    ...(account.available ? {} : { disabled: true }),
    ...(account.unavailableReason === null ? {} : { disabledReason: account.unavailableReason }),
  })) ?? null;

/**
 * THE PRECEDENCE TABLE. First match wins, and every row is a decision:
 *
 *   1. never read, and the read failed   → `failed`. There is nothing to show.
 *   2. never read, still going           → `loading`. Unread is not empty.
 *   3. read, and the projection is null  → `failed`. A roster arrived that could
 *                                          not be projected; saying "no accounts"
 *                                          about it would be a claim nobody made.
 *   4. read                              → `ready`, INCLUDING `[]`, which is the
 *                                          host positively publishing nothing.
 *   5. read, and a later refresh failed  → `ready` + `staleReason`. Both facts
 *                                          are true at once and the control has
 *                                          somewhere to put each of them.
 *
 * Rows 4 and 5 are the same branch: `staleReason` is present exactly when the
 * slice is in error while still holding a proved catalog, which is the
 * last-good-on-failure behaviour every store in this app deliberately has.
 */
export const accountFieldSource = (
  slice: DaemonAccountPickerSlice,
  options: readonly AccountFieldOption[] | null,
): PickerSource<AccountFieldOption> => {
  if (options === null) {
    return slice.status === 'error'
      ? { kind: 'failed', reason: slice.error ?? 'this daemon’s account roster could not be read' }
      : { kind: 'loading' };
  }
  return {
    kind: 'ready',
    options,
    ...(slice.status === 'error' && slice.error !== null ? { staleReason: slice.error } : {}),
  };
};

/**
 * Registered folders first, then folders only a session has used.
 *
 * The order is load-bearing rather than cosmetic: `filterPickerOptions` sorts by
 * match tier with a STABLE sort, so within one tier this order survives, and a
 * folder somebody deliberately registered stays above one that merely happened.
 */
export const projectFieldOptions = (catalog: ProjectPickerCatalog): readonly ProjectFieldOption[] | null => {
  if (catalog.registered === null && catalog.recent === null) return null;
  return [...(catalog.registered ?? []), ...(catalog.recent ?? [])].map(project => ({
    project,
    value: project.path,
    label: project.name,
    search: project.searchText,
    detail: project.path,
  }));
};

/**
 * One half's sentence, or `null` when that half has nothing to apologise for.
 *
 * Written once and called twice so the registry and the session list cannot
 * drift into answering the question differently — they are the same question
 * about two independent reads, and the only thing that differs is the words.
 *
 * `retained` is the ROW SHAPE, never the verdict: it picks between the two
 * sentences and has no vote on whether there is one. Reading it as the verdict
 * is precisely the bug this signature is shaped to make unwriteable.
 */
const halfRefusal = (
  status: DaemonProjectsSlice['status'] | DaemonFleetSlice['status'],
  error: string | null,
  retained: boolean,
  missing: string,
  stale: string,
): string | null => (status === 'error' ? (error ?? (retained ? stale : missing)) : null);

/**
 * The project side of the same table, with one case accounts do not have:
 * HALF THE CATALOGUE CAN FAIL ON ITS OWN.
 *
 * The registry and the session list are two independent reads. If the registry
 * refuses while sessions answer, there are real rows to offer and a real thing
 * the reader has not been told, so the rows are offered and `staleReason` says
 * what is missing. That channel is worded for staleness rather than for
 * incompleteness, which is not a perfect fit — but the alternatives are hiding
 * usable folders behind an error, or listing them while swallowing the news that
 * the registry is unreadable, and both of those are worse than an imprecise
 * warning. The one thing that never happens is a recent folder being described
 * as registered: they are separate members of a union, and only the registered
 * branch can carry a registry id at all.
 *
 * WHAT DECIDES IS THE STATUS, AND ONLY THE STATUS — the same question
 * `accountFieldSource` above asks. Absent rows cannot answer it: `projects: null`
 * is equally the reading for a read still in flight and one that refused, and the
 * two reads settle independently, so the window where one has answered and the
 * other has not is what every first paint of this field looks like. Warning there
 * would tell a reader their host refused something it is at that moment busy
 * answering — the same "absence of evidence read as evidence" this whole module
 * exists to refuse, merely pointed the other way.
 *
 * PRESENT ROWS CANNOT ANSWER IT EITHER, which is the mirror trap and the easier
 * one to walk into. Both stores deliberately keep their last good answer through
 * a failed refresh — `projects-store.ts:149-155` and `fleet-store.ts` both say so
 * in as many words — so a half can hold real rows AND have refused, and reading
 * only the rows would offer folders from before the outage looking exactly like
 * folders from a second ago. Any `error` status earns a sentence; the rows stay
 * either way.
 *
 * THE ROW SHAPE ONLY CHOOSES THE WORDS. A half that failed with nothing cached
 * is MISSING and its sentence says which folders are consequently absent; a half
 * that failed over rows it had already proved is STALE and its sentence says the
 * rows on screen may be out of date. Saying "only recently used folders are
 * listed" over a list that is showing registered ones would be false in exactly
 * the way this function exists to avoid. The daemon's own words replace both
 * whenever it supplied any. When both halves refused the registry's sentence is
 * the one shown, unchanged from before.
 */
export const projectFieldSource = (
  projects: DaemonProjectsSlice,
  fleet: DaemonFleetSlice,
  options: readonly ProjectFieldOption[] | null,
): PickerSource<ProjectFieldOption> => {
  if (options === null) {
    const reason = projects.error ?? fleet.error;
    return projects.status === 'error' || fleet.status === 'error'
      ? { kind: 'failed', reason: reason ?? 'this daemon’s folders could not be read' }
      : { kind: 'loading' };
  }
  const registryRefusal = halfRefusal(
    projects.status,
    projects.error,
    projects.projects !== null,
    'the registered projects could not be read — only recently used folders are listed',
    'the registered projects could not be refreshed — the folders listed may be out of date',
  );
  const sessionsRefusal = halfRefusal(
    fleet.status,
    fleet.error,
    fleet.sessions !== null,
    'the session list could not be read — only registered projects are listed',
    'the session list could not be refreshed — the recently used folders may be out of date',
  );
  const partial = registryRefusal ?? sessionsRefusal;
  return { kind: 'ready', options, ...(partial === null ? {} : { staleReason: partial }) };
};

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * Health, in four visibly different readings.
 *
 * `unknown` is not a softer `down` — the fleet schema says so in its own words —
 * and "nobody has checked" is not `unknown` either. Collapsing the last two is
 * the exact "absence of evidence read as evidence" bug the whole health feature
 * exists to avoid, so the never-checked case renders as its own quiet sentence
 * with no verdict in it.
 */
const HEALTH_MARK = {
  healthy: { label: 'healthy', className: 'text-ok' },
  down: { label: 'down', className: 'text-err' },
  unknown: { label: 'unknown', className: 'text-warn' },
} as const;

const healthTitle = (health: PickerAccountHealth): string => {
  const detail = health.error === undefined ? '' : ` — ${health.error}`;
  const kind = health.failureKind === undefined ? '' : ` (${health.failureKind})`;
  return `${health.cached ? 'cached ' : ''}health: ${health.state}${kind}${detail}`;
};

function AccountHealthMark({ health }: { readonly health: PickerAccountHealth | null }) {
  if (health === null) {
    return (
      <span className="mono shrink-0 text-2xs text-faint" title="this account has not been checked on the host">
        unchecked
      </span>
    );
  }
  const mark = HEALTH_MARK[accountHealthLabel(health)];
  return (
    <span className={cn('mono shrink-0 text-2xs', mark.className)} title={healthTitle(health)}>
      {mark.label}
    </span>
  );
}

/**
 * The row layout, and why it changes shape at `sm`.
 *
 * A row says two things: WHICH thing this is, and what is currently true about
 * it. On a desktop those sit side by side, identity left and evidence in a
 * right-hand rail, which is the densest readable arrangement and the one that
 * was reviewed.
 *
 * At 390px they cannot both have the width. The rail is `shrink-0` — quota and
 * health must never be squeezed into ellipses, because a half-printed percentage
 * is worse than none — so the identity column gets whatever is left, and the
 * harness capture showed exactly what that costs: `claude-auto-atelie…` and
 * `/home/pilot/.config/home-…`. Both of those are the SUBMITTED VALUE. Truncating
 * the display name would be a cosmetic loss; truncating the wrapper or the path
 * means two rows can look identical at the moment somebody is choosing between
 * them, which is the one thing a picker must never do.
 *
 * So below `sm` the row stacks: identity on its own full-width line, evidence
 * wrapped beneath it. Nothing is hidden at either width and the desktop rail is
 * untouched — `sm:` restores it exactly.
 */
/**
 * `items-start` is load-bearing at BOTH widths and for different reasons. Stacked,
 * it stops a bordered child — the provenance badge — from stretching to the full
 * row width and reading as a bar rather than a pill. Side by side, it keeps the
 * rail aligned to the top of a row whose identity has wrapped to two lines.
 */
const ROW_CLASS = 'flex min-w-0 flex-1 flex-col items-start gap-0.5 sm:flex-row sm:justify-between sm:gap-sm';

/**
 * The evidence rail: a wrapping row beneath the identity on a phone, a right-hand
 * column from `sm` up. `shrink-0` at both widths, so it is never the thing that
 * gets clipped.
 */
const EVIDENCE_CLASS =
  'flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs sm:flex-col sm:items-end sm:gap-0.5';

/**
 * A line that must stay whole on a phone.
 *
 * No bare `truncate`: below `sm` it wraps to as many lines as the value needs,
 * because the row is `min-h-[44px]` rather than a fixed height and growing is
 * free. From `sm` up it truncates again, where the rail has returned and there is
 * enough width that it effectively never does.
 */
const IDENTITY_LINE_CLASS = 'mono text-meta text-muted';

/**
 * One account as compact runtime telemetry: who it is, what it runs as, and the
 * two pieces of evidence about it — kept visually apart because they are
 * different facts from different reads with different costs.
 *
 * `selected` is the row whose value the box already holds, which in a control
 * whose text IS its output is a different thing from where the cursor is. It gets
 * a tick, so scrolling the list never loses track of the answer already given.
 */
export function AccountPickerRow(option: AccountFieldOption, state: { readonly selected: boolean }): ReactNode {
  const { account } = option;
  return (
    <span className={ROW_CLASS} data-picker-row="account">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1">
          {state.selected ? <Check aria-label="current choice" className="shrink-0 text-accent" size={12} /> : null}
          <span className="truncate font-medium text-current">{account.displayName}</span>
        </span>
        {/* The wrapper is what gets submitted, so it wraps rather than truncating
            on a phone. `break-words` and not `break-all`: this line has spaces
            around its separators, so it breaks between fields instead of through
            the middle of an identifier. */}
        <span className={cn(IDENTITY_LINE_CLASS, 'break-words sm:truncate')} data-picker-identity="wrapper">
          {account.wrapper} · {fleetHarnessLabel(account.kind)} · {account.mode}
        </span>
        {option.disabledReason === undefined ? null : (
          <span className="text-meta text-warn">{option.disabledReason}</span>
        )}
      </span>
      <span className={EVIDENCE_CLASS}>
        <QuotaReadout className="text-2xs" quota={account.quota} showUnknown={true} />
        <AccountHealthMark health={account.health} />
      </span>
    </span>
  );
}

/** Provenance is the whole point of a project row: declared, or merely used. */
export function ProjectPickerRow(option: ProjectFieldOption): ReactNode {
  const { project } = option;
  const registered = project.kind === 'registered';
  return (
    <span className={ROW_CLASS} data-picker-row="project">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-medium text-current">{project.name}</span>
        {/* The absolute path IS the submitted value, and two folders can share
            every visible character of a truncated one. `break-all` because a path
            has no spaces to break at, so wrapping anywhere is the only way to
            show all of it on a phone. */}
        <span className={cn(IDENTITY_LINE_CLASS, 'break-all sm:break-normal sm:truncate')} data-picker-identity="path">
          {project.path}
        </span>
      </span>
      <span
        className={cn(
          'kt-label flex shrink-0 items-center gap-1 rounded-badge border px-1.5 py-0.5',
          registered ? 'border-border bg-surface-2 text-muted' : 'border-border-soft bg-surface text-faint',
        )}
        title={
          registered
            ? 'a folder this daemon has deliberately registered'
            : 'a folder a session has used — choosing it registers nothing'
        }
      >
        {registered ? <FolderGit2 aria-hidden="true" size={11} /> : <FolderClock aria-hidden="true" size={11} />}
        {registered ? 'Registered' : 'Recent'}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/** What both fields hand straight to the control. */
export interface DaemonPickerFieldProps {
  /** Used verbatim, so a surface's own `<label htmlFor>` keeps pointing at it. */
  readonly id: string;
  /** The accessible name. Pass the same words as the visible label. */
  readonly label: string;
  readonly describedBy?: string;
  readonly placeholder?: string;
  /** The typed value, which is what the surface submits. Never normalised here. */
  readonly value: string;
  readonly onValueChange: (next: string) => void;
}

export interface AccountPickerFieldProps extends DaemonPickerFieldProps {
  readonly source: PickerSource<AccountFieldOption>;
  /**
   * Fires only when a row was CHOSEN. It exists so a surface can change what its
   * MODEL field offers; it must not write a model value, because blank already
   * means "this account's own default" and writing the string turns a default
   * into a pin the reader never asked for.
   */
  readonly onAccountChosen?: (account: AccountPickerOption) => void;
  /** Absent means this surface does not offer the live check at all. */
  readonly healthCheck?: AccountHealthCheckProps;
  /**
   * A non-fatal sentence about a SIDE read — today, the cached quota feed.
   *
   * It is deliberately not part of `source`: a roster that arrived is not
   * unreadable because the quota beside it did not, and folding the two together
   * would hide a perfectly good list behind a failure about a decoration. The
   * rows below simply say `quota —`, which is already the honest reading.
   */
  readonly advisory?: string;
  /**
   * Which harness this field is narrowed to, when it is narrowed at all.
   *
   * Only ever used to WORD the empty state — the filtering itself happens in the
   * projection, before any of this. See `accountEmptyCopy`.
   */
  readonly harness?: PickerAccount['kind'];
  /**
   * Whether the daemon published ANY account, whatever harness it was for.
   *
   * The one fact that tells a filtered-empty list apart from an empty host, and
   * the field cannot derive it: by the time options reach here the other harness's
   * accounts have already been filtered out, so an empty array looks the same
   * either way. `undefined` means the caller does not know, which is read as the
   * cautious answer — the generic sentence, which claims less.
   */
  readonly publishesAnyAccount?: boolean;
}

/**
 * WHY AN EMPTY LIST NEEDS TWO DIFFERENT SENTENCES.
 *
 * A migration narrows the roster to one harness, because Claude and Codex cannot
 * resume each other's conversation format. On a host with three Claude accounts
 * and no Codex one, a Codex migration therefore has an empty list and a fleet
 * that is emphatically not empty — and "this daemon publishes no accounts" would
 * be a false statement about the host, invented from a decision this browser
 * made. It is also the statement that sends somebody to go and provision an
 * account they already have.
 *
 * So the copy names the filter whenever the filter is what emptied the list, and
 * keeps the honest fleet-wide sentence for a manifest that really is empty.
 * Returned as a visible/spoken pair rather than one string, because the two
 * channels must not be able to drift.
 */
export const accountEmptyCopy = (
  harness: PickerAccount['kind'] | undefined,
  publishesAnyAccount: boolean | undefined,
): { readonly notice: string; readonly status: string } => {
  if (harness === undefined || publishesAnyAccount !== true) {
    return {
      notice: 'This daemon publishes no accounts. Type a wrapper name instead.',
      status: 'This daemon publishes no accounts. Type a wrapper name instead.',
    };
  }
  const label = fleetHarnessLabel(harness);
  return {
    notice: `This daemon publishes no ${label} accounts. Type a wrapper name instead.`,
    status: `This daemon publishes no ${label} accounts, though it publishes others. Type a wrapper name instead.`,
  };
};

export function AccountPickerField({
  source,
  onAccountChosen,
  healthCheck,
  advisory,
  harness,
  publishesAnyAccount,
  ...field
}: AccountPickerFieldProps): ReactNode {
  const empty = accountEmptyCopy(harness, publishesAnyAccount);
  return (
    <div className="grid gap-xs">
      <PickerCombobox
        describedBy={field.describedBy}
        id={field.id}
        label={field.label}
        emptyNotice={empty.notice}
        emptyStatus={empty.status}
        onSelect={option => onAccountChosen?.(option.account)}
        onValueChange={field.onValueChange}
        placeholder={field.placeholder}
        renderOption={AccountPickerRow}
        source={source}
        value={field.value}
      />
      {advisory === undefined ? null : (
        <p className="m-0 text-meta leading-base text-muted" data-picker-advisory="" role="status">
          {advisory} Accounts with no reading show “quota —” rather than a percentage.
        </p>
      )}
      {healthCheck === undefined ? null : <AccountHealthCheck {...healthCheck} />}
    </div>
  );
}

export interface ProjectPickerFieldProps extends DaemonPickerFieldProps {
  readonly source: PickerSource<ProjectFieldOption>;
}

/**
 * WHAT AN EMPTY FOLDER LIST SAYS — ONCE, FOR BOTH CHANNELS.
 *
 * The control's own default sentence is "Nothing is published to choose from",
 * which is true of a host and useless about folders: it does not say that TWO
 * separate things came back empty, and a reader who cannot see the panel is the
 * one who most needs to be told that neither the registry nor the session list
 * had anything, so typing a path is the whole job rather than a workaround.
 *
 * `emptyNotice` and `emptyStatus` are a pair on purpose — `picker-combobox.tsx`
 * says so where it declares them — and the account field honours that pairing
 * through `accountEmptyCopy`. Accounts need two DIFFERENT sentences because a
 * migration filters the roster and the spoken half has to admit the filter.
 * Nothing filters folders, so the honest spoken sentence is the visible one, and
 * it is written once here rather than twice at the call site: two literals that
 * must agree are two literals that eventually will not.
 */
const PROJECT_EMPTY_COPY =
  'This daemon registers no projects, and no session has used a folder yet. Type a path instead.';

export function ProjectPickerField({ source, ...field }: ProjectPickerFieldProps): ReactNode {
  return (
    <PickerCombobox
      describedBy={field.describedBy}
      id={field.id}
      label={field.label}
      emptyNotice={PROJECT_EMPTY_COPY}
      emptyStatus={PROJECT_EMPTY_COPY}
      onValueChange={field.onValueChange}
      placeholder={field.placeholder}
      renderOption={ProjectPickerRow}
      source={source}
      value={field.value}
    />
  );
}

// ---------------------------------------------------------------------------
// The health check
// ---------------------------------------------------------------------------

export interface AccountHealthCheckProps {
  readonly status: DaemonAccountPickerSlice['healthStatus'];
  readonly error: string | null;
  readonly checked: number;
  readonly onCheck: () => void;
}

/**
 * The one control in this file that spends something, and it says so.
 *
 * The sentence beside it is not a nicety: this button asks the host to start
 * every published account's agent and wait for it to answer, which is a real
 * inference call each and takes as long as the slowest one. A reader pressing it
 * on a machine they are not sitting at should know that before they press it,
 * not after — so the cost is in the copy rather than in a tooltip.
 */
export function AccountHealthCheck({ status, error, checked, onCheck }: AccountHealthCheckProps): ReactNode {
  const running = status === 'loading';
  return (
    // Named on the DOM because this block has its own live region, and the
    // control above it has one too: a page-wide `role="status"` query would
    // otherwise find the picker's row count when it meant the check's verdict.
    <div className="grid gap-xs" data-picker-health={status}>
      <div className="flex flex-wrap items-center gap-sm">
        <Button
          aria-busy={running || undefined}
          className="min-h-[44px]"
          disabled={running}
          onClick={onCheck}
          size="sm"
          type="button"
        >
          <Activity aria-hidden="true" className="shrink-0" size={14} />
          {running ? 'Checking accounts…' : 'Check accounts'}
        </Button>
        <span className="min-w-0 text-meta leading-base text-muted">
          Runs a live check on the host: it starts each published account once and waits for a reply.
        </span>
      </div>
      {status === 'ready' ? (
        <p className="m-0 text-meta text-muted" role="status">
          {checked === 1 ? '1 account checked.' : `${checked} accounts checked.`} Accounts with no result stay
          unchecked.
        </p>
      ) : null}
      {status === 'error' ? (
        <p className="m-0 flex items-start gap-xs text-meta leading-base text-warn" role="alert">
          <ShieldQuestion aria-hidden="true" className="mt-0.5 shrink-0" size={13} />
          <span className="min-w-0">
            {error ?? 'the account check could not be completed'} Unchecked accounts stay unchecked rather than being
            reported healthy.
          </span>
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connected
// ---------------------------------------------------------------------------

export interface DaemonAccountPickerProps extends DaemonPickerFieldProps {
  readonly store: DaemonAccountPickerStore;
  /** The one daemon whose accounts this field may ever offer. */
  readonly connection: DaemonConnection;
  /**
   * The daemon's CACHED quota rows, joined onto accounts by wrapper name.
   *
   * Rows rather than a store, because the surrounding app already polls that
   * feed for its badges and a picker has no business arming a second poll. Rows
   * rather than finished options, because health arrives from the store this
   * component is already subscribed to: a caller that had to build the options
   * would need its own subscription to the same store purely to see the result
   * of a button this component owns.
   */
  readonly usage: readonly AccountUsageRow[];
  /** Why the cached quota feed is missing, if it is. Never fails the roster. */
  readonly usageError?: string | null;
  /** Set for a migration, where cross-CLI is never offered. */
  readonly harness?: PickerAccount['kind'];
  readonly onAccountChosen?: (account: AccountPickerOption) => void;
  /**
   * Whether this surface offers the live host probe. Off by default so a screen
   * has to ask for it deliberately, and available to every surface that does —
   * the new-session form and the migrate sheet both choose an account, and both
   * have the same reason to want evidence before they commit to one.
   */
  readonly offerHealthCheck?: boolean;
}

/**
 * How many of the rows THIS FIELD OFFERS came back with a health result.
 *
 * The probe route checks the whole fleet — that is the host's business and the
 * button's copy says so plainly, which is the disclosure that has to stay. But
 * the completion count is a sentence about the list in front of the reader, and
 * on a Codex migration showing one row "3 accounts checked" is simply not about
 * anything they can see. It also reads as an invitation to look for the other two.
 *
 * So the count is an intersection: offered rows that have a result. A row the
 * probe skipped stays `unchecked` in its own right-hand rail, which is where a
 * reader looks for the per-account answer anyway.
 */
export const checkedAmongOffered = (
  offered: readonly AccountPickerOption[] | null,
  health: ReadonlyMap<string, PickerAccountHealth> | null,
): number => (offered === null || health === null ? 0 : offered.filter(option => health.has(option.id)).length);

/**
 * The field a write surface mounts.
 *
 * It subscribes to the roster ONCE and projects everything from that one
 * subscription: the manifest it hydrated, the cached quota rows handed in, and
 * whatever health the reader has asked for. `store.checkHealth` is called from
 * exactly one place — the button below — and from nowhere on mount.
 */
export function DaemonAccountPicker({
  store,
  connection,
  usage,
  usageError,
  harness,
  onAccountChosen,
  offerHealthCheck = false,
  ...field
}: DaemonAccountPickerProps): ReactNode {
  const slice = useAccountPickerSlice(store, connection);
  // Read through the same optional chain as everything else here. A strict
  // `=== null` test looks equivalent and is not: an absent catalog reaches this
  // line as `undefined` from any slice assembled by hand, and the field then
  // throws on `.accounts` instead of rendering — a blank pane where a working
  // text box belongs. Unread stays unread.
  const published = slice.catalog?.accounts ?? null;
  const projected = accountPickerOptions(published, usage, slice.health);
  const scoped = harness === undefined ? projected : sameHarnessAccountOptions(projected, harness);
  return (
    <AccountPickerField
      {...field}
      {...(harness === undefined ? {} : { harness })}
      {...(published === null ? {} : { publishesAnyAccount: published.length > 0 })}
      {...(onAccountChosen === undefined ? {} : { onAccountChosen })}
      {...(usageError === undefined || usageError === null ? {} : { advisory: usageError })}
      {...(offerHealthCheck
        ? {
            healthCheck: {
              status: slice.healthStatus,
              error: slice.healthError,
              checked: checkedAmongOffered(scoped, slice.health),
              onCheck: () => {
                void store.checkHealth(connection).catch(() => {});
              },
            },
          }
        : {})}
      source={accountFieldSource(slice, accountFieldOptions(scoped))}
    />
  );
}

export interface DaemonProjectPickerProps extends DaemonPickerFieldProps {
  /** Both reads arrive already made: this field owns neither of them. */
  readonly projects: DaemonProjectsSlice;
  readonly fleet: DaemonFleetSlice;
  readonly catalog: ProjectPickerCatalog;
}

/**
 * The folder field. It reads nothing and writes nothing — in particular it never
 * registers a project, because registration is a deliberate `POST /v1/projects`
 * with its own confirmation and choosing a folder here is not that.
 */
export function DaemonProjectPicker({ projects, fleet, catalog, ...field }: DaemonProjectPickerProps): ReactNode {
  return <ProjectPickerField {...field} source={projectFieldSource(projects, fleet, projectFieldOptions(catalog))} />;
}
