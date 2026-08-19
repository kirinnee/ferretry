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
  FileCog,
  ListOrdered,
  Lock,
  ServerCog,
  TriangleAlert,
} from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import { EYEBROW, FIELD_LABEL, PanelPath } from '../../shell/panel-typography.tsx';
import { type OperatorUnlockFailure, UNLOCK_LIMIT_NOTE } from '../../lib/grants.ts';
import { absoluteTime } from '../../lib/session-screens.ts';
import type { FleetApplyOutcome, FleetManifestAccountView, FleetProposalView, FleetRefusalView } from './fleet-api.ts';
import {
  type FleetApplyAuthority,
  fleetApplyCopy,
  fleetApplyNeedsPassword,
  type FleetRosterChange,
  type FleetRosterRow,
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
}: {
  readonly accounts: readonly FleetManifestAccountView[];
  readonly generatedAt: string;
  readonly onEdit: (account: FleetManifestAccountView) => void;
  readonly editable: boolean;
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
              <AccountLine account={account} />
              <button
                type="button"
                className="kt-btn kt-btn--sm ml-auto shrink-0"
                disabled={!editable}
                onClick={() => onEdit(account)}
              >
                Edit layer
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

export interface FleetChangeReviewProps {
  readonly proposal: FleetProposalView;
  /** The live accounts the ledger is compared against. */
  readonly live: readonly FleetManifestAccountView[];
  readonly authority: FleetApplyAuthority;
  /**
   * Applies the change, with the operator password when one was asked for.
   *
   * ONE ARGUMENT, because there is one secret. The panel does not decide whether it becomes an unlock,
   * a confirmation or both — the surface does, from the same authority this component renders — and a
   * component that split it into two callbacks would be the second place that decision could be made
   * differently.
   */
  readonly onApply: (operatorPassword?: string) => void;
  readonly onDiscard: () => void;
  readonly busy: boolean;
  readonly refusal: FleetRefusalView | null;
  /** Why the last operator password was refused, so a wrong one is retyped rather than re-guessed at. */
  readonly unlockFailure?: OperatorUnlockFailure | null;
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
export function FleetChangeReview({
  proposal,
  live,
  authority,
  onApply,
  onDiscard,
  busy,
  refusal,
  unlockFailure = null,
}: FleetChangeReviewProps) {
  // Instance-local for the same reason as the roster above.
  const uid = useId();
  const id = (name: string): string => `${uid}${name}`;
  /**
   * The typed password, held HERE and nowhere above.
   *
   * It is the one value on this screen that must not reach the session state the surface keys by
   * connection: a secret in there outlives the click that needed it, survives every unrelated re-render,
   * and shows up in anything that inspects the state. It lives for one submit and is cleared by it.
   */
  const [password, setPassword] = useState('');
  const preview = proposal.preview;
  const ledger = preview.kind === 'apply' ? operationLedger(preview.plan.operations) : [];
  const rows = preview.kind === 'apply' ? rosterDiff(live, preview.plan.manifest.accounts) : [];
  const copy = fleetApplyCopy(authority);
  const needsPassword = fleetApplyNeedsPassword(authority);
  const applyBlocked = busy || authority.kind === 'refused' || (needsPassword && password === '');

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (applyBlocked) return;
    onApply(needsPassword ? password : undefined);
    // Cleared on submit rather than on success, exactly as the grants surface clears its own: a wrong
    // password is retyped, and holding the last attempt in a field is one more place the value sits
    // while somebody walks away from the screen.
    setPassword('');
  };

  return (
    <section
      className="kt-panel overflow-hidden border-l-4 border-l-accent"
      data-fleet-side="proposed"
      data-fleet-proposal-id={proposal.id}
      aria-labelledby={id('-change-heading')}
      aria-busy={busy}
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

      {preview.kind === 'initialize' ? (
        <section className="px-panel py-3" aria-labelledby={id('-scaffold-heading')}>
          <h3 id={id('-scaffold-heading')} className="m-0 text-ui font-semibold text-fg">
            First run
          </h3>
          <p className="m-0 mt-1 text-meta leading-base text-muted">
            Creates what is missing and never replaces a file that already exists. There is no plan to preview yet
            because this host has no fleet configuration to plan from.
          </p>
          <ul className="m-0 mt-2 list-none space-y-1 p-0" aria-label="Directories created">
            {preview.scaffold.directories.map(directory => (
              <li key={directory} className="min-w-0">
                <PanelPath value={directory} className="text-meta text-muted" />
              </li>
            ))}
          </ul>
          <ul className="m-0 mt-2 list-none space-y-1 p-0" aria-label="Files seeded">
            {preview.scaffold.files.map(file => (
              <li key={file.path} className="min-w-0">
                <PanelPath value={file.path} className="text-meta text-fg" />
              </li>
            ))}
          </ul>
          <p className="m-0 mt-2 text-meta leading-base text-muted">
            Add to your shell profile afterwards:{' '}
            <PanelPath value={preview.scaffold.pathEntry} className="text-meta text-fg" />
          </p>
        </section>
      ) : (
        <>
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
                    linked, {history.conflicts} kept as-is. This step runs AFTER the manifest is published and is not
                    rolled back with it.
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {preview.documents.length === 0 ? null : (
        <section className="border-t border-border-soft" aria-labelledby={id('-documents-heading')}>
          <div className="flex min-w-0 items-center gap-2 px-panel py-2">
            <FileCog size={16} className="shrink-0 text-accent" aria-hidden="true" />
            <h3 id={id('-documents-heading')} className="m-0 text-ui font-semibold text-fg">
              Files written outside the plan
            </h3>
            <span className="kt-badge ml-auto">{preview.documents.length} documents</span>
          </div>
          <ul
            className="m-0 list-none p-0"
            aria-label="Documents this change writes"
            data-fleet-documents={String(preview.documents.length)}
          >
            {preview.documents.map(document => (
              <li
                key={document.path}
                className="flex min-w-0 gap-3 border-t border-border-soft px-panel py-1.5 text-meta"
              >
                <PanelPath value={document.path} className="min-w-0 flex-1 text-fg" />
                <span className="shrink-0 tabular-nums text-muted">{document.bytes} B</span>
              </li>
            ))}
          </ul>
        </section>
      )}

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

      {/*
        ONE FORM, ONE FIELD, ONE BUTTON. There is no heading over it and deliberately so: a "Host
        authority" section was the fleet advertising an authority system of its own, and what is left is
        the ordinary thing every other governed control does — say what is true when it is not a plain
        yes, and offer the one step that resolves it.
      */}
      <form
        className="border-t border-border-soft bg-surface-2 px-panel py-3"
        data-fleet-apply-authority={authority.kind}
        onSubmit={submit}
      >
        {copy.explanation === '' ? null : (
          <p className="m-0 flex min-w-0 items-start gap-2 text-meta leading-base text-muted">
            <Lock size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
            <span data-fleet-apply-explanation="">{copy.explanation}</span>
          </p>
        )}

        {needsPassword ? (
          <>
            <label className={cn(FIELD_LABEL, 'mt-3')} htmlFor={id('-operator-password')}>
              Operator password for this machine
            </label>
            <input
              id={id('-operator-password')}
              type="password"
              className="kt-input"
              value={password}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              data-fleet-operator-password=""
              onChange={event => setPassword(event.target.value)}
            />
            {unlockFailure === null ? (
              <p className="m-0 mt-1 text-meta leading-base text-faint">{UNLOCK_LIMIT_NOTE}</p>
            ) : (
              <p
                role="alert"
                className={cn(
                  'm-0 mt-1 rounded-control border px-2 py-1 text-meta leading-base',
                  unlockFailure.retryable
                    ? 'border-warn-border bg-warn-bg text-warn'
                    : 'border-err-border bg-err-bg text-err',
                )}
                data-fleet-operator-password-failure={unlockFailure.retryable ? 'retryable' : 'final'}
              >
                {unlockFailure.message}
              </p>
            )}
          </>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-2">
          {/*
            A SUBMIT, not a click handler, so Enter in the password field applies the change rather than
            doing nothing — which is what a person types after a password every time.
          */}
          <button type="submit" className="kt-btn" data-variant="primary" data-fleet-apply="" disabled={applyBlocked}>
            {busy ? 'Applying…' : needsPassword ? 'Confirm and apply' : 'Apply this change'}
          </button>
          <button type="button" className="kt-btn" data-variant="ghost" disabled={busy} onClick={onDiscard}>
            Discard
          </button>
        </div>
      </form>
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
