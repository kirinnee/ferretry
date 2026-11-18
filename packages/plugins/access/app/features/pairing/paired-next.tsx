/**
 * WHAT HAPPENS AFTER "Connected", ON A PAGE THAT MOVES ON BY ITSELF (the daemon-less `/pair` page).
 *
 * That page used to navigate the instant the exchange answered, so the success screen was never seen and the first
 * passkey's offer ({@link FirstPasskeyOffer}) had nowhere to be shown. Now it waits for the machine's answer: with
 * nothing to offer (window closed, a passkey held, no browser support, a read that failed, or no way to reach the
 * machine) it moves on at once, as it always did; with the offer showing it stays until the person presses a button
 * that moves on ("Not now", or "Continue" once the passkey is added), so it never leaves a button the person could
 * still press. The offer is the existing component, untouched but for telling this one what it decided.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { DaemonConnection } from '../../shell-grants.ts';
import {
  FirstPasskeyOffer,
  type FirstPasskeyClientFactory,
  type FirstPasskeyOfferProps,
  type FirstPasskeyOutcome,
} from './first-passkey-offer.tsx';

export interface PairedNextProps {
  /** The machine just paired with; absent, there is nothing to ask it and the page moves on. */
  readonly connection: DaemonConnection | undefined;
  /** How the offer reaches that machine; absent, there is no offer and the page moves on. */
  readonly createClient: FirstPasskeyClientFactory | undefined;
  /** The offer's test seams (credentials, origin, browser support, clock). */
  readonly offer?: Pick<
    FirstPasskeyOfferProps,
    'credentials' | 'origin' | 'supported' | 'now' | 'deadlineMs' | 'schedule'
  >;
  /** Moves on (the host's navigation). Called at most once. */
  readonly onContinue: () => void;
}

export function PairedNext({ connection, createClient, offer, onContinue }: PairedNextProps) {
  const [phase, setPhase] = useState<'checking' | 'offered' | 'added'>('checking');
  // Called once, whatever the number of renders or effect runs: a second navigation would be a second history entry.
  const next = useRef(onContinue);
  next.current = onContinue;
  const moved = useRef(false);
  const move = useCallback(() => {
    if (moved.current) return;
    moved.current = true;
    next.current();
  }, []);
  const offerable = connection !== undefined && createClient !== undefined;
  useEffect(() => {
    if (!offerable) move();
  }, [offerable, move]);
  const settled = useCallback(
    (outcome: FirstPasskeyOutcome) => {
      if (outcome === 'none') move();
      else setPhase(outcome);
    },
    [move],
  );
  return (
    <>
      {offerable ? (
        <FirstPasskeyOffer {...offer} connection={connection} createClient={createClient} onSettled={settled} />
      ) : null}
      {phase === 'added' ? (
        <button type="button" className="kt-btn" data-variant="primary" data-paired-continue="" onClick={move}>
          Continue
        </button>
      ) : !offerable ? null : (
        // Shown from the first moment, while the machine is still being asked: a machine that is slow to answer must
        // never leave the person on this screen with no way on.
        <button
          type="button"
          className="min-h-[44px] text-ui font-medium text-muted underline hover:text-accent focus-visible:outline-focus focus-visible:outline-offset-focus"
          data-paired-continue=""
          onClick={move}
        >
          Not now
        </button>
      )}
    </>
  );
}
