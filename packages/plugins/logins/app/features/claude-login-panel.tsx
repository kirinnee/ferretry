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

import type { ClaudeLoginFlow, HarnessLoginLastCode } from '../../contract/index.ts';
import { CheckCircle2, KeyRound, Link2, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { cn, SecretInput, useSecretField } from '../ui.ts';
import { Button } from '../ui.ts';
import { browserClipboardWriter, type ClipboardWriter } from '../ui.ts';
import { SignInDemo } from './sign-in-demo.tsx';
import { ResumedNote, SignInAnswers, SignInLink, StartOverButton } from './sign-in-restart.tsx';
import type { LoginPanelWording } from '../lib/harness-login-model.ts';

export interface ClaudeLoginPanelProps {
  /** The login a person recognises before granting provider access. */
  readonly accountLabel: string;
  /** The login's id, which keeps this panel's element ids unique on a page with several. */
  readonly loginId: string;
  /** The live flow, or `null` before one is started. */
  readonly flow: ClaudeLoginFlow | null;
  readonly busy: boolean;
  /** A refusal in the daemon's own words, or `null`. */
  readonly refusal: string | null;
  readonly onStart: () => void;
  readonly onSubmitCode: (code: string) => void;
  readonly onCancel: () => void;
  /** End this sign-in and start a fresh one. Offered while one is running; absent where nothing can. */
  readonly onStartOver?: () => void;
  /**
   * Look in the login's store again, launching nothing. Offered only on a sign-in whose harness
   * finished but whose login was not found (`recheck`): it may have landed late.
   */
  readonly onRecheck?: () => void;
  readonly copy?: ClipboardWriter;
  /** What one sign-in covers, and what to say once it is done. */
  readonly wording: LoginPanelWording;
  className?: string;
}

/**
 * What to say when a sign-in ended because of its code, in place of the host command every other failure
 * names: somebody holding a browser needs a fresh link and code, not a terminal.
 */
const codeEnding = (
  lastCode: HarnessLoginLastCode | undefined,
): { readonly sentence: string; readonly next: string; readonly action: string } | null => {
  if (lastCode === 'rejected') {
    return {
      sentence: 'Claude didn’t accept that code.',
      next: 'Try again to get a fresh link, then paste the whole code Claude shows you.',
      action: 'Try again',
    };
  }
  if (lastCode === 'expired') {
    return {
      sentence: 'That sign-in link expired before a code was accepted.',
      next: 'Get a new link and sign in again.',
      action: 'Get a new link',
    };
  }
  return null;
};

export function ClaudeLoginPanel({
  accountLabel,
  loginId,
  flow,
  busy,
  refusal,
  onStart,
  onSubmitCode,
  onCancel,
  onStartOver,
  onRecheck,
  copy = browserClipboardWriter(),
  wording,
  className,
}: ClaudeLoginPanelProps) {
  // One line, masked like a password, never in React state or in the DOM's attributes: the shared secret field.
  const code = useSecretField(typed => typed.trim().length);
  /** The code is on its way (not a start-over or a cancel, which also hold `busy`): only then does Finish show the spinner. */
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (!busy) setSending(false);
  }, [busy]);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!code.filled || busy) return;
    // Captured only for this request. Clearing before the promise settles is what keeps an authorization
    // code out of the rendered tree, the retry affordance, and any screenshot taken mid-flow.
    const submitted = code.read();
    code.clear();
    setSending(true);
    onSubmitCode(submitted);
  };

  const state = flow?.state ?? 'idle';
  /** What went wrong, said under the buttons in a space that is always there, so the options never move when it appears. */
  const waitingForCode = flow?.state === 'awaiting-code';
  return (
    <section
      aria-labelledby={`claude-login-${loginId}`}
      data-claude-login={state}
      data-claude-login-identity={loginId}
      className={cn('kt-panel overflow-hidden', className)}
    >
      <header className="border-b border-border bg-surface-2 px-panel py-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control border border-accent bg-accent-soft text-accent">
            <KeyRound size={20} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="m-0 text-meta font-semibold text-accent">Claude Code sign-in</p>
            <h3 id={`claude-login-${loginId}`} className="m-0 mt-0.5 text-title font-semibold text-fg">
              {accountLabel}
            </h3>
          </div>
        </div>
      </header>

      <div className="space-y-4 p-panel">
        <div className="flex items-start gap-2 rounded-control border border-border bg-surface-2 px-3 py-2 text-ui leading-base text-muted">
          <ShieldCheck size={17} className="mt-0.5 shrink-0 text-ok" aria-hidden="true" />
          <p className="m-0">{wording.coverage}</p>
        </div>

        {refusal === null || waitingForCode ? null : (
          <p
            role="alert"
            className="fy-shake m-0 flex items-start gap-2 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-ui leading-base text-warn"
          >
            <TriangleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
            {refusal}
          </p>
        )}

        <ResumedNote flow={flow} />

        {state === 'idle' || state === 'starting' ? (
          <div className="space-y-3">
            <p className="m-0 text-ui leading-base text-muted">
              Open the link, sign in, then bring the code Claude shows back here.
            </p>
            <div className="flex flex-wrap items-center gap-3" data-sign-in-actions="">
              <Button
                type="button"
                variant="primary"
                onClick={onStart}
                disabled={busy}
                icon={<Link2 size={16} />}
                busy={state === 'starting'}
                busyLabel="Starting sign-in…"
              >
                Sign in to Claude Code
              </Button>
              {state === 'starting' ? <StartOverButton onStartOver={onStartOver} busy={busy} /> : null}
            </div>
          </div>
        ) : null}

        {flow?.state === 'awaiting-code' ? (
          <div className="fy-sd-host" data-claude-login-code="">
            <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
              <div className="fy-sd-layout">
                <div className="fy-sd-steps space-y-4" data-sign-in-steps="">
                  <div className="rounded-control border border-accent/40 bg-accent-soft p-3">
                    <p className="m-0 text-meta font-semibold text-accent">1 · Open this link anywhere</p>
                    <SignInLink url={flow.verificationUrl} copy={copy} />
                  </div>
                </div>
                <SignInDemo kind="code" />
                <form className="fy-sd-form space-y-2" onSubmit={submit}>
                  <label htmlFor={`claude-login-code-${loginId}`} className="block text-ui font-semibold text-fg">
                    2 · Paste the code Claude showed you
                  </label>
                  <SecretInput
                    id={`claude-login-code-${loginId}`}
                    field={code}
                    className="kt-input w-full font-mono text-meta"
                    required
                  />
                  <SignInAnswers
                    finishLabel={wording.finishLabel ?? 'Finish sign-in'}
                    finishDisabled={!code.filled}
                    finishBusy={sending && busy}
                    finishBusyLabel="Sending…"
                    busy={busy}
                    onStartOver={onStartOver}
                    onCancel={onCancel}
                  />
                  <p className="m-0 text-meta leading-base text-faint">
                    Goes straight to Claude on this machine. Kept nowhere, never shown back.
                  </p>
                  <div className="fy-sd-notes" data-sign-in-notes="" aria-live="polite">
                    {refusal === null ? null : (
                      <p
                        role="alert"
                        className="fy-shake m-0 flex items-start gap-2 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-ui leading-base text-warn"
                      >
                        <TriangleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
                        {refusal}
                      </p>
                    )}
                    {refusal === null && flow.lastCode === 'rejected' ? (
                      <p
                        role="alert"
                        data-claude-login-rejected=""
                        className="fy-shake m-0 flex items-start gap-2 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-ui leading-base text-warn"
                      >
                        <TriangleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
                        <span>
                          <strong className="font-semibold">Claude didn’t accept that code.</strong> Copy the whole code
                          from the Claude page — every character — and paste it again above.
                        </span>
                      </p>
                    ) : null}
                  </div>
                </form>
              </div>
            </fieldset>
          </div>
        ) : null}

        {flow?.state === 'complete' ? (
          <div
            className="flex items-start gap-3 rounded-control border border-ok/40 bg-ok-bg p-3 text-ui leading-base text-fg"
            role="status"
          >
            <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-ok" aria-hidden="true" />
            <div className="min-w-0">
              <p className="m-0 font-semibold">{wording.signedIn}</p>
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
              {codeEnding(flow.lastCode)?.sentence ?? flow.reason}
            </p>
            <p className="m-0 text-meta leading-base">{codeEnding(flow.lastCode)?.next ?? flow.remedy}</p>
            <div className="flex flex-wrap items-center gap-2">
              {onRecheck === undefined ? null : (
                <Button type="button" variant="primary" onClick={onRecheck} disabled={busy} data-sign-in-recheck="">
                  <RefreshCw size={16} aria-hidden="true" />
                  {busy ? 'Looking…' : 'Look for the login again'}
                </Button>
              )}
              <Button type="button" variant="outline" onClick={onStart} disabled={busy}>
                <Link2 size={16} aria-hidden="true" />
                {codeEnding(flow.lastCode)?.action ?? 'Start a new sign-in'}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
