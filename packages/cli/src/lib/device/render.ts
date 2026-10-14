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
export function renderDevices(
  devices: readonly PairedDevice[],
  thisDeviceId: string | undefined,
  clientName: string,
): string {
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

/**
 * Text that came from a device, made safe to print.
 *
 * A device names itself, so its name is attacker-influenced; the pairing schema already refuses
 * control characters, but the daemon's ANSWER schema does not, and a terminal escape in a name would
 * be a terminal escape in the owner's shell. Dropping them costs nothing a person could read.
 */
export function plainText(text: string): string {
  return text.replace(/\p{Cc}/gu, '');
}

/** The names, quoted so a name with a comma or a space in it still reads as one name. */
function quoted(names: readonly string[]): string {
  return names.map(name => `"${plainText(name)}"`).join(', ');
}

export function renderNoSuchDevice(query: string, known: readonly PairedDevice[], binaryName: string): string {
  const asked = `No paired device is named or numbered ${quoted([query])}`;
  if (known.length === 0)
    return `${asked}, and no device is paired with this machine yet — run \`${binaryName} pair\` first.`;
  return `${asked}. The paired devices are ${quoted(known.map(device => device.name))}.`;
}

export function renderAmbiguous(query: string, candidates: readonly PairedDevice[]): string {
  const ids = candidates.map(device => device.id).join(', ');
  return `More than one paired device is named ${quoted([query])}, so pass the device id instead of the name: ${ids}.`;
}

/** The one sentence a revocation ends with: what the device can no longer do, and what was cleaned up. */
export function renderRevoked(device: PairedDevice): string {
  return `${plainText(device.name)} can no longer reach this machine; its open sessions were closed and its passkeys forgotten.`;
}

export function renderRevokeDeclined(device: PairedDevice, clientName: string): string {
  return `Refusing to revoke ${plainText(device.name)} without a confirmation: pass --yes to revoke it from a script, or run \`${clientName} device revoke\` at a terminal.`;
}

export function renderRevokeCancelled(device: PairedDevice): string {
  return `Revoke cancelled: ${plainText(device.name)} can still reach this machine.`;
}

export function renderRevokeGone(clientName: string): string {
  return `The daemon no longer knows that device, so it may already have been revoked — run \`${clientName} device ls\` to see who is paired.`;
}

export function renderRevokeUnreachable(clientName: string): string {
  return `The daemon did not answer, so nothing was revoked — start it with \`${clientName} daemon start\` and run this again.`;
}
