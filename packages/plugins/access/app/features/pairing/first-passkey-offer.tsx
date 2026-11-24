/**
 * "ADD A PASSKEY NOW", on the screen that says a device is paired.
 *
 * A device may add its FIRST passkey only within a short window after pairing (`PASSKEY_REGISTRATION_WINDOW_SECONDS`).
 * The owner who paired and then went to do something else came back to a closed window and a prompt that could not be
 * answered. So the moment of pairing offers the ceremony itself, while the window is open: this is the existing
 * `addPasskeyCeremony`, run from here, and nothing about the window or who may register changes.
 *
 * It is one self-contained element: it reads the machine's own view once, draws nothing unless that view says this
 * device holds no passkey, the window is open and this browser can run the ceremony, and leaves every other
 * word of the screen to its host. A read that fails draws nothing, as the nudge does.
 */

import { Fingerprint } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { type CredentialsPort, type DeadlineSchedule, MACHINE_READ_DEADLINE_MS, withDeadline } from '@ferretry/app';
import { ActionRow } from '@ferretry/app/ui';
import type { PasskeysView } from '../../../contract/index.ts';
import { passkeyFailureSentence, registrationMinutes, webAuthnSupported } from '../../lib/passkey-panel.ts';
import { holdInlinePasskeyOffer } from '../../lib/inline-passkey-offer.ts';
import { addPasskeyCeremony, browserCredentials } from '../../lib/step-up-ceremony.ts';
import { fetchPasskeys, type StepUpClient } from '../../lib/step-up-client.ts';
import type { DaemonConnection } from '../../shell-grants.ts';
import { UnlockAfterAdd } from './unlock-after-add.tsx';

/** What this offer needs to reach the machine it just paired with. */
export type FirstPasskeyClientFactory = (connection: DaemonConnection) => Promise<StepUpClient>;

export interface FirstPasskeyOfferProps {
  readonly connection: DaemonConnection;
  readonly createClient: FirstPasskeyClientFactory;
  /** Test seam; production uses the browser's own credential container. */
  readonly credentials?: () => CredentialsPort;
  /** Test seam; production reads the page's own origin at the moment of the press. */
  readonly origin?: () => string;
  /** Test seam; production asks the browser. */
  readonly supported?: () => boolean;
  /** Test seam: the clock the minutes left are counted against. */
  readonly now?: () => number;
  /** How long the read of the machine's view may take before the offer gives up (`none`); the app's machine deadline. */
  readonly deadlineMs?: number;
  /** Test seam: the timer that deadline runs on. */
  readonly schedule?: DeadlineSchedule;
  /**
   * Told what the machine decided, once: `none` (nothing to offer: no window, a passkey held, no browser support, or a
   * read that failed), `offered` (the button is showing) and later `added`. A host that moves on by itself (the
   * daemon-less `/pair` page) waits for this so it never navigates away from a button the person could still press.
   */
  readonly onSettled?: (outcome: FirstPasskeyOutcome) => void;
  /** Told whether an unlock is the next step on this card (after "Passkey added"), so a host's own "Continue" can stand back from it. */
  readonly onUnlockPending?: (pending: boolean) => void;
  /** Drawn beside the add button while the offer shows (the host's "Not now"), so the two answers sit in one row. */
  readonly actions?: ReactNode;
}

export type FirstPasskeyOutcome = 'none' | 'offered' | 'added';

type State =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'offered'; readonly client: StepUpClient; readonly view: PasskeysView }
  | { readonly kind: 'added' };

/** Whether this view is the one situation the offer is for: no passkey held, and a window to add the first one open. */
export const firstWindowOpen = (view: PasskeysView): boolean =>
  view.passkeys.length === 0 && (view.registration === 'first-window' || view.registration === 'reopened');

