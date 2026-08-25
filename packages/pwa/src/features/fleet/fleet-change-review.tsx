/**
 * The review half of the cockpit: what the host IS, what the held proposal WOULD DO, and what an
 * apply actually did.
 *
 * Everything rendered here comes from the daemon. The ledger is the daemon's own operation list, the
 * proposed roster is the manifest the daemon derived, and the outcome is the daemon's typed report of
 * what the host became. The browser contributes numbering and plain language, and nothing else — a
 * surface that rendered its own idea of the change would be a review of something nobody is going to
 * apply.
 *
 * Refusal text is never squashed to one line. A fleet refusal is routinely a list — every schema issue
 * in a candidate configuration, every path a rollback could not verify — and the reader needs all of it.
 */

import {
  ArrowRight,
  CircleAlert,
  CircleCheck,
  ClipboardList,
  CloudOff,
  FileCog,
  ListOrdered,
  Lock,
  ServerCog,
  TriangleAlert,
} from 'lucide-react';
import { useId, useState } from 'react';
import {
  absoluteInstantLabel,
  type AccountHealthTone,
  accountHealthView,
  UNREAD_ACCOUNT_HEALTH,
} from '../../lib/account-health-view.ts';
import type { PickerAccountHealth } from '../../lib/account-picker-catalog.ts';
import { cn } from '../../lib/class-names.ts';
import { EYEBROW, PanelPath } from '../../shell/panel-typography.tsx';
import type { OperatorUnlockFailure } from '../../lib/grants.ts';
import { OperatorUnlockDialog } from '../settings/operator-unlock-dialog.tsx';
import { absoluteTime } from '../../lib/session-screens.ts';
import type {
  FleetApplyOutcome,
  FleetManifestAccountView,
  FleetProposalPreview,
  FleetProposalView,
  FleetRefusalView,
} from './fleet-api.ts';
import {
  type FleetApplyAuthority,
  fleetApplyCopy,
  fleetApplyNeedsPassword,
  type FleetRosterChange,
  type FleetRosterRow,
  type FleetUnreachableDiagnosis,
  operationLedger,
  outcomeSummary,
  rosterDiff,
} from './fleet-change-model.ts';

/**
 * The verdict's tone, as the SHARED badge's own vocabulary.
 *
 * This used to be four hand-rolled border/background/text triples — a fifth chip design in a panel that
 * already had `kt-badge` for exactly this job. The shared badge carries the tone, the clip path, the
 * theme's own letter-spacing and the one uppercase role this panel keeps.
 */
const CHANGE_TONE: Readonly<Record<FleetRosterChange, string>> = {
  unchanged: 'muted',
  added: 'ok',
  changed: 'accent',
  removed: 'err',
};

const CHANGE_LABEL: Readonly<Record<FleetRosterChange, string>> = {
  unchanged: 'unchanged',
  added: 'new',
  changed: 'changed',
  removed: 'removed',
};

function AccountLine({ account }: { readonly account: FleetManifestAccountView }) {
  return (
    <div className="min-w-0 flex-1 basis-[12rem]">
      <PanelPath value={account.wrapper} className="block text-ui font-semibold text-fg" />
      {/* Wraps rather than truncates: a clipped default model is the one fact a reader came for. */}
      <p className="m-0 text-meta leading-base text-muted">
        {account.displayName} · {account.mode} · {account.defaultModel ?? 'no default model'}
      </p>
      {account.available ? null : (
        <p className="m-0 mt-0.5 text-meta leading-base text-warn">{account.unavailableReason}</p>
      )}
    </div>
  );
}

/**
 * Whether each published account is signed in, on the screen an operator actually opens.
 *
 * TWO FACTS, KEPT APART. `N published` above is what the MANIFEST declares. This is what the
 * PROVIDER last said about the credential in that account's home. An account can be published and
 * signed out, so neither line may stand in for the other.
 *
 * THE WORDS COME FROM `account-health-view.ts`, which the account picker also reads. A second copy
 * table here is how the same account ends up described differently on two screens, so there is not
 * one — `accountHealthView` is the single owner and this component only positions its output.
 *
 * IT SAYS NOTHING WHEN THERE IS NOTHING TO SAY. This is a roster, and a roster whose every row read
 * `Unknown · Never checked · Nothing has checked this account yet.` spent three of its four lines
 * telling somebody that nothing had happened — on a phone that IS the row, and the account it
 * describes is the thing they came for. So a `quiet` verdict renders no line at all, and a reason
 * that only restates its own headline is dropped. Neither can hide a bad verdict: `quiet` is the
 * one state where nobody has looked (which is also every row when the whole health read failed, and
 * this screen's job is configuration, so that must cost the roster nothing).
 *
 * What survives is the pair that matters — "Healthy" beside "quota is not measurable" — because
 * `detailIsImplied` is false for every reason that carries a fact of its own.
 */
