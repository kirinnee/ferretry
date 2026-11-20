/**
 * ONE PAIRED DEVICE in Settings › Devices: its name, when it arrived, the Revoke that ends its access, and (folded away)
 * what it may do, as a row per capability with a Use and a Configure switch.
 *
 * The device's name is text the redeeming device chose, so it is rendered as text and it WRAPS: a device somebody is about
 * to revoke is the last place to hide which device it is. What revoking does is said in the same breath as the button.
 */

import { CAPABILITY_AXES, CAPABILITY_NAMES, type CapabilityName } from '@ferretry/core-gate/contract';
import type { CapabilityAxis } from '@ferretry/kernel/contract';
import { SettingRow } from '@ferretry/app';
import { ChevronRight, MonitorSmartphone, Trash2 } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import type { DeviceGrantsPatch, PairedDevice, PairedDevicesView } from '../../../contract/index.ts';
import { cn } from '../../shell-pairing.ts';
import { axisLabel, capabilityLabel } from '../../lib/grants.ts';
import {
  deviceAxisControl,
  deviceGrantPatch,
  isThisDevice,
  pairedDeviceSummary,
  revokeConsequence,
  SELF_NARROW_NOTE,
} from '../../lib/pairing-invite.ts';
import type { PairingFailure } from './add-device-api.ts';
import { ConfirmStrip, LabelledSwitch, Notice } from './access-kit.tsx';
import { FailureNotice } from './invite-panel.tsx';

/** One axis of one capability on one device: a switch, or a statement with its remedy. */
function DeviceAxisSwitch({
  device,
  view,
  capability,
  axis,
  busy,
  clientName,
  onChange,
}: {
  readonly device: PairedDevice;
  readonly view: PairedDevicesView;
  readonly capability: CapabilityName;
  readonly axis: CapabilityAxis;
  readonly busy: boolean;
  readonly clientName: string;
  readonly onChange: (next: boolean) => void;
}) {
  const control = deviceAxisControl(view, device, capability, axis, clientName);
  const mark = `${device.id}:${capability}.${axis}`;
  return (
    <span className="fy-acc-cap__axis">
      <LabelledSwitch
        label={axisLabel(axis)}
        accessibleName={`${capabilityLabel(capability)} — ${axisLabel(axis)}${control.reason === null ? '' : `. ${control.reason}`}`}
        checked={control.checked}
        disabled={busy || control.blocked}
        onChange={onChange}
        marks={{ 'data-device-grant': mark, 'data-device-grant-blocked': control.blocked ? 'yes' : 'no' }}
      />
      {control.reason === null ? null : (
        <span className="fy-acc-cap__reason" aria-hidden="true" data-device-grant-reason={mark}>
          {control.reason}
        </span>
      )}
    </span>
  );
}

export interface PairedDeviceRowProps {
  readonly device: PairedDevice;
  readonly note?: ReactNode;
  readonly view: PairedDevicesView;
  readonly busy: boolean;
  readonly clientName: string;
  readonly grantFailure: PairingFailure | null;
  readonly initiallyOpen: boolean;
  readonly onRevoke: () => void;
  readonly onChangeGrants: (patch: DeviceGrantsPatch) => void;
}

export function PairedDeviceRow({
  device,
  view,
  busy,
  clientName,
  grantFailure,
  initiallyOpen,
  note,
  onRevoke,
  onChangeGrants,
}: PairedDeviceRowProps) {
  const mine = isThisDevice(device, view);
  const describedBy = useId();
  const [open, setOpen] = useState(initiallyOpen);
  const [confirming, setConfirming] = useState(false);
  const held = CAPABILITY_NAMES.filter(capability => CAPABILITY_AXES.some(axis => device.grants[capability][axis]));
  return (
    <SettingRow
      name={device.name}
      dataAttributes={{ 'data-paired-device': device.id }}
      hint={
        mine ? (
          <span className="fy-acc-chip" data-paired-device-self="">
            this device
          </span>
        ) : undefined
      }
      control={() => (
        <button
          type="button"
          disabled={busy}
          aria-describedby={describedBy}
          aria-expanded={confirming}
          data-pair-revoke-device={device.id}
          onClick={() => setConfirming(true)}
          className="kt-btn min-h-[44px] shrink-0 disabled:cursor-not-allowed disabled:opacity-60"
          data-variant="danger"
        >
          <Trash2 size={14} aria-hidden="true" />
          Revoke
        </button>
      )}
    >
      <div className="fy-acc-body">
        {/* When it arrived and was last seen: whole, never cut to one line (a device somebody may revoke). */}
        <p className="fy-acc-fine">{pairedDeviceSummary(device)}</p>
        <p className="fy-acc-fine" id={describedBy} hidden={confirming}>
          <MonitorSmartphone size={13} className="mr-1 inline" aria-hidden="true" />
          {revokeConsequence(device, view)}
        </p>
        {note}
        {confirming ? (
          <ConfirmStrip
            question={mine ? 'Revoke this browser?' : `Revoke ${device.name}?`}
            consequence={revokeConsequence(device, view)}
            confirmLabel={mine ? `Revoke and sign out here` : `Yes, revoke ${device.name}`}
            busy={busy}
            onConfirm={() => {
              setConfirming(false);
              onRevoke();
            }}
            onCancel={() => setConfirming(false)}
            marks={{ 'data-pair-revoke-device-confirming': device.id }}
            confirmMarks={{ 'data-pair-revoke-device-confirm': device.id }}
            cancelMarks={{ 'data-pair-revoke-device-cancel': device.id }}
          />
        ) : null}
        <details
          open={open}
          onToggle={event => setOpen(event.currentTarget.open)}
          className="min-w-0"
          data-device-capabilities={device.id}
        >
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-1.5 text-ui font-medium text-fg">
            <ChevronRight
              size={14}
              className={cn('shrink-0 transition-transform', open && 'rotate-90')}
              aria-hidden="true"
            />
            What it may do
            <span className="text-meta font-normal text-faint" data-device-capabilities-count="">
              {held.length === 0 ? 'none' : `${String(held.length)} of ${String(CAPABILITY_NAMES.length)}`}
            </span>
          </summary>
          {mine ? (
            <Notice tone="warn" marks={{ 'data-device-grant-self-note': '' }}>
              {SELF_NARROW_NOTE}
            </Notice>
          ) : null}
          <ul className="fy-acc-caps" data-wide="yes" aria-label={`What ${device.name} may do`}>
            {CAPABILITY_NAMES.map(capability => (
              <li key={capability} className="fy-acc-cap" data-device-capability={capability}>
                <span className="fy-acc-cap__name">{capabilityLabel(capability)}</span>
                <span className="fy-acc-cap__axes">
                  {CAPABILITY_AXES.map(axis => (
                    <DeviceAxisSwitch
                      key={axis}
                      device={device}
                      view={view}
                      capability={capability}
                      axis={axis}
                      busy={busy}
                      clientName={clientName}
                      onChange={next => onChangeGrants(deviceGrantPatch(capability, axis, next))}
                    />
                  ))}
                </span>
              </li>
            ))}
          </ul>
          {grantFailure === null ? null : (
            <FailureNotice message={grantFailure.message} marks={{ 'data-device-grant-failure': device.id }} />
          )}
        </details>
      </div>
    </SettingRow>
  );
}
