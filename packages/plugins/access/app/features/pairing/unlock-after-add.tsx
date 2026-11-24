/**
 * "PASSKEY ADDED. TOUCH IT ONCE MORE TO UNLOCK THIS DEVICE.", on the card that just added the passkey (S-11).
 *
 * A registration never unlocks a machine (`docs/design/zero-trust.md`: "A registration is never a step-up"), so a machine
 * that unlocks on opening wants one more touch right after the first passkey. The unlock is drawn here as the NEXT STEP of
 * the same card, with its own button, instead of a second modal that pops up over "Passkey added" and reads as the passkey
 * loop. Which machine asks, and whether it asks at all, is the shell's to say (`inline-passkey-offer.ts`); a page with no
 * shell, or a machine that does not unlock on opening, draws the plain "Passkey added" line.
 */

import { Fingerprint } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { ActionRow } from '@ferretry/app/ui';
import { Button } from '@ferretry/app';
import { currentInlineUnlock } from '../../lib/inline-passkey-offer.ts';
import type { DaemonConnection } from '../../shell-grants.ts';

const PASSKEY_ADDED_SENTENCE = 'Passkey added. This device can confirm changes on this machine.';
const UNLOCK_NEXT_SENTENCE = 'Passkey added. Touch it once more to unlock this device.';
const UNLOCKED_SENTENCE = 'Passkey added and this device is unlocked.';

interface UnlockAfterAddProps {
  readonly connection: DaemonConnection | undefined;
  /** Told once whether an unlock is the next step (`true`) or the passkey is all there is (`false`); the host keeps holding its machine while `true`. */
  readonly onNeeded: (needed: boolean) => void;
  /** Told once the unlock is done. */
  readonly onUnlocked: () => void;
}

type Phase = 'asking' | 'plain' | 'next' | 'busy' | 'done';

export function UnlockAfterAdd({ connection, onNeeded, onUnlocked }: UnlockAfterAddProps) {
  const [phase, setPhase] = useState<Phase>('asking');
  const [failure, setFailure] = useState<string | null>(null);
  // The latest callbacks, read when an answer arrives: a host passing fresh closures must not restart the read.
  const needed = useRef(onNeeded);
  needed.current = onNeeded;
  const unlocked = useRef(onUnlocked);
  unlocked.current = onUnlocked;
  const provider = currentInlineUnlock();

  useEffect(() => {
    let current = true;
    if (connection === undefined || provider === undefined) {
      setPhase('plain');
      needed.current(false);
      return;
    }
    void provider.needed(connection).then(
      wanted => {
        if (!current) return;
        setPhase(wanted ? 'next' : 'plain');
        needed.current(wanted);
      },
      () => {
        if (!current) return;
        setPhase('next');
        needed.current(true);
      },
    );
    return () => {
      current = false;
    };
  }, [connection, provider]);

  if (phase === 'asking' || phase === 'plain')
    return (
      <p role="status" data-first-passkey-added="" className="m-0 text-ui leading-base text-ok">
        {PASSKEY_ADDED_SENTENCE}
      </p>
    );
  if (phase === 'done')
    return (
      <p role="status" data-passkey-unlocked="" className="m-0 text-ui leading-base text-ok">
        {UNLOCKED_SENTENCE}
      </p>
    );
  const unlock = async (): Promise<void> => {
    if (provider === undefined || connection === undefined || phase === 'busy') return;
    setPhase('busy');
    setFailure(null);
    const sentence = await provider.run(connection);
    if (sentence !== undefined) {
      setFailure(sentence);
      setPhase('next');
      return;
    }
    setPhase('done');
    unlocked.current();
  };
  return (
    <div data-passkey-unlock-next="" className="flex w-full min-w-0 flex-col gap-3">
      <p role="status" data-first-passkey-added="" className="m-0 text-ui leading-base text-ok">
        {UNLOCK_NEXT_SENTENCE}
      </p>
      <ActionRow
        primary={
          <Button
            type="button"
            variant="primary"
            data-passkey-unlock=""
            disabled={phase === 'busy'}
            onClick={() => void unlock()}
          >
            <Fingerprint size={16} aria-hidden="true" />
            {phase === 'busy' ? 'Waiting for your passkey…' : 'Unlock this device'}
          </Button>
        }
      />
      {failure === null ? null : (
        <p role="alert" data-passkey-unlock-failure="" className="m-0 text-meta leading-base text-err">
          {failure}
        </p>
      )}
    </div>
  );
}
