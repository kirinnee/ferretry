/**
 * THE ACCOUNTS PANEL, as pixels. Props only — it reads nothing and dials nothing.
 *
 * Split from `accounts-page.tsx` so the whole screen can be rendered from a fixture: at a fixed
 * instant, in every health state, at 390px, in the visual harness. Every UI defect in this project so
 * far was found by looking at one of those captures, and a surface that could only be reached through
 * three live reads cannot be looked at.
 *
 * ## IT IS A PANEL, AND THE TYPE SCALE SAYS SO
 *
 * This was a top-level route, so it opened with a `text-display` page title and `text-title` group
 * headings. It is now the child panel of Fleet inside the daemon settings frame — one rung below the
 * machine's own name — and the headings step down with it. Nothing else about the surface changed:
 * the same states, the same rows, the same one button per account.
 *
 * ## ONE ROW, ONE ACCOUNT, ONE BUTTON
 *
 * The button on a row carries that row's own `accountId`. This is the whole reason the page exists in
 * this shape: the surface it replaced offered one control per provider login and started the sign-in
 * of whichever member was listed first, so somebody trying to fix `claude-auto-default` signed
 * `claude-default` in and nothing said so. `chooseLoginDriver` fixed the daemon half of that; this is
 * the browser half.
 *
 * ## WHAT IS SAID WHEN THERE IS NOTHING TO PRESS
 *
 * Two different nothings, and they are not merged. An account whose credential comes from a file, the
 * environment or the configuration gets the sentence naming where it comes from — signing in would
 * write a store nobody reads. An account the fleet publishes as unavailable gets its own sentence,
 * because a sign-in there would succeed and still leave a wrapper no session can launch.
 *
 * ## THE INSTANT IS PART OF THE VERDICT
 *
 * `Healthy` with no time beside it is a claim with no expiry, and the host's evidence has a
 * fifteen-minute horizon. So every row prints both, from `account-health-view.ts`, and the exact UTC
 * instant reaches a `<time dateTime>` while the visible label stays the relative one.
 */

import { CircleAlert, KeyRound, Plus, RefreshCw, ShieldQuestion, UserRoundPlus } from 'lucide-react';
import type { HarnessLoginFlow } from '@ferretry/protocol';

import { AccountHealthCheck, type AccountHealthCheckProps } from '../../components/daemon-pickers.tsx';
import { absoluteInstantLabel, type AccountHealthTone } from '../../lib/account-health-view.ts';
import { cn } from '../../lib/class-names.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import { ModeBadge } from '../../shell/mode-badge.tsx';
import { Button } from '../../shell/primitives.tsx';
import type { AccountRowView, AccountsHarnessGroup, AccountsRosterView } from './accounts-model.ts';
import { ClaudeLoginPanel } from './claude-login-panel.tsx';
import { CodexLoginPanel } from './codex-login-panel.tsx';

/** A positive read is required before this page may say a daemon has no accounts. */
export type AccountsReadState =
  | { readonly kind: 'reading' }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'ready'; readonly roster: AccountsRosterView };

export interface AccountsSurfaceProps {
  /** The only daemon whose accounts this surface may render. */
  readonly daemonId: DaemonId;
  readonly state: AccountsReadState;
  /** Live sign-ins, keyed by the account whose wrapper is showing the browser. */
  readonly flows: Readonly<Record<string, HarnessLoginFlow>>;
  /** A refusal beside a roster that still rendered, in the daemon's own words. */
  readonly refusal: string | null;
  readonly busy: boolean;
  /** False when this caller may inspect and not act: the control says so instead of vanishing. */
  readonly mayStart: boolean;
  /** The shared "prove it again, now" control's state. */
  readonly healthCheck: AccountHealthCheckProps;
  /**
   * Open the panel where one is added — Fleet, the panel this one hangs off.
   *
   * A CONTROL RATHER THAN A LINK, because there is no longer an address to link to. This surface used
   * to be a route and sent people to `…/settings#daemons`; it is now the child panel of Fleet in the
   * same frame, and the honest control for "show me the sibling panel" is a button. A `RouteLink` here
   * would have to invent a pathname that no router resolves.
   */
  readonly onAddAccount: () => void;
  readonly onReRead: () => void;
  readonly onStart: (row: AccountRowView) => void;
  /** Ask this account's credential to renew itself: no browser, nobody sent anywhere, one call. */
  readonly onRenew: (row: AccountRowView) => void;
  readonly onSubmitCode: (flow: HarnessLoginFlow, code: string) => void;
  readonly onCancel: (flow: HarnessLoginFlow) => void;
  className?: string;
}

