/**
 * THE SMALL PIECES OF THE PAIR SCREENS' LAYOUT (O2): the progress bar the first screens share with the setup pages, the
 * device-name line on the confirm card, and its two-button action row. Each is presentation over what the screen passes
 * in; what pressing a button DOES (`onPair`, `onCancel`) stays in `pairing-screen.tsx`.
 */
import { ActionRow } from '@ferretry/app/ui';
import { StepProgress } from '@ferretry/app';
import { type ReactNode, useId, useState } from 'react';

import { PAIRING_DEVICE_NAME_MAX_LENGTH } from '../../../contract/index.ts';
import { PairButton } from './pairing-back.tsx';

/** THE SAME PROGRESS BAR the setup pages draw (`StepProgress`), so the first screens are steps of the same run, not a different thing. */
const PAIR_SEGMENTS = [
  { id: 'pair', label: 'Pair' },
  { id: 'connected', label: 'Connected' },
  { id: 'setup', label: 'Set up' },
] as const;
const PROGRESS_AT: Readonly<Record<string, string | undefined>> = {
  // The first screen ("Connect a daemon": scan, upload or paste a link) is step 1 too.
  browse: 'pair',
  confirm: 'pair',
  pairing: 'pair',
  failed: 'pair',
  paired: 'connected',
};

/** The bar for a stage; nothing at a stage that is not a step of the run. */
export function PairProgress({ stage }: { readonly stage: string }): ReactNode {
  const current = PROGRESS_AT[stage];
  if (current === undefined) return null;
  return (
    <StepProgress
      segments={PAIR_SEGMENTS}
      current={current}
      step={PAIR_SEGMENTS.findIndex(segment => segment.id === current) + 1}
      of={PAIR_SEGMENTS.length}
    />
  );
}

/** The device name as typed; only a wrap is steered: the "·" stays with the suffix after it (same text, so nothing reads or copies differently). */
function DeviceNameText({ name }: { readonly name: string }) {
  const at = name.indexOf(' · ');
  if (at < 0) return <>{name}</>;
  return (
    <>
      {name.slice(0, at)} <span className="whitespace-nowrap">{name.slice(at + 1)}</span>
    </>
  );
}

export interface DeviceNameLineProps {
  readonly name: string;
  readonly renaming: boolean;
  readonly busy: boolean;
  readonly onName: (name: string) => void;
  readonly onRename: () => void;
}

/**
 * WHAT THE MACHINE WILL CALL THIS DEVICE, said before it is sent, and changeable. Every browser used to pair as
 * "Ferretry PWA", and a second one made every name at the machine ambiguous; the default is now this browser and system
 * plus a short suffix. A sentence with a quiet Rename rather than a field, because this screen is still one decision for
 * somebody who scanned a QR.
 */
export function DeviceNameLine({ name, renaming, busy, onName, onRename }: DeviceNameLineProps) {
  if (renaming) {
    return (
      <label className="flex min-w-0 flex-col gap-1 text-ui text-muted">
        Name this device
        <input
          type="text"
          className="kt-input min-h-[44px] min-w-0"
          data-pair-device-name=""
          value={name}
          maxLength={PAIRING_DEVICE_NAME_MAX_LENGTH}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          onChange={event => onName(event.target.value)}
        />
      </label>
    );
  }
  return (
    <p className="m-0 min-w-0 break-words text-ui leading-base text-muted" data-pair-device-label="">
      <span>
        This device will be called{' '}
        {/* A wrap never strands the "·" at the end of a line: the dot stays with what follows it. */}
        <span className="font-semibold text-fg">
          <DeviceNameText name={name} />
        </span>
        .
      </span>{' '}
      <button type="button" className="fy-inline-action" data-pair-device-rename="" onClick={onRename} disabled={busy}>
        Rename
      </button>
    </p>
  );
}

export interface ConfirmActionsProps {
  readonly busy: boolean;
  /** The pair button is not pressable (no usable device name, or a refused machine name). */
  readonly pairDisabled: boolean;
  readonly onPair: () => void;
  readonly onCancel: () => void;
}

/**
 * "Not now" and "Pair this device", in the shared action row.
 *
 * `data-pair-confirm` names the one control that starts a redemption, so a harness presses it by identity rather than by
 * position or by a design-system attribute. Both fallbacks are wrong for the same reason in different ways: the first
 * structural button on this screen is a NAVIGATION control, and `data-variant="primary"` is a styling choice a restyle
 * may take away while leaving a journey silently pressing nothing.
 */
export function ConfirmActions({ busy, pairDisabled, onPair, onCancel }: ConfirmActionsProps) {
  return (
    <ActionRow
      secondary={
        <PairButton type="button" onClick={onCancel} disabled={busy}>
          Not now
        </PairButton>
      }
      primary={
        <PairButton
          type="button"
          data-variant="primary"
          data-pair-confirm=""
          onClick={onPair}
          disabled={busy || pairDisabled}
        >
          {busy ? 'Pairing…' : 'Pair this device'}
        </PairButton>
      }
    />
  );
}

export interface LineWithDetailsProps {
  /** The one friendly line (a sentence, ending in its full stop). */
  readonly children: ReactNode;
  /** What sits behind the small "Details" link (a fingerprint, the path it travelled): read by anyone who asks, never in the way. */
  readonly details: ReactNode;
  /** The line's own `data-*` marker, for a harness that reads it. */
  readonly lineProps?: Readonly<Record<`data-${string}`, string>>;
  /** The details block's own `data-*` marker (it carries `hidden` until opened). */
  readonly detailsProps?: Readonly<Record<`data-${string}`, string>>;
  readonly className?: string;
  readonly detailsClassName?: string;
}

/**
 * ONE LINE AND A SMALL LINK (C59 O8-1, O8-3). The line says the thing; "Details" is a quiet link on the end of the SAME line
 * (`.fy-inline-action`: its 44px touch target is an invisible layer over the text), so no row, card or disclosure triangle of
 * its own is drawn under the sentence. Opened, what it holds shows one small step below.
 */
export function LineWithDetails({
  children,
  details,
  lineProps,
  detailsProps,
  className = 'm-0 text-ui leading-base text-fg',
  detailsClassName = 'm-0 break-all text-meta text-muted',
}: LineWithDetailsProps) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <div className="min-w-0" data-pair-details={open ? 'open' : 'closed'}>
      <p className={className} {...lineProps}>
        {children}{' '}
        <button
          type="button"
          className="fy-inline-action"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen(value => !value)}
        >
          Details
        </button>
      </p>
      <p id={panel} hidden={!open} className={`mt-1 ${detailsClassName}`} {...detailsProps}>
        {details}
      </p>
    </div>
  );
}
