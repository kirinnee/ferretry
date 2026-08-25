/**
 * Claude's own sign-in, on screen. Nothing here is shared with Codex, and that is the design.
 *
 * ## WHAT THIS PANEL REPLACED, AND WHY IT IS A REWRITE
 *
 * `remote-login-surface.tsx` was a finished URL-out / URL-back panel on `main` that dialled nothing. It
 * is gone rather than wired up, because three sentences in it described a DIFFERENT architecture:
 *
 * - "The daemon owns callback-origin and OAuth-state validation" and "The daemon checks the callback
 *   origin and one-time state" — the daemon does neither. It holds no verifier and no state; the harness
 *   child does, and the PKCE challenge is visible in the URL the child prints. A panel that told a person
 *   the daemon validates the exchange would be describing the daemon as the OAuth client, which is the
 *   one design `docs/design/harness-login.md` §0 refuses.
 * - "After the provider redirects to the daemon's localhost callback, copy the complete address-bar URL"
 *   — there is no localhost callback anywhere in this flow. Observed at claude-code 2.1.220, the
 *   `redirect_uri` is `https://platform.claude.com/oauth/code/callback`, a hosted page that SHOWS the
 *   reader a code. So what comes back is a CODE off a web page, and asking for a redirected address asks
 *   for something that never appears.
 *
 * Its `provider: 'claude'` field also could not express Codex, and its step union had no state for a
 * device code. Both were declared GAPs. This panel is Claude's; `codex-login-panel.tsx` is Codex's.
 *
 * ## WHAT IT HOLDS UP FROM THE OLD ONE
 *
 * The one thing that panel got exactly right: the field is cleared BEFORE the request settles, so an
 * authorization code never sits in a rendered tree, a retry affordance, or a screenshot. That behaviour
 * is kept, and so is saying it to the reader.
 *
 * ## THE RISK THIS WORDS, AND THE ONE IT DOES NOT
 *
 * The remote risk here is **account substitution**, not token theft: somebody who can complete this can
 * bind the fleet to a provider account THEY control, and every agent run afterwards authenticates as it.
 * Nothing leaks. The copy says that, and deliberately does not imply a token could be stolen — a warning
 * about the wrong risk teaches people to distrust the right ones.
 */

