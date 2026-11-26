/**
 * THE `access.passkey` ONBOARDING STEP (side: client): "Add a passkey on this device", drawn through the setup flow's
 * `StepHost`, with two explicit buttons for the answer (never a selection: a radio fires on arrow keys).
 *
 * The page decides whether to show, never the shell: it reads this machine's passkeys once and
 *   - skips as `already-set` when this device already holds a passkey for the machine,
 *   - skips as `not-needed` when there is nothing it could do (no machine in scope, no browser support, no first-passkey
 *     window open, or a read that failed or never answered),
 *   - otherwise lifts the loading cover (`ready`) and offers two buttons: "Add a passkey", or "Not now".
 * Pressing "Add a passkey" runs the existing `addPasskeyCeremony` (the window, who may register and the ceremony are
 * unchanged); the page holds the footer while the browser asks (`busy`) and records the answer (`done`) only when a
 * passkey was really added. "Not now" is the whole answer and moves on at once (`next`); the page itself records nothing, so
 * what Next means is the shell's rule (a page that reported `ready()` and never `done()` is recorded done once), and
 * a passkey can always be added later in Settings › Security while the window is open. No credential, key or challenge is kept in state or drawn; failures
 * show the same sentence the inline offer shows.
 */

import { Fingerprint } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  Button,
  type CredentialsPort,
  type DeadlineSchedule,
  MACHINE_READ_DEADLINE_MS,
  withDeadline,
} from '@ferretry/app';
import { ActionRow } from '@ferretry/app/ui';
import type { StepHost } from '@ferretry/kernel/contract';
import type { PasskeysView } from '../../../contract/index.ts';
import { holdInlinePasskeyOffer } from '../../lib/inline-passkey-offer.ts';
import { passkeyFailureSentence, registrationMinutesLeft, webAuthnSupported } from '../../lib/passkey-panel.ts';
import { addPasskeyCeremony, browserCredentials } from '../../lib/step-up-ceremony.ts';
import { fetchPasskeys, type StepUpClient } from '../../lib/step-up-client.ts';
import type { DaemonConnection } from '../../shell-grants.ts';
import { firstWindowOpen, type FirstPasskeyClientFactory } from '../pairing/first-passkey-offer.tsx';
import { UnlockAfterAdd } from '../pairing/unlock-after-add.tsx';

export interface PasskeyStepProps {
  /** Set only when the setup flow draws the page as a step; absent, the page draws nothing. */
  readonly step: StepHost | undefined;
  /** The machine in scope; absent, there is nothing to add a passkey to and the page skips. */
  readonly connection: DaemonConnection | undefined;
  readonly createClient: FirstPasskeyClientFactory;
  /** Test seam; production uses the browser's own credential container. */
  readonly credentials?: () => CredentialsPort;
  /** Test seam; production reads the page's own origin at the moment of the press. */
  readonly origin?: () => string;
  /** Test seam; production asks the browser. */
  readonly supported?: () => boolean;
  /** Test seam: the clock the minutes left are counted against. */
  readonly now?: () => number;
  /** How long the read of the machine's view may take before the page skips; the app's machine deadline. */
  readonly deadlineMs?: number;
  /** Test seam: the timer that deadline runs on. */
  readonly schedule?: DeadlineSchedule;
}

type Offer = { readonly client: StepUpClient; readonly view: PasskeysView };