export function FirstPasskeyOffer({
  connection,
  createClient,
  credentials = browserCredentials,
  origin = () => window.location.origin,
  supported = webAuthnSupported,
  now = Date.now,
  deadlineMs = MACHINE_READ_DEADLINE_MS,
  schedule,
  onSettled,
  onUnlockPending,
  actions,
}: FirstPasskeyOfferProps) {
  const [state, setState] = useState<State>({ kind: 'hidden' });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // After "Passkey added" the card keeps its machine held while an unlock is the next step: nothing pops over it unasked.
  const [unlockPending, setUnlockPending] = useState(true);
  // The latest listener, read when an answer arrives: a host passing a fresh closure each render must not restart the read.
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const pendingListener = useRef(onUnlockPending);
  pendingListener.current = onUnlockPending;

  // Read as a value, so the effect depends on the answer and not on the seam's identity.
  const canRun = supported();
  useEffect(() => {
    let current = true;
    setState({ kind: 'hidden' });
    if (!canRun) {
      settled.current?.('none');
      return;
    }
    // A machine that never answers settles as `none` at the deadline, so a host waiting on this never waits for ever.
    void withDeadline(
      createClient(connection).then(async client => ({ client, view: await fetchPasskeys(client) })),
      deadlineMs,
      schedule,
    )
      .then(({ client, view }) => {
        if (!current) return;
        if (firstWindowOpen(view)) {
          setState({ kind: 'offered', client, view });
          settled.current?.('offered');
        } else settled.current?.('none');
      })
      // A machine that cannot answer is an offer that stays quiet.
      .catch(() => {
        if (current) settled.current?.('none');
      });
    return () => {
      current = false;
    };
  }, [canRun, connection, createClient, deadlineMs, schedule]);

  // While the button shows, this machine's prompts hold back: the same offer must not pop up over it, unasked.
  const unlockNext = state.kind === 'added' && unlockPending;
  useEffect(() => pendingListener.current?.(unlockNext), [unlockNext]);
  const holding = state.kind === 'offered' || (state.kind === 'added' && unlockPending);
  useEffect(() => (holding ? holdInlinePasskeyOffer(connection.daemonId) : undefined), [holding, connection.daemonId]);

  const add = useCallback(async () => {
    if (state.kind !== 'offered') return;
    const here = origin();
    setBusy(true);
    setFailure(null);
    try {
      await addPasskeyCeremony(credentials(), state.client, here, supported());
    } catch (reason) {
      setFailure(passkeyFailureSentence(reason, here));
      setBusy(false);
      return;
    }
    setState({ kind: 'added' });
    setBusy(false);
    settled.current?.('added');
  }, [credentials, origin, state, supported]);

  if (state.kind === 'hidden') return null;
  if (state.kind === 'added')
    return (
      <UnlockAfterAdd
        connection={connection}
        onNeeded={needed => setUnlockPending(needed)}
        onUnlocked={() => setUnlockPending(false)}
      />
    );
  const minutes = registrationMinutes(state.view.registrationClosesAt, now());
  return (
    <div data-first-passkey-offer="" className="mt-3 flex w-full min-w-0 flex-col gap-3">
      {/* WHY, in one plain line: what a passkey is for. Then WHEN: no bare countdown, what happens if it is skipped. */}
      <p className="m-0 text-balance text-ui leading-base text-fg" data-first-passkey-why="">
        Add a passkey so this device can approve risky actions with your fingerprint or face.
      </p>
      <p className="m-0 text-balance text-meta leading-base text-muted" data-first-passkey-when="">
        {minutes === null
          ? ''
          : `This quick option stays open for about ${minutes <= 1 ? 'a minute' : `${minutes} minutes`}. `}
        Skip it and you can add a passkey later in Settings.
      </p>
      {/* The hint is a hint, not a label of the buttons: a clear gap (one row of its own) separates it from the answers. */}
      <ActionRow
        className="mt-3"
        secondary={actions}
        primary={
          <button
            type="button"
            disabled={busy}
            data-first-passkey-add=""
            onClick={() => void add()}
            data-variant="primary"
            className="kt-btn disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Fingerprint size={16} aria-hidden="true" />
            Add a passkey now
          </button>
        }
      />
      {failure === null ? null : (
        <p role="alert" data-first-passkey-failure="" className="m-0 text-meta leading-base text-err">
          {failure}
        </p>
      )}
    </div>
  );
}
