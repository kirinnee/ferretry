/**
 * WHAT A BROWSER THE MACHINE NO LONGER ACCEPTS IS SHOWN, IN PLACE OF THE PAGE.
 *
 * A revoked or idle-expired device used to see every panel fail on its own — "could not reach fyd …
 * the rendezvous ended this session: 4403" — even on a direct-only machine that had answered. The
 * machine did answer: it said no. So the page is replaced by the one sentence that is true on either
 * carrier, and the one action that repairs it.
 */

import { KeyRound } from 'lucide-react';
import { DEVICE_NOT_ACCEPTED_SENTENCE } from '../../lib/relay-carrier.ts';

export interface DeviceRefusedNoticeProps {
  /** The machine's name as this browser shows it. */
  readonly machineName: string;
  /** Opens the pairing step of the setup guide. */
  readonly onPairAgain: () => void;
}

export function DeviceRefusedNotice({ machineName, onPairAgain }: DeviceRefusedNoticeProps) {
  return (
    <section
      aria-labelledby="fy-device-refused-title"
      data-device-refused=""
      className="mx-auto mt-6 flex w-full max-w-[680px] min-w-0 flex-col items-start gap-2 rounded-control border border-border-strong bg-surface-2 px-3 py-3"
    >
      <h2 id="fy-device-refused-title" className="m-0 flex items-center gap-1 text-ui font-semibold text-fg">
        <KeyRound size={16} className="shrink-0 text-warn" aria-hidden="true" />
        {machineName}
      </h2>
      <p role="alert" className="m-0 text-cell leading-base text-fg">
        {DEVICE_NOT_ACCEPTED_SENTENCE}
      </p>
      <button
        type="button"
        data-device-refused-pair=""
        onClick={onPairAgain}
        className="kt-btn min-h-[44px]"
        data-variant="primary"
      >
        Pair again
      </button>
    </section>
  );
}