/**
 * The health pill's colours. `muted` is the never-checked case and is deliberately the quietest of the
 * four: it is the absence of a verdict, not a warning.
 */
const HEALTH_PILL: Readonly<Record<AccountHealthTone, string>> = {
  ok: 'border-ok-border bg-ok-bg text-ok',
  bad: 'border-err-border bg-err-bg text-err',
  warn: 'border-warn-border bg-warn-bg text-warn',
  muted: 'border-border bg-surface text-muted',
};

/** One account's verdict and the instant behind it, in the words every health surface shares. */
function AccountHealthLine({ row }: { readonly row: AccountRowView }) {
  const view = row.health;
  return (
    <p
      className="m-0 mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-meta leading-base"
      data-account-health={view.tone}
    >
      <span
        className={cn('shrink-0 rounded-full border px-2 py-0.5 font-medium', HEALTH_PILL[view.tone])}
        title={view.detail}
      >
        {view.label}
      </span>
      {row.checkedAt === null ? (
        <span className="min-w-0 text-muted">{view.checked}</span>
      ) : (
        <time className="min-w-0 text-muted" dateTime={absoluteInstantLabel(row.checkedAt)}>
          {view.checked}
        </time>
      )}
      {view.detailIsImplied ? null : <span className="min-w-0 text-muted">{view.detail}</span>}
      {view.secondary === undefined ? null : <span className="min-w-0 text-warn">{view.secondary}</span>}
    </p>
  );
}

/**
 * The controls this row offers, or the reason it has none.
 *
 * RENEW LEADS WHEN IT IS THERE, and that is the whole point of offering it. It is the cheap answer —
 * no browser, nobody sent anywhere, one call — and it exists exactly where a person would otherwise
 * reach for the expensive one. A row that put "Sign in again" first and a renewal second would still
 * be teaching somebody to spend an approval on a credential that could rotate itself.
 */
