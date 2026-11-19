/**
 * "Connect a GitHub account", inside the create flow: say what is asked, then show the code and wait.
 *
 * The code is typed at github.com by the person; Ferretry never opens it for them. The device code GitHub gave the
 * daemon never reaches this page: only the short code to type does.
 */
import { CopyButton, browserClipboardWriter, ExternalLink, useNow } from '@ferretry/app/ui';
import { LoaderCircle, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { DeviceFlowControls } from './use-device-flow.ts';

/** What GitHub is asked for, in plain words, shown before the code. The scope names are GitHub's. */
const CONSENT_LINES: readonly string[] = [
  'Your profile and email (read:user, user:email): to sign your commits as you.',
  'Add SSH keys (write:public_key, write:ssh_signing_key): so ferrets can push and sign without a password.',
  'Your repositories (repo): read and write every repository you can reach, public and private. GitHub cannot limit this to some repositories.',
  'Your organisations (read:org): to list their repositories.',
];
const CONSENT_RESULT =
  'A ferret working in a project linked to this account can act on GitHub as you. It can use this access; it can never read the token. Remove the account any time; to fully revoke it, open github.com/settings/applications.';

const secondsLeft = (expiresAt: string, now: number): number => {
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) ? Math.max(0, Math.round((at - now) / 1000)) : 0;
};

export function ConnectAccount({ controls }: { readonly controls: DeviceFlowControls }) {
  const now = useNow();
  const [asking, setAsking] = useState(false);
  const { state } = controls;
  switch (state.phase) {
    case 'idle':
      return (
        <div className="grid gap-xs" data-connect-account="idle">
          {!asking ? (
            <div>
              <button type="button" className="kt-btn min-h-control" onClick={() => setAsking(true)}>
                Connect a GitHub account
              </button>
            </div>
          ) : (
            <div
              className="grid gap-xs rounded-control border border-border-soft bg-surface-2 p-panel"
              data-connect-consent=""
            >
              <p className="m-0 text-ui font-semibold text-fg">What Ferretry asks GitHub for</p>
              <ul className="m-0 grid list-disc gap-1 pl-5 text-ui leading-base text-muted">
                {CONSENT_LINES.map(line => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p className="m-0 max-w-prose text-ui leading-base text-muted">{CONSENT_RESULT}</p>
              <div className="flex flex-wrap gap-sm">
                <button type="button" className="kt-btn min-h-control" onClick={controls.start}>
                  Continue to GitHub
                </button>
                <button type="button" className="kt-btn min-h-control" onClick={() => setAsking(false)}>
                  Not now
                </button>
              </div>
            </div>
          )}
        </div>
      );
    case 'starting':
      return (
        <p className="m-0 flex items-center gap-xs text-meta text-muted" role="status" data-connect-account="starting">
          <LoaderCircle className="animate-spin motion-reduce:animate-none" size={14} aria-hidden="true" />
          Asking GitHub for a code…
        </p>
      );
    case 'waiting': {
      const left = secondsLeft(state.flow.expiresAt, now);
      return (
        <div
          className="grid gap-xs rounded-control border border-border-soft bg-surface-2 p-panel"
          data-connect-account="waiting"
        >
          <p className="m-0 text-meta text-muted">Type this code at GitHub:</p>
          <div className="flex items-center gap-xs">
            <span className="mono text-display font-bold tracking-wide" data-connect-code="">
              {state.flow.userCode}
            </span>
            <CopyButton text={state.flow.userCode} label="Copy code" write={browserClipboardWriter()} touch />
          </div>
          <ExternalLink href={state.flow.verificationUri} className="text-ui text-accent underline">
            Open github.com/login/device
          </ExternalLink>
          <p className="m-0 text-meta text-muted" role="status">
            Waiting for you to approve it… the code works for {Math.floor(left / 60)}:
            {String(left % 60).padStart(2, '0')} more.
          </p>
          <div>
            <button type="button" className="kt-btn min-h-control" onClick={controls.cancel}>
              Cancel
            </button>
          </div>
        </div>
      );
    }
    case 'connected':
      return (
        <p className="m-0 text-meta text-ok" role="status" data-connect-account="connected">
          Connected @{state.login}.
        </p>
      );
    case 'expired':
    case 'denied':
    case 'failed':
      return (
        <div className="grid gap-xs" data-connect-account={state.phase}>
          <p className="m-0 flex items-start gap-xs text-meta text-err" role="alert">
            <TriangleAlert className="mt-0.5 shrink-0" size={14} aria-hidden="true" />
            {state.phase === 'expired'
              ? 'That code ran out before it was approved.'
              : state.phase === 'denied'
                ? 'GitHub says the request was denied.'
                : `This daemon could not connect the account: ${state.message}`}
          </p>
          <div>
            <button type="button" className="kt-btn min-h-control" onClick={controls.start}>
              Try again
            </button>
          </div>
        </div>
      );
  }
}
