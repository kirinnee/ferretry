/**
 * Settings › This device › Permissions: every permission Ferretry can use, what it is for, what state
 * it is in right now, and the one next step.
 *
 * NEVER ASKS BY ITSELF. Opening this page only READS state. A browser prompt appears only from a row's
 * own button, pressed by the reader — the controller's `request` is called straight from the click
 * handler with nothing awaited first, which is the shape iOS requires.
 *
 * A REFUSAL IS A DEAD END IN THE BROWSER. Once a permission is denied no page can ask again, so the
 * row says where it is switched back on for THIS kind of device (`howToEnable`) instead of offering a
 * button that would do nothing. The page re-reads when the reader returns to the tab.
 */

import { Check, ChevronDown, CircleHelp, CircleSlash, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { useDevicePermissions } from '../../hooks/use-device-permissions.ts';
import { cn } from '../../lib/class-names.ts';
import {
  DEVICE_PERMISSIONS,
  type DeviceFacts,
  type DevicePermissionInfo,
  type DevicePermissionState,
  howToEnable,
  permissionAction,
  unsupportedNote,
} from '../../lib/device-permissions.ts';
import { Button } from '../../shell/primitives.tsx';

const STATE_COPY: Readonly<Record<DevicePermissionState, string>> = {
  granted: 'Allowed',
  denied: 'Blocked',
  prompt: 'Not asked yet',
  unsupported: 'Unavailable',
};

const STATE_TONE: Readonly<Record<DevicePermissionState, string>> = {
  granted: 'border-ok text-ok',
  denied: 'border-warn text-warn',
  prompt: 'border-border-strong text-muted',
  unsupported: 'border-border text-faint',
};

function StateIcon({ state }: { readonly state: DevicePermissionState }) {
  if (state === 'granted') return <Check size={14} aria-hidden="true" />;
  if (state === 'denied') return <ShieldAlert size={14} aria-hidden="true" />;
  if (state === 'prompt') return <CircleHelp size={14} aria-hidden="true" />;
  return <CircleSlash size={14} aria-hidden="true" />;
}

interface RowProps {
  readonly info: DevicePermissionInfo;
  readonly state: DevicePermissionState | undefined;
  readonly facts: DeviceFacts;
  readonly onRequest: () => void;
}

function PermissionRow({ info, state, facts, onRequest }: RowProps) {
  const [open, setOpen] = useState(false);
  const action = state === undefined ? 'none' : permissionAction(state);
  const steps = howToEnable(info.id, facts);
  return (
    <li
      className="flex flex-col gap-2 rounded-control border border-border bg-surface-2 px-control-x py-3"
      data-permission={info.id}
      data-state={state ?? 'checking'}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-ui font-semibold text-fg">{info.label}</span>
        <span
          className={cn(
            'inline-flex min-h-6 items-center gap-1 rounded-full border px-2 text-meta font-semibold',
            state === undefined ? 'border-border text-faint' : STATE_TONE[state],
          )}
        >
          {state === undefined ? null : <StateIcon state={state} />}
          {state === undefined ? 'Checking…' : STATE_COPY[state]}
        </span>
      </div>
      <p className="m-0 text-meta leading-base text-muted">{info.why}</p>
      {state === 'unsupported' ? (
        <p className="m-0 text-meta leading-base text-faint" role="note">
          {unsupportedNote(info.id, facts)}
        </p>
      ) : null}
      {action === 'request' ? (
        <div>
          <Button variant="primary" data-permission-request={info.id} onClick={onRequest}>
            {info.requestLabel}
          </Button>
        </div>
      ) : null}
      {action === 'how-to' ? (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            aria-expanded={open}
            data-permission-howto={info.id}
            onClick={() => setOpen(!open)}
            className="inline-flex min-h-[44px] items-center gap-1 self-start rounded-control px-2 text-ui font-semibold text-accent hover:bg-accent-soft focus-visible:outline-focus focus-visible:outline-offset-focus"
          >
            How to enable
            <ChevronDown size={16} aria-hidden="true" className={cn('transition-transform', open && 'rotate-180')} />
          </button>
          {open ? (
            <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-meta leading-base text-fg">
              {steps.map(step => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function DevicePermissionsSetting() {
  const controller = useDevicePermissions(typeof document === 'undefined' ? null : document);
  if (controller === null) {
    return (
      <p role="status" className="m-0 text-ui leading-base text-muted">
        This page was opened without a way to read device permissions.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-meta leading-base text-faint">
        Nothing here is asked for until you press its button. Ferretry never uses a permission in the background.
      </p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Device permissions">
        {DEVICE_PERMISSIONS.map(info => (
          <PermissionRow
            key={info.id}
            info={info}
            state={controller.states[info.id]}
            facts={controller.facts}
            onRequest={() => void controller.request(info.id)}
          />
        ))}
      </ul>
    </div>
  );
}
