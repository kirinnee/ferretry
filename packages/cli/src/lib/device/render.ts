import { CAPABILITY_AXES, type CapabilityGrants, DAEMON_CAPABILITIES, type PairedDevice } from '@ferretry/protocol';

/**
 * One device's grants, one capability per line.
 */
export function renderDeviceGrants(grants: CapabilityGrants, indent = '  '): string {
  const width = Math.max(...DAEMON_CAPABILITIES.map(capability => capability.length));
  return DAEMON_CAPABILITIES.map(capability => {
    const axes = CAPABILITY_AXES.map(axis => `${axis}=${grants[capability][axis] ? 'on ' : 'off'}`).join('  ');
    return `${indent}${capability.padEnd(width)}  ${axes}`;
  }).join('\n');
}

/**
 * The paired-device report.
 *
 * Device names are chosen by the redeeming device and are therefore untrusted text; they are printed
 * on their own line, quoted, so one cannot impersonate the structure around it.
 */
export function renderDevices(devices: readonly PairedDevice[], thisDeviceId: string | undefined, clientName: string): string {
  if (devices.length === 0) return `no device is paired with this host; pair one with \`${clientName} pair\``;
  const blocks = devices.map(device =>
    [
      `${JSON.stringify(device.name)}${device.id === thisDeviceId ? '  (this device)' : ''}`,
      `  id         ${device.id}`,
      `  last seen  ${device.lastSeenAt}`,
      renderDeviceGrants(device.grants),
    ].join('\n'),
  );
  return [
    'These are the devices paired with this host. This command line is ungoverned.',
    '',
    blocks.join('\n\n'),
    '',
    `change one with \`${clientName} device grant <device> <capability> --use|--no-use --configure|--no-configure\``,
  ].join('\n');
}

/** What one change reports: the device, then everything it now holds. */
export function renderDeviceChange(device: PairedDevice): string {
  return [`${JSON.stringify(device.name)} (${device.id}) now holds:`, renderDeviceGrants(device.grants)].join('\n');
}
