/**
 * A remote provider-login handoff, scoped to one daemon and one fleet identity.
 *
 * The browser never tries to inspect the pasted callback.  Its query string can
 * carry a short-lived authorization code, so the value is sent directly to the
 * daemon, cleared from the controlled input, and never included in a status or
 * error message.  The daemon owns callback-origin and OAuth-state validation.
 */

import { CheckCircle2, KeyRound, Link2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import { Button } from '../../shell/primitives.tsx';
import { browserClipboardWriter, type ClipboardWriter, CopyButton } from '../onboarding/copy-button.tsx';

export interface RemoteLoginIdentity {
  /** The daemon's stable identity key, not an individual wrapper name. */
  readonly identity: string;
  readonly provider: 'claude';
  /** The account a person recognises before granting provider access. */
  readonly accountLabel: string;
  /** Includes the account being logged in, so one means no sibling copy. */
  readonly memberCount: number;
}

export type RemoteLoginStep =
  | { readonly kind: 'ready' }
  | { readonly kind: 'awaiting-callback'; readonly authorizationUrl: string }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'complete'; readonly copiedToSiblings: number }
  | { readonly kind: 'unavailable'; readonly reason: string };

export interface RemoteLoginSurfaceProps {
  /** State is never shared across daemons, even when identity strings collide. */
  readonly daemonId: DaemonId;
  readonly identity: RemoteLoginIdentity;
  readonly initialStep: RemoteLoginStep;
  /** Starts the daemon-side browser flow and returns its URL to open elsewhere. */
  readonly onStart: () => Promise<RemoteLoginStep>;
  /** Sends a callback URL straight to the daemon; its contents must never be echoed. */
  readonly onSubmitRedirect: (redirectUrl: string) => Promise<RemoteLoginStep>;
  readonly copy?: ClipboardWriter;
  className?: string;
}

const memberCoverage = (count: number): string => {
  if (count <= 1) return 'this account only';
  return `${count - 1} sibling wrapper${count === 2 ? '' : 's'} too`;
};

const providerLabel = (provider: RemoteLoginIdentity['provider']): string =>
  provider === 'claude' ? 'Claude Code' : provider;

/**
 * The narrow UI contract for URL-out / URL-back login.
 *
 * It intentionally accepts opaque daemon states rather than parsing callbacks
 * locally: validation depends on the exact callback origin and OAuth state the
 * daemon minted for this attempt. A local "looks like a URL" check would be a
 * misleading security boundary.
 */