export function PasskeyStep({
  step,
  connection,
  createClient,
  credentials = browserCredentials,
  origin = () => window.location.origin,
  supported = webAuthnSupported,
  now = Date.now,
  deadlineMs = MACHINE_READ_DEADLINE_MS,
  schedule,
}: PasskeyStepProps) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [adding, setAdding] = useState(false);
  // Read synchronously, so two presses inside one event turn cannot both start the ceremony.
  const running = useRef(false);
  const [added, setAdded] = useState(false);
  // After "Passkey added", an unlock may be the next step on this same card; the machine stays held until it is done.
  const [unlockPending, setUnlockPending] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);

  const canRun = supported();
  useEffect(() => {
    if (step === undefined) return;
    if (connection === undefined || !canRun) {
      step.skip('not-needed');
      return;
    }
    let current = true;
    void withDeadline(
      createClient(connection).then(async client => ({ client, view: await fetchPasskeys(client) })),
      deadlineMs,
      schedule,
    )
      .then(({ client, view }) => {
        if (!current) return;
        if (view.passkeys.length > 0) step.skip('already-set');
        else if (!firstWindowOpen(view)) step.skip('not-needed');
        else {
          setOffer({ client, view });
          step.ready();
        }
      })
      // A machine that cannot answer is a page that stays quiet, never one that blocks the flow.
      .catch(() => {
        if (current) step.skip('not-needed');
      });
    return () => {
      current = false;
    };
  }, [canRun, connection, createClient, deadlineMs, schedule, step]);

  // While the buttons show, this machine's own prompts hold back: the same offer must not pop up over them, unasked.
  const holdsMachine = offer !== null && connection !== undefined && !(added && !unlockPending);
  const daemonId = connection?.daemonId;
  useEffect(
    () => (holdsMachine && daemonId !== undefined ? holdInlinePasskeyOffer(daemonId) : undefined),
    [holdsMachine, daemonId],
  );

  const add = useCallback(
    async (held: Offer) => {
      if (step === undefined) return;
      const here = origin();
      setFailure(null);
      step.busy('Waiting for your device…');
      try {
        await addPasskeyCeremony(credentials(), held.client, here, supported(), daemonId);
      } catch (reason) {
        step.busy(null);
        setFailure(passkeyFailureSentence(reason, here));
        running.current = false;
        setAdding(false);
        return;
      }
      step.busy(null);
      setAdded(true);
      step.done();
    },
    [credentials, daemonId, origin, step, supported],
  );

  // Two explicit buttons, never a selection: a radio fires on Arrow/Home/End, and moving through choices must not
  // start WebAuthn or leave the page. Once "add" runs or is done, a second press would race it, so it is ignored.
  const addNow = () => {
    if (offer === null || step === undefined || added || running.current) return;
    running.current = true;
    setAdding(true);
    void add(offer);
  };
  const notNow = () => {
    if (step === undefined || added || running.current) return;
    step.next();
  };

  if (step === undefined || offer === null) return null;
  const left = registrationMinutesLeft(offer.view.registrationClosesAt, now());
  return (
    <div data-passkey-step="" className="flex min-w-0 flex-col gap-4">
      {added ? null : (
        <p className="m-0 text-ui leading-base text-fg">
          {`Confirm changes on this machine with your fingerprint, face or device PIN${left === null ? '' : ` — ${left}`}.`}
        </p>
      )}
      {added ? null : (
        // The shared answer row: Not now at the left end and Add a passkey at the right on a desktop, stacked full width on a
        // phone. They stay two explicit buttons around WebAuthn (never a choice a key can move, never a commit): the ceremony
        // needs a press.
        <ActionRow
          secondary={
            <Button type="button" data-passkey-later="" disabled={adding} onClick={notNow}>
              Not now
            </Button>
          }
          primary={
            <Button type="button" variant="primary" data-passkey-add="" disabled={adding} onClick={addNow}>
              <Fingerprint size={18} aria-hidden="true" />
              Add a passkey
            </Button>
          }
        />
      )}
      {added ? null : (
        <p className="m-0 text-ui leading-base text-muted">
          You can add one later in Settings › Security while the window is open.
        </p>
      )}
      {added ? (
        <div data-passkey-step-added="">
          <UnlockAfterAdd
            connection={connection}
            onNeeded={needed => setUnlockPending(needed)}
            onUnlocked={() => setUnlockPending(false)}
          />
        </div>
      ) : null}
      {failure === null ? null : (
        <p role="alert" data-passkey-step-failure="" className="m-0 text-ui leading-base text-err">
          {failure}
        </p>
      )}
    </div>
  );
}
