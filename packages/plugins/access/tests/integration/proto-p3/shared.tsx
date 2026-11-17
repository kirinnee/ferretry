/**
 * THROWAWAY PROTOTYPE (P3 phase 1): the parts both pair-page options share. Fake data only — no real code, no daemon.
 *
 * The content is what the P2 relay-path screen shows: the machine's NAME, "through the relay", and the fingerprint
 * behind a Details toggle. No `127.0.0.1` anywhere.
 */
import { BrandMark } from '../../../app/shell-pairing.ts';
import { Check, ChevronDown, Monitor, Radio } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';

export const FAKE = {
  machine: 'kirin-workstation',
  fingerprint: 'fy_daemon_9k3q2m7x4n8v1b6c5z0wd2f8',
  device: 'Chrome on Linux · 4f2a',
} as const;

export type Stage = 'confirm' | 'pairing' | 'paired';

export interface OptionProps {
  readonly stage: Stage;
  readonly onPair: () => void;
  readonly onCancel: () => void;
  readonly detailsOpen?: boolean;
}

export function Lockup() {
  return (
    <div className="p3-lockup">
      <BrandMark size={20} />
      <span>Ferretry</span>
    </div>
  );
}

/** Machine name, how it is reached, and the fingerprint one tap away. */
export function MachineCard({ startOpen = false }: { readonly startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const panel = useId();
  return (
    <section className="p3-machine" aria-labelledby="p3-machine-name">
      <div className="p3-machine-row">
        <span className="p3-machine-icon" aria-hidden="true">
          <Monitor size={20} />
        </span>
        <div className="p3-machine-text">
          <h2 id="p3-machine-name" className="p3-machine-name">
            {FAKE.machine}
          </h2>
          <p className="p3-machine-via">
            <Radio size={14} aria-hidden="true" /> through the relay
          </p>
        </div>
        <button
          type="button"
          className="p3-details-toggle"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen(value => !value)}
        >
          Details
          <ChevronDown size={16} aria-hidden="true" data-open={open} />
        </button>
      </div>
      <div id={panel} hidden={!open} className="p3-details">
        <p className="p3-details-label">Fingerprint</p>
        <p className="p3-details-value">{FAKE.fingerprint}</p>
      </div>
    </section>
  );
}

/** "Name this device" stays a real, visible field — one decision, so it sits under the machine, not behind a link. */
export function NameField({ busy, children }: { readonly busy: boolean; readonly children?: ReactNode }) {
  const [name, setName] = useState<string>(FAKE.device);
  return (
    <label className="p3-name">
      <span className="p3-name-label">Name this device</span>
      <input
        type="text"
        className="kt-input p3-name-input"
        value={name}
        maxLength={40}
        autoComplete="off"
        spellCheck={false}
        disabled={busy}
        onChange={event => setName(event.target.value)}
      />
      {children}
    </label>
  );
}

/** The one primary action, plus the quiet way out. */
export function Actions({ stage, onPair, onCancel }: Pick<OptionProps, 'stage' | 'onPair' | 'onCancel'>) {
  const busy = stage === 'pairing';
  return (
    <div className="p3-actions">
      <button type="button" className="kt-btn p3-primary" data-variant="primary" disabled={busy} onClick={onPair}>
        {busy ? 'Pairing…' : 'Pair this device'}
      </button>
      <button type="button" className="p3-quiet" disabled={busy} onClick={onCancel}>
        Not now
      </button>
    </div>
  );
}

export function CheckBadge({ size = 18 }: { readonly size?: number }) {
  return <Check size={size} strokeWidth={3} aria-hidden="true" />;
}
