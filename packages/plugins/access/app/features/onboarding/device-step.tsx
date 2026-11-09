import { detectDeviceKind, type DeviceKind } from './device-kind.ts';

/** What the "This device" step says, by what the device is. */
const DEVICE_STEP_SENTENCES: Readonly<Record<DeviceKind, string>> = Object.freeze({
  mobile:
    'This is a phone or tablet. It watches a machine and cannot run one: a daemon needs a terminal, so pair this device with a computer that runs it.',
  desktop:
    'This is a computer. It can watch a machine from the browser, and it can also run the daemon itself if you want to host your ferrets here.',
});

/** The step's body: the kind of device this is, observed and never asked (device-kind.ts), in one sentence. */
export function DeviceStep({ evidence }: { readonly evidence?: Parameters<typeof detectDeviceKind>[0] }) {
  const kind = detectDeviceKind(evidence ?? (typeof navigator === 'undefined' ? {} : navigator));
  return (
    <p className="m-0 text-cell text-muted" data-device-kind={kind} data-device-step="">
      {DEVICE_STEP_SENTENCES[kind]}
    </p>
  );
}
