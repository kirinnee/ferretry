import { PASSKEY_REGISTRATION_WINDOW_SECONDS, type PairedDevice, type PasskeyWindowOpened } from '@ferretry/protocol';

/**
 * Text that came from a device, made safe to print.
 *
 * A device names itself, so its name is attacker-influenced; the pairing schema already refuses
 * control characters, but the daemon's ANSWER schema does not, and a terminal escape in a name would
 * be a terminal escape in the owner's shell. Dropping them costs nothing a person could read.
 */
function plainText(text: string): string {
  return text.replace(/\p{Cc}/gu, '');
}

/** The names, quoted so a name with a comma or a space in it still reads as one name. */
function quoted(names: readonly string[]): string {
  return names.map(name => `"${plainText(name)}"`).join(', ');
}

/** The window is stated in whole minutes, from the one constant that decides how long it is. */
const WINDOW_MINUTES = PASSKEY_REGISTRATION_WINDOW_SECONDS / 60;

export function renderOpened(opened: PasskeyWindowOpened, closesAtLocal: string): string {
  return `The passkey window for ${plainText(opened.deviceName)} is open until ${closesAtLocal}. On that device, open Settings → Daemons → Security → Add a passkey within ${WINDOW_MINUTES} minutes.`;
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

export function renderNotAtMachine(): string {
  return 'Only the owner at the machine can open a passkey window: run this on the host that runs the daemon, as the user whose admin token it holds, not against a remote daemon.';
}

export function renderDeviceGone(binaryName: string): string {
  return `The daemon no longer knows that device, so it may have just been revoked — run \`${binaryName} pair\` to pair it again.`;
}

export function renderDaemonUnreachable(binaryName: string): string {
  return `The daemon did not answer, so no window was opened — start it with \`${binaryName} daemon start\` and run this again.`;
}
