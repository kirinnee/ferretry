/**
 * The code to type on GitHub: large, with Copy code, Open github.com/login/device and a countdown. The code is a short
 * USER code (the daemon keeps GitHub's device code to itself), good for a few minutes and useless without the person's
 * own GitHub sign-in, so showing it in full is the point.
 */
import { browserClipboardWriter, ExternalLink } from '@ferretry/app/ui';
import { useEffect, useState } from 'react';
import type { GitDeviceFlow } from '../../../contract/index.ts';
import { formatRemaining, remainingMs, safeVerificationUri } from '../../lib/connect-state.ts';

export interface CodeCardProps {
  readonly flow: GitDeviceFlow;
  /** GitHub asked for fewer polls: said once, quietly. */
  readonly slow: boolean;
  /** The daemon wants the passkey before it will answer the next check: the code stays, the person presses to finish. */
  readonly needsStepUp: boolean;
  readonly onConfirmStepUp: () => void;
  readonly onCancel: () => void;
  /** The clock; tests and screenshots pin it. */
  readonly now?: () => number;
}

/** Re-reads `now` each second, so the countdown moves without the page asking anything. */
function useSecondClock(now: () => number): number {
  const [at, setAt] = useState(() => now());
  useEffect(() => {
    const timer = setInterval(() => setAt(now()), 1000);
    return () => clearInterval(timer);
  }, [now]);
  return at;
}

type CopyState = 'idle' | 'copied' | 'failed';

export function CodeCard({ flow, slow, needsStepUp, onConfirmStepUp, onCancel, now = Date.now }: CodeCardProps) {
  const left = remainingMs(flow.expiresAt, useSecondClock(now));
  const [copy, setCopy] = useState<CopyState>('idle');
  const link = safeVerificationUri(flow.verificationUri);
  const write = browserClipboardWriter();

  return (
    <section
      className="flex flex-col gap-3 border-t border-border pt-4"
      aria-labelledby="git-code-heading"
      data-testid="git-code-card"
    >
      <h3 id="git-code-heading" className="m-0 text-row font-semibold text-fg">
        Type this code on GitHub
      </h3>
      <p
        className="mono m-0 select-all break-all text-[2rem] font-semibold leading-none sm:text-[2.75rem] tracking-[0.14em] text-fg"
        data-testid="git-user-code"
      >
        {flow.userCode}
      </p>
      <p
        className="m-0 flex flex-wrap items-baseline gap-x-2 whitespace-nowrap text-ui text-muted"
        data-testid="git-waiting"
      >
        <span>Time left</span>
        <span className="mono text-row font-semibold tabular-nums text-fg" data-testid="git-countdown">
          {formatRemaining(left)}
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="kt-btn min-h-[44px] grow justify-center sm:grow-0"
          data-variant="primary"
          onClick={() =>
            void write(flow.userCode).then(
              () => setCopy('copied'),
              () => setCopy('failed'),
            )
          }
        >
          Copy code
        </button>
        {link === undefined ? (
          <span className="text-cell text-muted">
            Open <span className="mono">github.com/login/device</span> in your browser.
          </span>
        ) : (
          <ExternalLink href={link} className="kt-btn min-h-[44px] grow items-center justify-center sm:grow-0">
            Open github.com/login/device
          </ExternalLink>
        )}
        <button type="button" className="kt-btn min-h-[44px] grow justify-center sm:grow-0" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p role="status" className={`m-0 text-meta ${copy === 'failed' ? 'text-warn' : 'text-ok'}`}>
        {copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Copy was blocked — select the code instead' : ''}
      </p>
      {needsStepUp ? (
        <div className="flex flex-col gap-2" data-testid="git-step-up">
          <p className="m-0 text-cell leading-base text-muted">
            Once you have typed the code on GitHub, confirm it is you here so this machine can finish connecting.
          </p>
          <button
            type="button"
            className="kt-btn min-h-[44px] justify-center sm:self-start"
            data-variant="primary"
            onClick={onConfirmStepUp}
          >
            Confirm with your passkey to finish
          </button>
        </div>
      ) : null}
      {slow ? (
        <p className="m-0 text-meta text-faint">GitHub asked for a slower check; this page is waiting longer.</p>
      ) : null}
    </section>
  );
}
