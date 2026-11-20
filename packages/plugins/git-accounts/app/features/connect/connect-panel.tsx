/**
 * Connect a GitHub account: the button, then the consent words, then the code card, then the answer. Many accounts are
 * allowed, so the button is always there when nothing is in flight.
 */
import type { ReactNode } from 'react';
import type { GitAccountsClient } from '../../shell.tsx';
import { CodeCard } from './code-card.tsx';
import { ConsentCard } from './consent-card.tsx';
import { useDeviceFlow } from './use-device-flow.ts';

export interface ConnectPanelProps {
  readonly client: GitAccountsClient;
  readonly onConnected: (accountId: string) => void;
  readonly pollDelay?: (seconds: number) => number;
  readonly now?: () => number;
  /** How many accounts are connected, to say "another". */
  readonly connected: number;
  /** Shown above the button while no flow is open (hidden while the consent words or the code are on screen). */
  readonly idleNote?: ReactNode;
}

export function ConnectPanel({ client, onConnected, pollDelay, now, connected, idleNote }: ConnectPanelProps) {
  const { state, ask, cancel, proceed, confirmStepUp } = useDeviceFlow({
    client,
    onConnected,
    ...(pollDelay === undefined ? {} : { pollDelay }),
    ...(now === undefined ? {} : { now }),
  });

  if (state.step === 'consent') return <ConsentCard onContinue={() => void proceed()} onCancel={cancel} />;
  if (state.step === 'starting')
    return (
      <p role="status" className="m-0 text-cell text-muted" data-testid="git-starting">
        Asking GitHub for a code…
      </p>
    );
  if (state.step === 'waiting')
    return (
      <CodeCard
        flow={state.flow}
        slow={state.slow}
        needsStepUp={state.needsStepUp}
        onConfirmStepUp={() => void confirmStepUp(state)}
        onCancel={cancel}
        {...(now === undefined ? {} : { now })}
      />
    );

  return (
    <div className="flex flex-col gap-2">
      {idleNote}
      {state.step === 'done' ? (
        <p role="status" className="m-0 text-ui text-ok" data-testid="git-done">
          Connected @{state.login}.
        </p>
      ) : null}
      {state.step === 'expired' ? (
        <p role="alert" className="m-0 text-ui text-warn" data-testid="git-expired">
          That code ran out of time. Start again to get a new one.
        </p>
      ) : null}
      {state.step === 'denied' ? (
        <p role="alert" className="m-0 text-ui text-warn" data-testid="git-denied">
          GitHub said no, so nothing was connected.
        </p>
      ) : null}
      {state.step === 'error' ? (
        <p role="alert" className="m-0 text-ui text-err" data-testid="git-error">
          {state.message}
        </p>
      ) : null}
      <div>
        <button
          type="button"
          className="kt-btn h-auto min-h-[44px] max-w-full whitespace-normal py-2"
          {...(connected === 0 || state.step !== 'idle' ? { 'data-variant': 'primary' } : {})}
          onClick={ask}
        >
          {state.step === 'expired' || state.step === 'denied' || state.step === 'error'
            ? 'Try again'
            : connected === 0
              ? 'Connect a GitHub account'
              : 'Connect another GitHub account'}
        </button>
      </div>
    </div>
  );
}