export function RemoteLoginSurface({
  daemonId,
  identity,
  initialStep,
  onStart,
  onSubmitRedirect,
  copy = browserClipboardWriter(),
  className,
}: RemoteLoginSurfaceProps) {
  const [step, setStep] = useState<RemoteLoginStep>(initialStep);
  const [redirectUrl, setRedirectUrl] = useState('');
  const [busy, setBusy] = useState<'start' | 'submit' | null>(null);

  const start = (): void => {
    setBusy('start');
    void onStart().then(
      next => {
        setStep(next);
        setBusy(null);
      },
      () => {
        setStep({
          kind: 'unavailable',
          reason: 'The daemon could not start a sign-in. Your existing credential was left alone.',
        });
        setBusy(null);
      },
    );
  };

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (redirectUrl.trim() === '' || busy !== null) return;

    // Capture only for this request. Clearing before the promise settles keeps
    // an authorization code out of the rendered tree, retry UI, and screenshots.
    const submittedUrl = redirectUrl;
    setRedirectUrl('');
    setBusy('submit');
    void onSubmitRedirect(submittedUrl).then(
      next => {
        setStep(next);
        setBusy(null);
      },
      () => {
        setStep({
          kind: 'rejected',
          reason:
            'The daemon could not verify that callback. The existing credential was left unchanged; start a new sign-in if this link has expired.',
        });
        setBusy(null);
      },
    );
  };

  const supportsCallback = step.kind === 'awaiting-callback' || step.kind === 'rejected';
  return (
    <section
      aria-labelledby="remote-login-heading"
      data-remote-login={step.kind}
      data-remote-login-daemon-id={String(daemonId)}
      className={cn('kt-panel overflow-hidden', className)}
    >
      <header className="border-b border-border-soft bg-surface-2 px-panel py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control border border-accent bg-accent-soft text-accent">
            <KeyRound size={20} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="m-0 text-meta font-semibold uppercase tracking-label text-accent">Remote provider sign-in</p>
            <h2
              id="remote-login-heading"
              className="m-0 mt-0.5 font-display text-title font-bold tracking-display text-fg"
            >
              {identity.accountLabel}
            </h2>
            <p className="m-0 mt-1 text-ui leading-base text-muted">
              {providerLabel(identity.provider)} identity{' '}
              <code className="font-mono text-meta text-fg">{identity.identity}</code>
            </p>
          </div>
        </div>
      </header>

      <div className="space-y-4 p-panel">
        <div className="flex items-start gap-2 rounded-control border border-border-soft bg-surface-2 px-3 py-2 text-ui leading-base text-muted">
          <ShieldCheck size={17} className="mt-0.5 shrink-0 text-ok" aria-hidden="true" />
          <p className="m-0">
            One approval covers{' '}
            <strong className="font-semibold text-fg">{memberCoverage(identity.memberCount)}</strong>. The daemon
            verifies the new credential before copying it.
          </p>
        </div>

        {step.kind === 'ready' ? (
          <div className="space-y-3">
            <p className="m-0 text-ui leading-base text-muted">
              Start here, then open the link on any device. After the provider redirects to the daemon&apos;s localhost
              callback, copy the complete address-bar URL and bring it back here.
            </p>
            <Button type="button" variant="primary" onClick={start} disabled={busy !== null}>
              <Link2 size={16} aria-hidden="true" />
              {busy === 'start' ? 'Starting sign-in…' : `Log in to ${providerLabel(identity.provider)}`}
            </Button>
          </div>
        ) : null}

        {step.kind === 'awaiting-callback' ? (
          <div className="space-y-4">
            <div className="rounded-control border border-accent/40 bg-accent-soft p-3">
              <p className="m-0 text-meta font-semibold uppercase tracking-label text-accent">
                1 · Open this URL anywhere
              </p>
              <div className="mt-2 flex min-w-0 items-start gap-2">
                <code className="min-w-0 flex-1 break-all rounded-control border border-border bg-surface px-2 py-2 font-mono text-meta leading-base text-fg">
                  {step.authorizationUrl}
                </code>
                <CopyButton text={step.authorizationUrl} label="Copy provider sign-in URL" write={copy} />
              </div>
            </div>
            <RedirectForm busy={busy === 'submit'} value={redirectUrl} onChange={setRedirectUrl} onSubmit={submit} />
          </div>
        ) : null}

        {step.kind === 'rejected' ? (
          <div className="space-y-4">
            <div
              className="flex items-start gap-2 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-ui leading-base text-warn"
              role="alert"
            >
              <TriangleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
              <p className="m-0">{step.reason}</p>
            </div>
            <p className="m-0 text-ui leading-base text-muted">
              The pasted URL was discarded. Paste a callback from this sign-in attempt, or start over for a fresh link.
            </p>
            <RedirectForm busy={busy === 'submit'} value={redirectUrl} onChange={setRedirectUrl} onSubmit={submit} />
          </div>
        ) : null}

        {step.kind === 'complete' ? (
          <div
            className="flex items-start gap-3 rounded-control border border-ok/40 bg-ok-soft p-3 text-ui leading-base text-fg"
            role="status"
          >
            <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-ok" aria-hidden="true" />
            <div>
              <p className="m-0 font-semibold">Signed in to {identity.accountLabel}</p>
              <p className="m-0 mt-1 text-muted">
                The credential was verified and copied to{' '}
                {step.copiedToSiblings === 0
                  ? 'no sibling wrappers.'
                  : `${step.copiedToSiblings} sibling wrapper${step.copiedToSiblings === 1 ? '' : 's'}.`}
              </p>
            </div>
          </div>
        ) : null}

        {step.kind === 'unavailable' ? (
          <div
            className="flex items-start gap-2 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-ui leading-base text-warn"
            role="alert"
          >
            <TriangleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
            <p className="m-0">{step.reason}</p>
          </div>
        ) : null}

        {supportsCallback ? (
          <p className="m-0 text-meta leading-base text-faint">
            The redirect can contain an authorization code. It is sent directly to this daemon and is never shown back
            to you.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function RedirectForm({
  busy,
  value,
  onChange,
  onSubmit,
}: {
  readonly busy: boolean;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="space-y-2" onSubmit={onSubmit}>
      <label htmlFor="remote-login-callback" className="block text-ui font-semibold text-fg">
        2 · Paste the complete redirected URL
      </label>
      <textarea
        id="remote-login-callback"
        name="remote-login-callback"
        className="kt-input min-h-24 w-full resize-y font-mono text-meta"
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder="http://127.0.0.1:…/oauth/callback?…"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        disabled={busy}
        required
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={busy || value.trim() === ''}>
          <ShieldCheck size={16} aria-hidden="true" />
          {busy ? 'Checking with daemon…' : 'Finish sign-in'}
        </Button>
        <span className="text-meta text-muted">The daemon checks the callback origin and one-time state.</span>
      </div>
    </form>
  );
}
