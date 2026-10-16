/**
 * Codex's own sign-in, on screen. Nothing here is shared with Claude, and that is the design.
 *
 * ## A DEVICE CODE HAS NO FIELD; A LINK HAS ONE, FOR AN ADDRESS
 *
 * Codex's default is a real device grant: the person opens a link, types a one-time code AT THE
 * PROVIDER, and the harness child — which is polling — finishes on its own. There is nothing for a person
 * to bring back, so the device screens have no field at all.
 *
 * An account or workspace can turn device codes off. Then Codex's ordinary browser login is the way in:
 * the provider sends the browser to a `localhost` address on the machine, which a phone cannot load,
 * and the person pastes THAT ADDRESS here. It is the one field this panel has, it appears only in
 * `awaiting-callback`, and it is cleared before the request settles, like Claude's code. The daemon
 * moves to it by itself when Codex says device codes are unavailable; "Sign in with a link instead"
 * moves to it by choice.
 *
 * That is why this is a separate component rather than a flag on Claude's: what comes back, and from
 * where, is different for each harness.
 *
 * ## BOTH VALUES OR NEITHER
 *
 * A device grant needs the link AND the code: a link with no code sends somebody to a page that asks for
 * one, and a code with no link is a string nobody can spend. The daemon publishes them together or not at
 * all, so this panel never renders half a grant.
 *
 * ## THE CODE IS NOT A SECRET, AND THE WARNING IS THE PROVIDER'S OWN
 *
 * Completing this binds whichever account the person signs in as — the risk is **account substitution**,
 * not disclosure. `codex login --device-auth` prints its own warning about a code somebody else gave you,
 * and the same caution is worth repeating here rather than a vaguer one about theft.
 */

