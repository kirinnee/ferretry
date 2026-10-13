/**
 * Codex's own sign-in, on screen. Nothing here is shared with Claude, and that is the design.
 *
 * ## THERE IS NO FIELD ON THIS PANEL, AND THAT IS THE WHOLE DIFFERENCE
 *
 * Codex signs in with a real device grant: the person opens a link, types a one-time code AT THE
 * PROVIDER, and the harness child — which is polling — finishes on its own. There is nothing for a person
 * to bring back here, so this panel has no textarea, no submit button, and no state in which one appears.
 *
 * That is why this is a separate component rather than a flag on Claude's. A single panel would have
 * needed an optional code display and an optional paste field, which is a shape that can render a Codex
 * sign-in asking for a paste and a Claude sign-in showing a device code — two screens neither harness has.
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

import type { CodexLoginFlow } from '@ferretry/protocol';
import { CheckCircle2, KeyRound, Link2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { cn } from '../../lib/class-names.ts';
import { Button } from '../../shell/primitives.tsx';
import { browserClipboardWriter, type ClipboardWriter, CopyButton } from '../onboarding/copy-button.tsx';
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
  readonly copy?: ClipboardWriter;
  /** What one sign-in covers, and what to say once it is done. */
  readonly wording: LoginPanelWording;
  className?: string;
}

export function CodexLoginPanel({
  accountLabel,
  loginId,
  flow,
  busy,
  refusal,
  onStart,
  onCancel,
  copy = browserClipboardWriter(),
  wording,
  className,
}: CodexLoginPanelProps) {
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

        {state === 'idle' || state === 'starting' ? (
          <div className="space-y-3">
            <p className="m-0 text-ui leading-base text-muted">
              Codex signs in with a device code. Start here, then open the link on any device and type the code it gives
              you at the provider’s page. Nothing comes back to this screen.
            </p>
            <Button type="button" variant="primary" onClick={onStart} disabled={busy || state === 'starting'}>
              <Link2 size={16} aria-hidden="true" />
              {state === 'starting' ? 'Starting sign-in…' : 'Sign in to Codex'}
            </Button>
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
              <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
            </div>
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
            {/* An expired code needs a new code, not the host command every other failure names — and it is
                said as "expired", never "rejected": nobody here sent a code Codex could refuse. */}
            <p className="m-0 flex items-start gap-2">
              <TriangleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
              {flow.lastCode === 'expired' ? 'That one-time code expired before it was approved.' : flow.reason}
            </p>
            <p className="m-0 text-meta leading-base">
              {flow.lastCode === 'expired' ? 'Get a new code, then enter it on the provider’s page.' : flow.remedy}
            </p>
            <Button type="button" variant="outline" onClick={onStart} disabled={busy}>
              <Link2 size={16} aria-hidden="true" />
              {flow.lastCode === 'expired' ? 'Get a new code' : 'Start a new sign-in'}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