function LiveAccountHealth({
  health,
  now,
}: {
  readonly health: PickerAccountHealth | undefined;
  readonly now: number;
}) {
  const view = health === undefined ? UNREAD_ACCOUNT_HEALTH : accountHealthView(health, now);
  if (view.quiet) return null;
  const instant = health?.lastCheckedAt ?? null;
  return (
    <p
      className="m-0 mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2 text-meta leading-base"
      data-fleet-live-health={view.tone}
    >
      <span className={cn('shrink-0 font-semibold', HEALTH_TONE_CLASS[view.tone])} title={view.detail}>
        {view.label}
      </span>
      {/* A semantic instant, so the exact UTC time reaches the accessible name while the visible
          label stays the relative one somebody can read at a glance. The relative label may tick in
          the client without anything claiming a fresh check happened. */}
      {instant === null ? (
        <span className="min-w-0 text-muted">{view.checked}</span>
      ) : (
        <time className="min-w-0 text-muted" dateTime={absoluteInstantLabel(instant)}>
          {view.checked}
        </time>
      )}
      {/* THE REASON IS VISIBLE, not only a title, wherever it is a second fact. A `title` has no
          touch equivalent, and "Healthy" beside "quota is not measurable" is the pair that stops
          somebody reading an unmeasurable account as a broken one. It wraps rather than truncating:
          a clipped reason is the fact a reader came for. */}
      {view.detailIsImplied ? null : <span className="min-w-0 text-muted">{view.detail}</span>}
      {view.secondary === undefined ? null : <span className="min-w-0 text-warn">{view.secondary}</span>}
    </p>
  );
}

/** The four tones, in this panel's own palette. `muted` is an absence, not a warning. */
const HEALTH_TONE_CLASS: Readonly<Record<AccountHealthTone, string>> = {
  ok: 'text-ok',
  bad: 'text-err',
  warn: 'text-warn',
  muted: 'text-faint',
};

/**
 * The accounts this daemon POSITIVELY published.
 *
 * An empty list here is a fleet observed to be empty. Every other reason a roster could be empty —
 * unread, unapplied, damaged, refused — is a different state and is rendered by the surface, never by
 * this component.
 */