import type { CodexLoginFlow, HarnessLoginLastCode } from '@ferretry/protocol';
import { CheckCircle2, KeyRound, Link2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import { Button } from '../../shell/primitives.tsx';
import { browserClipboardWriter, type ClipboardWriter, CopyButton } from '../onboarding/copy-button.tsx';
import { ResumedNote, StartOverButton } from './sign-in-restart.tsx';
import type { LoginPanelWording } from './harness-login-model.ts';

export interface CodexLoginPanelProps {
  readonly accountLabel: string;
  /** The login's id, which keeps this panel's element ids unique on a page with several. */
  readonly loginId: string;
  readonly flow: CodexLoginFlow | null;
  readonly busy: boolean;
  readonly refusal: string | null;
  readonly onStart: () => void;
  readonly onCancel: () => void;
  /** End this sign-in and start a fresh one. Offered while one is running; absent where nothing can. */
  readonly onStartOver?: () => void;
  /** Move a device code that did not work to the link sign-in, in the same flow. */
  readonly onUseLink: () => void;
  /** Start a fresh sign-in with a link, after a device code failed. */
  readonly onStartLink: () => void;
  /** Hand the address the browser ended on to Codex on the machine. Write-only. */
  readonly onSubmitAddress: (address: string) => void;
  /** This sign-in used the link (so an ending speaks about the link, never about a code). */
  readonly linked: boolean;
  readonly copy?: ClipboardWriter;
  /** What one sign-in covers, and what to say once it is done. */
  readonly wording: LoginPanelWording;
  className?: string;
}

/**
 * What to say when a sign-in ended because of its code or its address. An expired device code is said as
 * "expired", never "rejected": nobody sent a code Codex could refuse.
 */
const codexEnding = (
  lastCode: HarnessLoginLastCode | undefined,
  linked: boolean,
): { readonly sentence: string; readonly next: string; readonly action: string } | null => {
  if (lastCode === 'expired' && linked) {
    return {
      sentence: 'That sign-in link expired before its address came back.',
      next: 'Get a new link, sign in, then paste the address it leads to.',
      action: 'Get a new link',
    };
  }
  if (lastCode === 'expired') {
    return {
      sentence: 'That one-time code expired before it was approved.',
      next: 'Get a new code, then enter it on the provider’s page.',
      action: 'Get a new code',
    };
  }
  if (lastCode === 'rejected') {
    return {
      sentence: 'Codex couldn’t finish signing in with that address.',
      next: 'Try again, and paste the address from that newest attempt.',
      action: 'Try again',
    };
  }
  return null;
};

export function CodexLoginPanel({
  accountLabel,
  loginId,
  flow,
  busy,
  refusal,
  onStart,
  onCancel,
  onStartOver,
  onUseLink,
  onStartLink,
  onSubmitAddress,
  linked,
  copy = browserClipboardWriter(),
  wording,
  className,
}: CodexLoginPanelProps) {
  const [address, setAddress] = useState('');

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (address.trim() === '' || busy) return;
    // Cleared before the request settles: the address carries an authorization code, which must not sit
    // in the rendered tree, a retry affordance, or a screenshot.
    const submitted = address;
    setAddress('');
    onSubmitAddress(submitted);
  };

  const ending = flow?.state === 'failed' ? codexEnding(flow.lastCode, linked) : null;
  const state = flow?.state ?? 'idle';
  return (
    <section
      aria-labelledby={`codex-login-${loginId}`}
      data-codex-login={state}
      data-codex-login-identity={loginId}
      className={cn('kt-panel overflow-hidden', className)}
    >
      <header className="border-b border-border bg-surface-2 px-panel py-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control border border-border bg-surface text-fg">
            <KeyRound size={20} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="m-0 text-meta font-semibold text-muted">Codex sign-in</p>
            <h3 id={`codex-login-${loginId}`} className="m-0 mt-0.5 text-title font-semibold text-fg">
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

        {refusal === null ? null : (
          <p
            role="alert"
            className="m-0 flex items-start gap-2 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-ui leading-base text-warn"
          >
            <TriangleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
            {refusal}
          </p>
        )}

        <ResumedNote flow={flow} />

        {state === 'idle' || state === 'starting' ? (
          <div className="space-y-3">
            <p className="m-0 text-ui leading-base text-muted">
              {linked
                ? 'Codex signs in with a link. Start here, open the link on any device, sign in, then paste back the address the browser ends on.'
                : 'Codex signs in with a device code. Start here, then open the link on any device and type the code it gives you at the provider’s page. Nothing comes back to this screen.'}
            </p>
            <Button type="button" variant="primary" onClick={onStart} disabled={busy || state === 'starting'}>
              <Link2 size={16} aria-hidden="true" />
              {state === 'starting' ? 'Starting sign-in…' : 'Sign in to Codex'}
            </Button>
            {state === 'starting' ? <StartOverButton onStartOver={onStartOver} busy={busy} /> : null}
          </div>
        ) : null}

        {flow?.state === 'awaiting-approval' ? (
          <div className="space-y-4">
            <div className="rounded-control border border-accent/40 bg-accent-soft p-3">
              <p className="m-0 text-meta font-semibold text-accent">1 · Open this link anywhere</p>
              <div className="mt-2 flex min-w-0 items-start gap-2">
                <code className="min-w-0 flex-1 break-all rounded-control border border-border bg-surface px-2 py-2 font-mono text-meta leading-base text-fg">
                  {flow.verificationUrl}
                </code>
                <CopyButton text={flow.verificationUrl} label="Copy the Codex sign-in link" write={copy} />
              </div>
            </div>
            <div className="rounded-control border border-border bg-surface-2 p-3">
              <p className="m-0 text-meta font-semibold text-muted">2 · Type this code there</p>
              <div className="mt-2 flex min-w-0 items-center gap-2">
                <code
                  data-codex-login-user-code=""
                  className="min-w-0 flex-1 rounded-control border border-border bg-surface px-3 py-2 font-mono text-title tracking-widest text-fg"
                >
                  {flow.userCode}
                </code>
                <CopyButton text={flow.userCode} label="Copy the Codex device code" write={copy} />
              </div>
              <p className="m-0 mt-2 text-meta leading-base text-muted">
                Continue only because you started this sign-in here. If a website or another person gave you a code,
                stop.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <p className="m-0 text-ui leading-base text-muted" role="status">
                Waiting for the provider. Codex finishes on its own — there is nothing to paste back.
              </p>
              <StartOverButton onStartOver={onStartOver} busy={busy} />
              <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
            </div>
            <div className="border-t border-border pt-3" data-codex-login-use-link="">
              <p className="m-0 text-meta leading-base text-muted">Device code didn’t work?</p>
              <Button type="button" className="mt-2" onClick={onUseLink} disabled={busy}>
                Sign in with a link instead
              </Button>
            </div>
          </div>
        ) : null}

        {flow?.state === 'awaiting-callback' ? (
          <div className="space-y-4">
            {flow.deviceCode === 'unavailable' ? (
              <p
                data-codex-login-device-unavailable=""
                className="m-0 flex items-start gap-2 rounded-control border border-border bg-surface-2 px-3 py-2 text-ui leading-base text-fg"
              >
                <TriangleAlert size={17} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
                This account doesn’t allow device codes, so Codex will sign in with a link instead.
              </p>
            ) : null}
            <div className="rounded-control border border-accent/40 bg-accent-soft p-3">
              <p className="m-0 text-meta font-semibold text-accent">1 · Open this link and sign in</p>
              <div className="mt-2 flex min-w-0 items-start gap-2">
                <code className="min-w-0 flex-1 break-all rounded-control border border-border bg-surface px-2 py-2 font-mono text-meta leading-base text-fg">
                  {flow.verificationUrl}
                </code>
                <CopyButton text={flow.verificationUrl} label="Copy the Codex sign-in link" write={copy} />
              </div>
            </div>
            <div className="rounded-control border border-border bg-surface-2 p-3">
              <p className="m-0 text-meta font-semibold text-muted">2 · Copy the address of the page that won’t load</p>
              <p className="m-0 mt-2 text-ui leading-base text-fg">
                After you sign in, the browser goes to a page that won’t load. Its address starts with{' '}
                <code className="font-mono text-meta">http://localhost</code>. That’s expected — copy the whole address
                from the address bar.
              </p>
            </div>
            <form className="space-y-2" onSubmit={submit}>
              <label htmlFor={`codex-login-address-${loginId}`} className="block text-ui font-semibold text-fg">
                3 · Paste that address here
              </label>
              <textarea
                id={`codex-login-address-${loginId}`}
                name="codex-login-address"
                className="kt-input min-h-24 w-full resize-y font-mono text-meta"
                value={address}
                onChange={event => setAddress(event.target.value)}
                placeholder="http://localhost:1455/auth/callback?code=…"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                disabled={busy}
                required
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" variant="primary" disabled={busy || address.trim() === ''}>
                  <ShieldCheck size={16} aria-hidden="true" />
                  {busy ? 'Sending…' : (wording.finishLabel ?? 'Finish sign-in')}
                </Button>
                <StartOverButton onStartOver={onStartOver} busy={busy} />
                <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
                  Cancel
                </Button>
              </div>
              <p className="m-0 text-meta leading-base text-faint">
                The address goes straight to Codex on the machine and is kept nowhere — not here, not in a log, not in
                this daemon. It is never shown back to you.
              </p>
            </form>
          </div>
        ) : null}

        {flow?.state === 'finishing' ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="m-0 text-ui leading-base text-muted" role="status">
              Codex is finishing the sign-in…
            </p>
            <StartOverButton onStartOver={onStartOver} busy={busy} />
            <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          </div>
        ) : null}

        {flow?.state === 'complete' ? (
          <div
            className="flex items-start gap-3 rounded-control border border-ok/40 bg-ok-soft p-3 text-ui leading-base text-fg"
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
            {/* An ending about the code or the address needs a fresh attempt, not the host command every
                other failure names. */}
            <p className="m-0 flex items-start gap-2">
              <TriangleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
              {ending?.sentence ?? flow.reason}
            </p>
            <p className="m-0 text-meta leading-base">{ending?.next ?? flow.remedy}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={onStart} disabled={busy}>
                <Link2 size={16} aria-hidden="true" />
                {ending?.action ?? 'Start a new sign-in'}
              </Button>
              {linked ? null : (
                <Button type="button" onClick={onStartLink} disabled={busy}>
                  Sign in with a link instead
                </Button>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