import { CheckCircle2, KeyRound, Link2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import type { ClaudeLoginFlow, FleetLoginAccountOutcome } from '@ferretry/protocol';
import { cn } from '../../lib/class-names.ts';
import { Button } from '../../shell/primitives.tsx';
import { browserClipboardWriter, type ClipboardWriter, CopyButton } from '../onboarding/copy-button.tsx';

export interface ClaudeLoginPanelProps {
  /** The account a person recognises before granting provider access. */
  readonly accountLabel: string;
  /** `<kind>:<identity>`, so a reader can tell two provider accounts apart. */
  readonly identity: string;
  /** Includes the account being signed in, so one means no sibling copy. */
  readonly memberCount: number;
  /** The live flow, or `null` before one is started. */
  readonly flow: ClaudeLoginFlow | null;
  readonly busy: boolean;
  /** A refusal in the daemon's own words, or `null`. */
  readonly refusal: string | null;
  readonly onStart: () => void;
  readonly onSubmitCode: (code: string) => void;
  readonly onCancel: () => void;
  readonly copy?: ClipboardWriter;
  className?: string;
}

const coverage = (count: number): string =>
  count <= 1 ? 'this account only' : `${String(count - 1)} sibling wrapper${count === 2 ? '' : 's'} too`;

/** How many siblings received the fresh credential, from the fleet's own per-account outcomes. */
const syncedCount = (accounts: readonly FleetLoginAccountOutcome[]): number =>
  accounts.filter(account => account.status === 'synced').length;

const failed = (accounts: readonly FleetLoginAccountOutcome[]): readonly FleetLoginAccountOutcome[] =>
  accounts.filter(account => account.status === 'failed' || account.status === 'indeterminate');

export function ClaudeLoginPanel({
  accountLabel,
  identity,
  memberCount,
  flow,
  busy,
  refusal,
  onStart,
  onSubmitCode,
  onCancel,
  copy = browserClipboardWriter(),
  className,
}: ClaudeLoginPanelProps) {
  const [code, setCode] = useState('');

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (code.trim() === '' || busy) return;
    // Captured only for this request. Clearing before the promise settles is what keeps an authorization
    // code out of the rendered tree, the retry affordance, and any screenshot taken mid-flow.
    const submitted = code;
    setCode('');
    onSubmitCode(submitted);
  };

  const state = flow?.state ?? 'idle';
  return (
    <section
      aria-labelledby={`claude-login-${identity}`}
      data-claude-login={state}
      data-claude-login-identity={identity}
      className={cn('kt-panel overflow-hidden', className)}
    >
      <header className="border-b border-border bg-surface-2 px-panel py-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control border border-accent bg-accent-soft text-accent">
            <KeyRound size={20} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="m-0 text-meta font-semibold text-accent">Claude Code sign-in</p>
            <h3 id={`claude-login-${identity}`} className="m-0 mt-0.5 text-title font-semibold text-fg">
              {accountLabel}
            </h3>
            <p className="m-0 mt-1 text-ui leading-base text-muted">
              Identity <code className="font-mono text-meta text-fg">{identity}</code>
            </p>
          </div>
        </div>
      </header>

      <div className="space-y-4 p-panel">
        <div className="flex items-start gap-2 rounded-control border border-border bg-surface-2 px-3 py-2 text-ui leading-base text-muted">
          <ShieldCheck size={17} className="mt-0.5 shrink-0 text-ok" aria-hidden="true" />
          <p className="m-0">
            One sign-in covers <strong className="font-semibold text-fg">{coverage(memberCount)}</strong>. The harness
            writes its own credential; this daemon never holds one.
          </p>
        </div>

        {refusal === null ? null : (
          <p
            role="alert"
            className="m-0 flex items-start gap-2 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-ui leading-base text-warn"
          >
            <TriangleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
            {refusal}
          </p>
        )}

        {state === 'idle' || state === 'starting' ? (
          <div className="space-y-3">
            <p className="m-0 text-ui leading-base text-muted">
              Start here and open the link on any device. Claude shows you a code once you have signed in — bring that
              code back to this screen.
            </p>
            <Button type="button" variant="primary" onClick={onStart} disabled={busy || state === 'starting'}>
              <Link2 size={16} aria-hidden="true" />
              {state === 'starting' ? 'Starting sign-in…' : 'Sign in to Claude Code'}
            </Button>
          </div>
        ) : null}

        {flow?.state === 'awaiting-code' ? (
          <div className="space-y-4">
            <div className="rounded-control border border-accent/40 bg-accent-soft p-3">
              <p className="m-0 text-meta font-semibold text-accent">1 · Open this link anywhere</p>
              <div className="mt-2 flex min-w-0 items-start gap-2">
                <code className="min-w-0 flex-1 break-all rounded-control border border-border bg-surface px-2 py-2 font-mono text-meta leading-base text-fg">
                  {flow.verificationUrl}
                </code>
                <CopyButton text={flow.verificationUrl} label="Copy the Claude sign-in link" write={copy} />
              </div>
            </div>
            <form className="space-y-2" onSubmit={submit}>
              <label htmlFor={`claude-login-code-${identity}`} className="block text-ui font-semibold text-fg">
                2 · Paste the code Claude showed you
              </label>
              <textarea
                id={`claude-login-code-${identity}`}
                name="claude-login-code"
                className="kt-input min-h-24 w-full resize-y font-mono text-meta"
                value={code}
                onChange={event => setCode(event.target.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                disabled={busy}
                required
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" variant="primary" disabled={busy || code.trim() === ''}>
                  <ShieldCheck size={16} aria-hidden="true" />
                  {busy ? 'Sending…' : 'Finish sign-in'}
                </Button>
                <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
                  Cancel
                </Button>
              </div>
              <p className="m-0 text-meta leading-base text-faint">
                The code goes straight to the harness on the host and is kept nowhere — not here, not in a log, not in
                this daemon. It is never shown back to you.
              </p>
            </form>
          </div>
        ) : null}

        {flow?.state === 'complete' ? (
          <div
            className="flex items-start gap-3 rounded-control border border-ok/40 bg-ok-soft p-3 text-ui leading-base text-fg"
            role="status"
          >
            <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-ok" aria-hidden="true" />
            <div className="min-w-0">
              {failed(flow.accounts).length === 0 ? (
                <>
                  <p className="m-0 font-semibold">Signed in to {accountLabel}</p>
                  <p className="m-0 mt-1 text-muted">
                    {syncedCount(flow.accounts) === 0
                      ? 'No sibling wrapper needed a copy.'
                      : `The credential was verified and copied to ${String(syncedCount(flow.accounts))} sibling wrapper${syncedCount(flow.accounts) === 1 ? '' : 's'}.`}
                  </p>
                </>
              ) : (
                <>
                  {/* "account", not "lane": the list under it is wrapper names, which is what a
                      person calls these, and `lane` is a word only the configuration schema has. */}
                  <p className="m-0 font-semibold">This sign-in finished without settling every account</p>
                  <ul className="m-0 mt-1 list-none space-y-1 p-0 text-muted">
                    {failed(flow.accounts).map(account => (
                      <li key={account.accountId} className="m-0">
                        <code className="font-mono text-meta">{account.accountId}</code> — {account.status}
                        {account.message === undefined ? '' : `: ${account.message}`}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        ) : null}

        {flow?.state === 'failed' ? (
          <div
            role="alert"
            className="space-y-2 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-ui leading-base text-warn"
          >
            <p className="m-0 flex items-start gap-2">
              <TriangleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
              {flow.reason}
            </p>
            <p className="m-0 text-meta leading-base">{flow.remedy}</p>
            <Button type="button" variant="outline" onClick={onStart} disabled={busy}>
              <Link2 size={16} aria-hidden="true" />
              Start a new sign-in
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