export function FleetLiveRoster({
  accounts,
  generatedAt,
  onEdit,
  editable,
  health,
  now = Date.now(),
}: {
  readonly accounts: readonly FleetManifestAccountView[];
  readonly generatedAt: string;
  readonly onEdit: (account: FleetManifestAccountView) => void;
  readonly editable: boolean;
  /**
   * The daemon's stored verdicts, keyed by account id. OPTIONAL, and absent is a first-class case:
   * a daemon that can publish a manifest and cannot serve verdicts still has accounts, and this
   * panel's job is configuration. Absent means every row simply carries no health line.
   */
  readonly health?: ReadonlyMap<string, PickerAccountHealth>;
  /** The instant relative labels are measured against. Injected so a test asserts against a fixture. */
  readonly now?: number;
}) {
  // Instance-local: a page may hold more than one cockpit, so a roster may appear more than once.
  const uid = useId();
  const id = (name: string): string => `${uid}${name}`;
  return (
    <section
      className="kt-panel overflow-hidden border-l-4 border-l-border-strong"
      data-fleet-side="live"
      aria-labelledby={id('-live-heading')}
    >
      <header className="border-b border-border-soft bg-surface-2 px-panel py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ServerCog size={16} className="shrink-0 text-fg-soft" aria-hidden="true" />
          <h2 id={id('-live-heading')} className="m-0 text-title font-semibold text-fg">
            Live host
          </h2>
          <span className="kt-badge ml-auto">{accounts.length} published</span>
        </div>
        <p className="m-0 mt-1 text-meta text-muted">Last published manifest, generated {absoluteTime(generatedAt)}.</p>
      </header>
      {accounts.length === 0 ? (
        <p className="m-0 px-panel py-3 text-ui leading-base text-muted" data-fleet-live-empty="">
          This daemon published a manifest with no accounts in it. That is an observed empty fleet, not a failed read.
        </p>
      ) : (
        <ul className="m-0 list-none p-0" aria-label="Published accounts">
          {accounts.map(account => (
            <li
              key={account.id}
              className="flex min-w-0 flex-wrap items-center gap-2 border-t border-border-soft px-panel py-2 first:border-t-0"
            >
              <div className="min-w-0 flex-1 basis-[12rem]">
                <AccountLine account={account} />
                <LiveAccountHealth health={health?.get(account.id)} now={now} />
              </div>
              {/* "Edit", not "Edit layer". A layer is a composition slot in the configuration
                  schema and nothing a person adding an account has a reason to learn; the row it
                  sits on already names the account this edits. What opens is that account's own
                  instructions, skills, settings and environment. */}
              <button
                type="button"
                className="kt-btn kt-btn--sm ml-auto shrink-0"
                disabled={!editable}
                onClick={() => onEdit(account)}
              >
                Edit
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RosterDiffRows({ rows }: { readonly rows: readonly FleetRosterRow[] }) {
  return (
    <ul className="m-0 list-none p-0" aria-label="Proposed accounts">
      {rows.map(row => (
        <li
          key={row.id}
          className="flex min-w-0 flex-wrap items-center gap-2 border-t border-border-soft px-panel py-2 first:border-t-0"
          data-fleet-roster-change={row.change}
        >
          <AccountLine account={row.account} />
          <span className="kt-badge ml-auto shrink-0" data-tone={CHANGE_TONE[row.change]}>
            {CHANGE_LABEL[row.change]}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What each kind of failure IS, in the words a person can act on. `malformed` is not a refusal. */
const REFUSAL_HEADLINE: Readonly<Partial<Record<FleetRefusalView['kind'], string>>> = {
  forbidden: 'This daemon refused the change',
  // The daemon answered; the answer did not match the contract. Calling that "the daemon refused" would
  // send a person looking for a permission or a policy that does not exist.
  malformed: 'This daemon answered something this browser cannot read',
  // NOTHING ANSWERED AT ALL, so nobody refused anything. This one was reading "The daemon refused" over
  // a fetch that never completed — a sentence that sends a person to look for a permission on a host
  // this browser could not even reach, which is what happened to the owner who reported it.
  unreachable: 'This browser could not reach this daemon',
};

/** The daemon's refusal, whole. Multiline by design: the second line is usually the actionable one. */
export function FleetRefusalAlert({ refusal }: { readonly refusal: FleetRefusalView }) {
  return (
    <div
      role="alert"
      className="mx-panel my-3 rounded-control border border-err-border bg-err-bg p-3"
      data-fleet-refusal={refusal.kind}
    >
      <div className="flex items-center gap-2 text-ui font-semibold text-err">
        <CircleAlert size={16} aria-hidden="true" />
        {REFUSAL_HEADLINE[refusal.kind] ?? 'The daemon refused'}
        {refusal.code === undefined ? null : (
          <code className="ml-auto font-mono text-meta text-err">{refusal.code}</code>
        )}
      </div>
      {/* The OPERATOR's reason first, in prose, because it is the one a person can act on: it says
          whether a capability was switched off, whether the password is needed, or whether the daemon
          has lost its own decision. The daemon's own sentence stays below it, whole. */}
      {refusal.grant === undefined ? null : (
        <p
          className="m-0 mt-2 text-ui font-semibold leading-base text-err"
          data-fleet-refusal-grant={refusal.grant.refusal}
        >
          {refusal.grant.guidance.explanation}
        </p>
      )}
      <pre className="m-0 mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-meta leading-base text-err">
        {refusal.detail}
      </pre>
    </div>
  );
}

/**
 * WHAT THIS BROWSER KNOWS WHEN NOTHING ANSWERED, and the checks that tell the possibilities apart.
 *
 * No control, because there is nothing here a click could achieve: every remedy is somewhere else — a
 * terminal on that machine, or the same address opened in a tab. Rendering a button that re-tried the
 * read would be the third version of the same mistake this panel is being repaired for, since a retry
 * is the one thing a reader will do anyway by reopening the tab, and a failing one teaches them the
 * panel is broken rather than that the request is not arriving.
 *
 * `detail` is the transport's own sentence, kept whole. It names the exact URL the attempt used, which
 * is the one fact the diagnosis below cannot derive — a connection may carry more than one carrier.
 */
export function FleetUnreachableNotice({
  diagnosis,
  detail,
  headingId,
}: {
  readonly diagnosis: FleetUnreachableDiagnosis;
  readonly detail?: string;
  /** The id the owning section names itself by, so this heading IS that name rather than a second one. */
  readonly headingId?: string;
}) {
  return (
    <div className="min-w-0" data-fleet-unreachable="">
      <h3 id={headingId} className="m-0 text-title font-semibold text-fg">
        {diagnosis.headline}
      </h3>
      <p className="mb-0 mt-1 text-ui leading-base text-muted">{diagnosis.body}</p>
      {detail === undefined ? null : (
        <pre className="m-0 mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-meta leading-base text-muted">
          {detail}
        </pre>
      )}
      {/* AN ORDERED LIST, because the order is the discrimination: the first check rules out the cause
          a person is most likely to be told about, and only then is the second one informative. */}
      <ol className="m-0 mt-3 list-decimal space-y-1 pl-5" aria-label="Checks that tell these causes apart">
        {diagnosis.checks.map(check => (
          <li key={check} className="text-ui leading-base text-fg-soft">
            {check}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * EVERY WAY A PANEL HERE TURNS SOMETHING REVIEWED INTO HOST STATE, in one shape.
 *
 * Two panels offer an action now — the change review and the first run — and they must ask for
 * authority IDENTICALLY. A second copy of "does this need the password, is it out of reach, what does a
 * refusal say" is how the fleet grew an authority vocabulary of its own the first time.
 */
export interface FleetApplyControls {
  readonly authority: FleetApplyAuthority;
  /**
   * Performs the action, with the operator password when one was asked for.
   *
   * ONE ARGUMENT, because there is one secret. The panel does not decide whether it becomes an unlock,
   * a confirmation or both — the surface does, from the same authority this component renders — and a
   * component that split it into two callbacks would be the second place that decision could be made
   * differently.
   */
  readonly onApply: (operatorPassword?: string) => void;
  readonly onDiscard: () => void;
  readonly busy: boolean;
  /** Why the last operator password was refused, so a wrong one is retyped rather than re-guessed at. */
  readonly unlockFailure?: OperatorUnlockFailure | null;
  /**
   * Set while this browser cannot reach the daemon this change was staged against.
   *
   * IT REMOVES THE PASSWORD FIELD AND THE ACTION, rather than disabling them. Neither can do anything:
   * the password would be checked by a limiter on the far side of a request that is not arriving, and
   * the action would spend one of that limiter's five attempts on a round trip nobody receives. What is
   * left is Discard, which is this browser's own act and works either way.
   */
  readonly unreachable?: FleetUnreachableDiagnosis | null;
}

/** The words on the two buttons. The action's own name, because "Apply" does not describe a first run. */
export interface FleetApplyLabels {
  readonly action: string;
  /** The same action, when the click also proves the operator password. */
  readonly confirming: string;
  readonly working: string;
  readonly discard: string;
}

/**
 * THE ONE PLACE A FLEET PANEL ASKS FOR AUTHORITY, whatever it is about to do.
 *
 * There is no heading over it and deliberately so: a "Host authority" section was the fleet advertising
 * an authority system of its own, and what is left is the ordinary thing every other governed control
 * does — say what is true when it is not a plain yes, and offer the one step that resolves it.
 */
function FleetApplyForm({
  authority,
  onApply,
  onDiscard,
  busy,
  unlockFailure = null,
  unreachable = null,
  labels,
}: FleetApplyControls & { readonly labels: FleetApplyLabels }) {
  /**
   * Whether the prompt is up. NOT the password, which this component never holds at all.
   *
   * The typed value lives inside the dialog for the one submit that spends it and passes through here
   * only as an argument on its way to `onApply`. A secret in a panel's state outlives the click that
   * needed it and shows up in anything that inspects that state.
   */
  const [asking, setAsking] = useState(false);
  const copy = fleetApplyCopy(authority);
  // A daemon that is not answering makes the authority question moot: there is nothing to prove a
  // password to. So the prompt is not merely blocked here, it can never be raised.
  const needsPassword = fleetApplyNeedsPassword(authority) && unreachable === null;
  const blocked = busy || authority.kind === 'refused';

  /**
   * ONE CLICK, and the prompt comes to the person rather than the person coming to the prompt.
   *
   * A caller that owes nothing acts immediately; a caller that owes the password meets the modal AT THIS
   * MOMENT. That is the difference between "this machine needs unlocking before its settings change" and
   * "authorise this one change" — and the second is what the owner was reading off a password field
   * sitting inside a staged-change card, under an expiry, beside Confirm-and-Apply.
   */
  const act = (): void => {
    if (blocked) return;
    if (needsPassword) {
      setAsking(true);
      return;
    }
    onApply(undefined);
  };

  return (
    <div className="border-t border-border-soft bg-surface-2 px-panel py-3" data-fleet-apply-authority={authority.kind}>
      {unreachable !== null ? (
        <p
          className="m-0 flex min-w-0 items-start gap-2 text-ui leading-base text-warn"
          data-fleet-apply-unreachable=""
        >
          <CloudOff size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            This cannot be applied while this browser cannot reach {unreachable.target}. Nothing has been sent and no
            password would be checked, so it simply stays here until that address answers.
          </span>
        </p>
      ) : copy.explanation === '' ? null : (
        // ONE SENTENCE, and no field under it. Saying what applying will ask for BEFORE the click is
        // what `confirmation` on the permissions read exists for; the prompt itself arrives on the click.
        <p className="m-0 flex min-w-0 items-start gap-2 text-meta leading-base text-muted">
          <Lock size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
          <span data-fleet-apply-explanation="">{copy.explanation}</span>
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {/*
          ABSENT ENTIRELY while the daemon is out of reach. A disabled action is still an action on
          screen: it says "this is the control, come back to it", when what is true is that this screen
          has nothing left to offer until the address answers.
        */}
        {unreachable !== null ? null : (
          <button
            type="button"
            className="kt-btn"
            data-variant="primary"
            data-fleet-apply=""
            disabled={blocked}
            onClick={act}
          >
            {busy ? labels.working : labels.action}
          </button>
        )}
        <button type="button" className="kt-btn" data-variant="ghost" disabled={busy} onClick={onDiscard}>
          {labels.discard}
        </button>
      </div>

      {/* THE SHARED PROMPT, not a fleet-specific one: the grants panel raises the same component, so an
          unlock reads the same wherever somebody meets it. It stays open while `busy`, so a refused
          password reports itself where the password was typed rather than behind the panel. */}
      <OperatorUnlockDialog
        open={asking && needsPassword}
        purpose={copy.explanation}
        // `locked` is the only case that MINTS an unlock. A per-change confirmation is spent inside the
        // one request that carries it, so promising a five-minute window there would be false.
        holding={authority.kind === 'locked'}
        busy={busy}
        failure={unlockFailure}
        submitLabel={labels.confirming}
        onSubmit={password => onApply(password)}
        onClose={() => setAsking(false)}
      />
    </div>
  );
}

/** Writes the daemon named that are not plan operations. Reviewing every write has to include these. */
function FleetDocumentList({
  documents,
  headingId,
}: {
  readonly documents: readonly { readonly path: string; readonly bytes: number }[];
  readonly headingId: string;
}) {
  if (documents.length === 0) return null;
  return (
    <section className="border-t border-border-soft" aria-labelledby={headingId}>
      <div className="flex min-w-0 items-center gap-2 px-panel py-2">
        <FileCog size={16} className="shrink-0 text-accent" aria-hidden="true" />
        <h3 id={headingId} className="m-0 text-ui font-semibold text-fg">
          Files written outside the plan
        </h3>
        <span className="kt-badge ml-auto">{documents.length} documents</span>
      </div>
      <ul
        className="m-0 list-none p-0"
        aria-label="Documents this change writes"
        data-fleet-documents={String(documents.length)}
      >
        {documents.map(document => (
          <li key={document.path} className="flex min-w-0 gap-3 border-t border-border-soft px-panel py-1.5 text-meta">
            <PanelPath value={document.path} className="min-w-0 flex-1 text-fg" />
            <span className="shrink-0 tabular-nums text-muted">{document.bytes} B</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What a first run creates, exactly as the daemon derived it. Never a browser's idea of the paths. */
type FleetScaffoldSummary = Extract<FleetProposalPreview, { readonly kind: 'initialize' }>['scaffold'];

/**
 * A FIRST RUN, WHICH IS ONE ACTION AND A LIST — not a staged change.
 *
 * ## WHY THIS IS NOT THE REVIEW PANEL
 *
 * Preparing a host creates what is missing and never replaces a file that already exists, and it has no
 * plan to preview because there is no configuration to plan from. The transaction machinery it used to
 * be dressed in was answering questions this operation does not raise: an EXPIRES timestamp, for a
 * review nobody can be too slow to read; a CONFIG REVISION, printed as `absent` because there is no
 * configuration to have a revision; a "Staged change" heading with a `pending` badge over a proposal
 * state; and Confirm-and-Apply, the second step of a two-step review. Four pieces of ceremony for
 * "create these directories".
 *
 * ## WHAT IT KEEPS, AND WHY THAT IS NOT CEREMONY
 *
 * The list of what will be created stays, and so does the shell line, because they are the disclosure
 * rather than the ritual: nothing here is written before a person has seen the paths it will be written
 * to. The transaction underneath is untouched — this is still one derived artifact, held by the daemon
 * and consumed unchanged — because that is what makes the list on screen the thing that actually runs.
 *
 * The plan-then-apply flow stays exactly as it was for a real EDIT, where a person must see a diff and
 * a concurrent writer has to be detected.
 */
export function FleetFirstRunPlan({
  scaffold,
  documents = [],
  ...controls
}: FleetApplyControls & {
  readonly scaffold: FleetScaffoldSummary;
  /** Anything the daemon says a first run writes beyond the scaffold. Empty today; rendered if not. */
  readonly documents?: readonly { readonly path: string; readonly bytes: number }[];
}) {
  const uid = useId();
  const id = (name: string): string => `${uid}${name}`;
  return (
    <section
      className="kt-panel overflow-hidden border-l-4 border-l-accent"
      data-fleet-first-run=""
      aria-labelledby={id('-first-run-heading')}
      aria-busy={controls.busy}
    >
      <header className="border-b border-border-soft bg-surface-2 px-panel py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ServerCog size={16} className="shrink-0 text-accent" aria-hidden="true" />
          <h2 id={id('-first-run-heading')} className="m-0 text-title font-semibold text-fg">
            Prepare this host
          </h2>
        </div>
        <p className="m-0 mt-1 text-ui leading-base text-muted">
          Creates what is missing and never replaces a file that already exists. Nothing here is a change to something
          you have: this is everything it will write.
        </p>
      </header>

      <section className="px-panel py-3" aria-labelledby={id('-scaffold-heading')}>
        <p className={EYEBROW} id={id('-scaffold-heading')}>
          Directories ({scaffold.directories.length})
        </p>
        <ul className="m-0 mt-1 list-none space-y-1 p-0" aria-label="Directories created">
          {scaffold.directories.map(directory => (
            <li key={directory} className="min-w-0">
              <PanelPath value={directory} className="text-meta text-muted" />
            </li>
          ))}
        </ul>
        <p className={cn(EYEBROW, 'mt-3')}>Files ({scaffold.files.length})</p>
        <ul className="m-0 mt-1 list-none space-y-1 p-0" aria-label="Files seeded">
          {scaffold.files.map(file => (
            <li key={file.path} className="min-w-0">
              <PanelPath value={file.path} className="text-meta text-fg" />
            </li>
          ))}
        </ul>
        <p className="m-0 mt-3 text-meta leading-base text-muted">
          Add to your shell profile afterwards: <PanelPath value={scaffold.pathEntry} className="text-meta text-fg" />
        </p>
      </section>

      <FleetDocumentList documents={documents} headingId={id('-documents-heading')} />

      <FleetApplyForm
        {...controls}
        labels={{
          action: 'Create these files',
          confirming: 'Confirm and create',
          working: 'Creating…',
          discard: 'Not now',
        }}
      />
    </section>
  );
}

/**
 * A staged change WITH A PLAN. A first run is not one of these and has `FleetFirstRunPlan` instead.
 *
 * Narrowed at the type level rather than branched inside the panel, because the branch is what let one
 * component render two operations that need different screens — and the review's own header, the part
 * the owner called ceremony, is meaningless for the other one.
 */
export type FleetStagedChange = Omit<FleetProposalView, 'preview'> & {
  readonly preview: Extract<FleetProposalPreview, { readonly kind: 'apply' }>;
};

export interface FleetChangeReviewProps extends FleetApplyControls {
  readonly proposal: FleetStagedChange;
  /** The live accounts the ledger is compared against. */
  readonly live: readonly FleetManifestAccountView[];
  readonly refusal: FleetRefusalView | null;
}

/**
 * The change manifest: numbered, exact, and one Apply.
 *
 * ## THE PROPOSAL ID IS NOT ON SCREEN
 *
 * It was, and the reason it was is gone with the authorization half: a person used to read it off this
 * panel to compare against the id in `fy fleet authorize <id>`. Nothing mints anything against it now —
 * it is a transaction handle the browser sends back in a path — so showing it would be a 30-character
 * opaque string a reader has no use for, in the place the change itself should be.
 */
export function FleetChangeReview({ proposal, live, refusal, ...controls }: FleetChangeReviewProps) {
  // Instance-local for the same reason as the roster above.
  const uid = useId();
  const id = (name: string): string => `${uid}${name}`;
  const preview = proposal.preview;
  const ledger = operationLedger(preview.plan.operations);
  const rows = rosterDiff(live, preview.plan.manifest.accounts);

  return (
    <section
      className="kt-panel overflow-hidden border-l-4 border-l-accent"
      data-fleet-side="proposed"
      data-fleet-proposal-id={proposal.id}
      aria-labelledby={id('-change-heading')}
      aria-busy={controls.busy}
    >
      <header className="border-b border-border-soft bg-surface-2 px-panel py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ClipboardList size={16} className="shrink-0 text-accent" aria-hidden="true" />
          <h2 id={id('-change-heading')} className="m-0 text-title font-semibold text-fg">
            Staged change
          </h2>
          <span className="kt-badge ml-auto" data-tone={proposal.state === 'pending' ? 'accent' : 'warn'}>
            {proposal.state}
          </span>
        </div>
        <p className="m-0 mt-1 text-ui font-semibold text-fg">{proposal.summary}</p>
        <dl className="m-0 mt-2 grid gap-x-4 gap-y-1 text-meta sm:grid-cols-[auto_minmax(0,1fr)]">
          {/* NO PROPOSAL ID ROW. Nothing is minted against it any more, so it is an opaque handle a
              reader cannot act on — and the expiry and revision are the two facts that decide whether
              this review is still worth applying. It used to be here, wrapped rather than truncated,
              because it was "the one fact a reader came for": they read it off this panel to match the
              id in `fy fleet authorize <id>`. That is the sentence this change makes false. */}
          <dt className={EYEBROW}>Expires</dt>
          <dd className="m-0 font-mono text-meta text-muted">{absoluteTime(proposal.expiresAt)}</dd>
          <dt className={EYEBROW}>Config revision</dt>
          <dd className="m-0 min-w-0">
            <PanelPath value={proposal.revision} className="text-meta text-muted" />
          </dd>
        </dl>
      </header>

      <section className="border-b border-border-soft" aria-labelledby={id('-proposed-roster-heading')}>
        <div className="flex min-w-0 items-center gap-2 px-panel py-2">
          <ArrowRight size={16} className="shrink-0 text-accent" aria-hidden="true" />
          <h3 id={id('-proposed-roster-heading')} className="m-0 text-ui font-semibold text-fg">
            Host after this change
          </h3>
        </div>
        <RosterDiffRows rows={rows} />
      </section>

      <section aria-labelledby={id('-ledger-heading')}>
        <div className="flex min-w-0 items-center gap-2 border-b border-border-soft px-panel py-2">
          <ListOrdered size={16} className="shrink-0 text-accent" aria-hidden="true" />
          <h3 id={id('-ledger-heading')} className="m-0 text-ui font-semibold text-fg">
            Operation ledger
          </h3>
          <span className="kt-badge ml-auto">{ledger.length} operations</span>
        </div>
        {/* A phone stacks each action over its path: a fixed label column leaves a gutter so narrow
                that every path wraps character by character and stops being readable. */}
        <ol className="m-0 list-none p-0" aria-label="Operations this change performs">
          {ledger.map(entry => (
            <li
              key={entry.index}
              className="flex min-w-0 flex-wrap items-baseline gap-x-3 border-b border-border-soft px-panel py-1.5 last:border-b-0 sm:flex-nowrap"
              data-fleet-operation={entry.kind}
            >
              <span className="shrink-0 font-mono text-meta tabular-nums text-faint">
                {String(entry.index).padStart(2, '0')}
              </span>
              <span className="shrink-0 text-meta font-semibold text-fg-soft sm:w-[10.5rem]">{entry.action}</span>
              <span className="min-w-0 flex-1 basis-full pl-6 sm:basis-0 sm:pl-0">
                <PanelPath value={entry.path} className="block text-meta text-fg" />
                {entry.source === undefined ? null : (
                  <span className="block min-w-0 text-meta text-muted">
                    from <PanelPath value={entry.source} className="text-meta text-muted" />
                  </span>
                )}
                {entry.details.length === 0 ? null : (
                  <span
                    className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-meta text-faint"
                    data-fleet-operation-details=""
                  >
                    {entry.details.map(detail => (
                      <span key={detail} className="break-words">
                        {detail}
                      </span>
                    ))}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
        {preview.plan.sharedHistory.length === 0 ? null : (
          <ul
            className="m-0 list-none border-t border-border-soft p-0"
            aria-label="Shared history migrations this change performs"
          >
            {preview.plan.sharedHistory.map(history => (
              <li key={history.kind} className="px-panel py-2 text-meta leading-base text-muted">
                <span className="font-semibold text-fg-soft">{history.kind} history</span> · pool{' '}
                <PanelPath value={history.pool} className="text-meta" /> · {history.migrated} moved, {history.links}{' '}
                linked, {history.conflicts} kept as-is. This step runs AFTER the manifest is published and is not rolled
                back with it.
              </li>
            ))}
          </ul>
        )}
      </section>

      <FleetDocumentList documents={preview.documents} headingId={id('-documents-heading')} />

      {proposal.assetEdits.length === 0 ? null : (
        <ul
          className="m-0 list-none border-t border-border-soft p-0"
          aria-label="Asset text this change carries"
          data-fleet-asset-edits={String(proposal.assetEdits.length)}
        >
          {proposal.assetEdits.map(edit => (
            <li key={edit.path} className="flex min-w-0 gap-3 px-panel py-1.5 text-meta">
              <PanelPath value={edit.path} className="min-w-0 flex-1 text-fg" />
              <span className="shrink-0 tabular-nums text-muted">{edit.bytes} B</span>
            </li>
          ))}
        </ul>
      )}

      {refusal === null ? null : <FleetRefusalAlert refusal={refusal} />}

      <FleetApplyForm
        {...controls}
        labels={{
          action: 'Apply this change',
          confirming: 'Confirm and apply',
          working: 'Applying…',
          discard: 'Discard',
        }}
      />
    </section>
  );
}

/** Daemon text, whole and labelled. A named block beats an unnamed `<pre>` for anyone not looking at it. */
function Reason({ label, text }: { readonly label: string; readonly text: string }) {
  return (
    <div className="mt-2">
      <p className={EYEBROW}>{label}</p>
      <pre className="m-0 mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-meta leading-base">
        {text}
      </pre>
    </div>
  );
}

/** A named list of paths, or nothing at all when there are none. */
function PathList({ label, paths }: { readonly label: string; readonly paths: readonly string[] }) {
  if (paths.length === 0) return null;
  return (
    <div className="mt-2">
      <p className={EYEBROW}>
        {label} ({paths.length})
      </p>
      <ul className="m-0 mt-1 list-none space-y-0.5 p-0">
        {paths.map(path => (
          <li key={path} className="min-w-0">
            <PanelPath value={path} className="text-meta" />
          </li>
        ))}
      </ul>
    </div>
  );
}

const OUTCOME_ICON = { ok: CircleCheck, warn: TriangleAlert, err: CircleAlert } as const;
const OUTCOME_TONE = {
  ok: 'border-ok-border bg-ok-bg text-ok',
  warn: 'border-warn-border bg-warn-bg text-warn',
  err: 'border-err-border bg-err-bg text-err',
} as const;

/**
 * What the host became.
 *
 * The four outcomes are deliberately not collapsed. "Applied", "not applied and verified back",
 * "applied but the history step failed" and "partially applied, state unverified" ask the reader to do
 * four different things, and the last two name exact paths because a person is going to have to go and
 * look at them.
 */
export function FleetApplyReport({ outcome }: { readonly outcome: FleetApplyOutcome }) {
  // Instance-local: the harness states frame renders several surfaces, each of which may hold a report.
  const heading = useId();
  const summary = outcomeSummary(outcome);
  const Icon = OUTCOME_ICON[summary.tone];
  // Residue rather than failure, and reported wherever it appears: it blocks the NEXT apply.
  const lockResidue = outcome.outcome === 'committed' ? outcome.result.lockResidue : outcome.lockResidue;
  return (
    <section
      className={cn('rounded-panel border p-panel', OUTCOME_TONE[summary.tone])}
      data-fleet-outcome={outcome.outcome}
      aria-labelledby={heading}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon size={16} className="shrink-0" aria-hidden="true" />
        <h2 id={heading} className="m-0 text-title font-semibold">
          {summary.title}
        </h2>
      </div>
      <p className="m-0 mt-1 text-ui leading-base">{summary.hostState}</p>

      {outcome.outcome === 'committed' ? (
        <>
          <p className="m-0 mt-2 text-meta leading-base">
            Manifest published at <PanelPath value={outcome.result.manifestPath} className="text-meta" />
          </p>
          {outcome.result.prunedWrappers.length > 0 ? (
            <p className="m-0 mt-2 text-meta leading-base">
              Removed wrappers no account claims any more: {outcome.result.prunedWrappers.join(', ')}
            </p>
          ) : null}
          {/* The migrated / linked / kept counts ARE the shared-history evidence. They are in the
              preview, and the preview is gone the moment the change is applied. */}
          {outcome.result.sharedHistory.map(history => (
            <p key={history.kind} className="m-0 mt-2 text-meta leading-base">
              {history.kind} history · pool <PanelPath value={history.pool} /> · {history.migrated} moved,{' '}
              {history.links} linked, {history.conflicts} kept as-is
            </p>
          ))}
        </>
      ) : null}

      {/* Preparing a host publishes NO manifest, so there is no manifest path to report. What a person
          needs instead is the shell line, without which not one generated wrapper is runnable — and the
          scaffold preview that also carried it is discarded when the change is applied. */}
      {outcome.outcome === 'initialized' ? (
        <>
          <p className={cn(EYEBROW, 'mt-2')}>Add this to your shell profile</p>
          <pre className="m-0 mt-1 overflow-x-auto whitespace-pre font-mono text-meta leading-base">
            {outcome.pathEntry}
          </pre>
          <PathList label="Created" paths={outcome.created} />
          <PathList label="Kept, because they already existed" paths={outcome.kept} />
          <PathList label="Directories" paths={outcome.directories} />
        </>
      ) : null}

      {outcome.outcome === 'initialization-partial' ? (
        <>
          <Reason label="Why it stopped" text={outcome.reason} />
          <p className="m-0 mt-2 text-meta leading-base">
            It stopped at <PanelPath value={outcome.failedPath} />.
          </p>
          <PathList label="Created" paths={outcome.created} />
          <PathList label="Kept, because they already existed" paths={outcome.kept} />
          <PathList label="Directories" paths={outcome.directories} />
        </>
      ) : null}

      {outcome.outcome === 'committed' && outcome.result.backupResidue !== undefined ? (
        <ul className="m-0 mt-2 list-none space-y-1 p-0" aria-label="Moved-aside files left on the host">
          {outcome.result.backupResidue.map(path => (
            <li key={path} className="min-w-0">
              <PanelPath value={path} className="text-meta" />
            </li>
          ))}
        </ul>
      ) : null}

      {lockResidue === undefined ? null : (
        <Reason
          label="An exclusive apply claim is still on the host"
          text={[lockResidue, 'The next apply is blocked until this claim is removed.'].join('\n')}
        />
      )}

      {outcome.outcome === 'committed-with-history-failure' ? (
        <Reason label="What the daemon said" text={outcome.reason} />
      ) : null}

      {outcome.outcome === 'rolled-back' ? <Reason label="Why it stopped" text={outcome.reason} /> : null}

      {outcome.outcome === 'rollback-incomplete' ? (
        <>
          <Reason label="Why it stopped" text={outcome.reason} />
          {outcome.displaced === undefined ? null : (
            <ul className="m-0 mt-2 list-none space-y-1 p-0" aria-label="Content the rollback moved aside">
              {outcome.displaced.map(entry => (
                <li key={entry.path} className="text-meta leading-base">
                  {/* A TYPOGRAPHIC apostrophe, and not only for looks: the daemon-scope gate lexer reads
                      a bare quote in JSX text as the start of a string literal, and the next {' '} closes it —
                      every bracket after that point stops balancing and the gate reports itself desynced. */}
                  <PanelPath value={entry.path} /> was not this apply’s to delete, so it was moved to{' '}
                  <PanelPath value={entry.movedTo} />.
                </li>
              ))}
            </ul>
          )}
          <ul className="m-0 mt-2 list-none space-y-2 p-0" aria-label="Paths whose prior state could not be verified">
            {outcome.unrestored.map(entry => (
              <li key={entry.path} className="rounded-control border border-current/40 p-2">
                <PanelPath value={entry.path} className="block text-meta font-semibold" />
                <p className="m-0 mt-0.5 text-meta leading-base">{entry.reason}</p>
                {entry.backup === undefined ? null : (
                  <p className="m-0 mt-0.5 text-meta leading-base">
                    The only remaining copy of the original is at <PanelPath value={entry.backup} />. Do not delete it.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