function AccountSignIn({
  row,
  busy,
  mayStart,
  onStart,
  onRenew,
}: {
  readonly row: AccountRowView;
  readonly busy: boolean;
  readonly mayStart: boolean;
  readonly onStart: () => void;
  readonly onRenew: () => void;
}) {
  if (row.signIn.kind === 'offered') {
    return (
      <div className="flex shrink-0 flex-wrap items-start gap-2">
        {row.renew.kind === 'none' ? null : (
          <Button
            type="button"
            className="min-h-[44px] shrink-0"
            disabled={busy || !mayStart}
            onClick={onRenew}
            data-account-renew={row.accountId}
          >
            <RefreshCw size={15} aria-hidden="true" />
            {row.renew.label}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          // Pointer-derived floor: the LABEL is what a finger lands on, so the height is set here
          // rather than trusted to the button's resting padding at this text size.
          className="min-h-[44px] shrink-0"
          disabled={busy || !mayStart}
          onClick={onStart}
          data-account-sign-in={row.accountId}
        >
          <KeyRound size={15} aria-hidden="true" />
          {row.signIn.label}
        </Button>
      </div>
    );
  }
  if (row.signIn.kind === 'unavailable') {
    return (
      <p className="m-0 min-w-0 text-meta leading-base text-muted" data-account-no-sign-in="unavailable">
        {row.signIn.detail}
      </p>
    );
  }
  return (
    <div className="min-w-0" data-account-no-sign-in="elsewhere">
      <span className="kt-badge" data-tone="accent" data-account-source={row.signIn.source}>
        {row.signIn.badge}
      </span>
      <p className="m-0 mt-1 text-meta leading-base text-muted">{row.signIn.detail}</p>
    </div>
  );
}

function AccountRow({
  row,
  flow,
  busy,
  mayStart,
  onStart,
  onRenew,
  onSubmitCode,
  onCancel,
}: {
  readonly row: AccountRowView;
  readonly flow: HarnessLoginFlow | undefined;
  readonly busy: boolean;
  readonly mayStart: boolean;
  readonly onStart: () => void;
  readonly onRenew: () => void;
  readonly onSubmitCode: (flow: HarnessLoginFlow, code: string) => void;
  readonly onCancel: (flow: HarnessLoginFlow) => void;
}) {
  return (
    <li
      data-account-row={row.accountId}
      // `border-border`, never `border-border-soft`: a soft hairline is invisible against `surface-2`,
      // and these rows sit inside a panel whose body is exactly that.
      className="min-w-0 border-t border-border py-3 first:border-t-0 first:pt-0"
    >
      {/* Stacked below `sm` and split above it. At 390px the identity column and a 44px control
          cannot both have the width, and truncating a wrapper name is the one thing a roster must
          never do: two rows can then look identical while somebody chooses between them. */}
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <p className="m-0 flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 break-words text-ui font-semibold text-fg">{row.label}</span>
            <ModeBadge mode={row.mode} />
            {row.available ? null : (
              <span className="shrink-0 rounded-full border border-warn-border bg-warn-bg px-2 py-0.5 text-meta font-medium text-warn">
                Unavailable
              </span>
            )}
          </p>
          <code className="mt-0.5 block min-w-0 break-all font-mono text-meta text-muted">{row.wrapper}</code>
          <AccountHealthLine row={row} />
          <p className="m-0 mt-1 text-meta leading-base text-muted">{row.credential}</p>
          <p className="m-0 mt-1 text-meta leading-base text-muted" data-account-usage={row.usageKind}>
            {row.usage}
          </p>
          <p className="m-0 mt-1 text-meta leading-base text-faint" data-account-login={row.login.identity}>
            {row.login.identity} · {row.login.summary}
            {row.login.state === undefined ? '' : ` ${row.login.state}`}
          </p>
        </div>
        <AccountSignIn row={row} busy={busy} mayStart={mayStart} onStart={onStart} onRenew={onRenew} />
      </div>

      {/* The live sign-in sits under the row it belongs to, so the account on screen and the account
          being signed in are the same one a person is looking at. */}
      {flow === undefined ? null : flow.harness === 'claude' ? (
        <ClaudeLoginPanel
          className="mt-3"
          accountLabel={row.label}
          identity={row.login.identity}
          memberCount={row.login.memberCount}
          flow={flow}
          busy={busy || !mayStart}
          refusal={null}
          onStart={onStart}
          onSubmitCode={code => onSubmitCode(flow, code)}
          onCancel={() => onCancel(flow)}
        />
      ) : (
        <CodexLoginPanel
          className="mt-3"
          accountLabel={row.label}
          identity={row.login.identity}
          memberCount={row.login.memberCount}
          flow={flow}
          busy={busy || !mayStart}
          refusal={null}
          onStart={onStart}
          onCancel={() => onCancel(flow)}
        />
      )}
    </li>
  );
}

function HarnessGroup({
  group,
  flows,
  busy,
  mayStart,
  onStart,
  onRenew,
  onSubmitCode,
  onCancel,
}: {
  readonly group: AccountsHarnessGroup;
  readonly flows: Readonly<Record<string, HarnessLoginFlow>>;
  readonly busy: boolean;
  readonly mayStart: boolean;
  readonly onStart: (row: AccountRowView) => void;
  readonly onRenew: (row: AccountRowView) => void;
  readonly onSubmitCode: (flow: HarnessLoginFlow, code: string) => void;
  readonly onCancel: (flow: HarnessLoginFlow) => void;
}) {
  return (
    <section
      className="kt-panel overflow-hidden"
      data-accounts-harness={group.kind}
      aria-labelledby={`accounts-${group.kind}`}
    >
      <header className="border-b border-border bg-surface-2 px-panel py-3">
        {/* One rung under this panel's own heading, which is `text-row`: a harness group is a section
            INSIDE Accounts, and while this was a route it was a `text-title` section under a
            `text-display` page title. The ladder moved down with the panel. */}
        <h4 id={`accounts-${group.kind}`} className="m-0 text-ui font-semibold text-fg">
          {group.label}
          <span className="ml-2 text-meta font-normal text-muted">
            {group.rows.length === 1 ? '1 account' : `${String(group.rows.length)} accounts`}
          </span>
        </h4>
        {/* Said HERE rather than in a document: this is the screen where somebody is about to assume
            the wrong one of the two. */}
        <p className="m-0 mt-1 text-cell leading-base text-fg" data-accounts-sharing={group.kind}>
          {group.sharing.headline}
        </p>
        <p className="m-0 mt-0.5 text-meta leading-base text-muted">{group.sharing.detail}</p>
      </header>
      <ul className="m-0 list-none p-panel" aria-label={`${group.label} accounts`}>
        {group.rows.map(row => (
          <AccountRow
            key={row.accountId}
            row={row}
            flow={flows[row.accountId]}
            busy={busy}
            mayStart={mayStart}
            onStart={() => onStart(row)}
            onRenew={() => onRenew(row)}
            onSubmitCode={onSubmitCode}
            onCancel={onCancel}
          />
        ))}
      </ul>
    </section>
  );
}

export function AccountsSurface({
  daemonId,
  state,
  flows,
  refusal,
  busy,
  mayStart,
  healthCheck,
  onAddAccount,
  onReRead,
  onStart,
  onRenew,
  onSubmitCode,
  onCancel,
  className,
}: AccountsSurfaceProps) {
  return (
    <section
      data-accounts-surface={state.kind}
      data-accounts-daemon-id={String(daemonId)}
      aria-labelledby="accounts-heading"
      className={cn('min-w-0 space-y-3', className)}
    >
      <header className="kt-panel overflow-hidden">
        <div className="border-b border-border bg-surface-2 px-panel py-3">
          {/* A PANEL HEADING, not a page title. This surface is the child panel of Fleet inside the
              daemon settings frame, one rung below the machine's own name — the ladder
              `settings-page.tsx` sets out. It was `text-display` while it was a route of its own, and
              leaving it there would have made the panel shout over the frame it now sits in. */}
          <h3 id="accounts-heading" className="m-0 text-row font-semibold text-fg">
            Accounts
          </h3>
          <p className="m-0 mt-1 text-cell leading-base text-muted">
            Every account this daemon can run, what its provider last said about it, and when that was checked.
          </p>
        </div>
        <div className="space-y-3 p-panel">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="primary"
              className="min-h-[44px]"
              onClick={onAddAccount}
              data-accounts-add=""
            >
              <Plus size={15} aria-hidden="true" />
              Add an account
            </Button>
            <Button type="button" variant="outline" className="min-h-[44px]" onClick={onReRead} disabled={busy}>
              <RefreshCw size={15} aria-hidden="true" />
              Re-read
            </Button>
          </div>
          <p className="m-0 text-meta leading-base text-muted">
            Adding one opens Fleet, the panel above this one, where the change is reviewed before anything is written.
          </p>
          <AccountHealthCheck {...healthCheck} />
        </div>
      </header>

      {refusal === null ? null : (
        <p
          role="alert"
          data-accounts-refusal=""
          className="m-0 flex items-start gap-2 whitespace-pre-wrap rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-ui leading-base text-warn"
        >
          <CircleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
          {refusal}
        </p>
      )}

      {state.kind === 'reading' ? (
        <p className="m-0 text-ui leading-base text-muted">Reading the accounts on this daemon…</p>
      ) : state.kind === 'unavailable' ? (
        <div className="kt-panel flex items-start gap-3 border-warn-border p-panel">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control border border-warn-border bg-warn-bg text-warn">
            <ShieldQuestion size={20} aria-hidden="true" />
          </span>
          {/* A read that failed is NEVER rendered as zero accounts: a daemon that could not answer
              still has whatever accounts it has, and an empty roster is a claim. */}
          <p className="m-0 min-w-0 text-ui leading-base text-muted">{state.reason}</p>
        </div>
      ) : state.roster.total === 0 ? (
        <div className="kt-panel flex items-start gap-3 p-panel">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control border border-border bg-surface-2 text-muted">
            <UserRoundPlus size={20} aria-hidden="true" />
          </span>
          <p className="m-0 min-w-0 text-ui leading-base text-muted">
            This daemon publishes no account yet. Add one and it appears here with its own sign-in.
          </p>
        </div>
      ) : (
        state.roster.groups.map(group => (
          <HarnessGroup
            key={group.kind}
            group={group}
            flows={flows}
            busy={busy}
            mayStart={mayStart}
            onStart={onStart}
            onRenew={onRenew}
            onSubmitCode={onSubmitCode}
            onCancel={onCancel}
          />
        ))
      )}
    </section>
  );
}
