import { PASSKEY_REGISTRATION_WINDOW_SECONDS, type PasskeyWindowOpened } from '@ferretry/protocol';
import { plainText } from '../device/render.ts';

/** The window is stated in whole minutes, from the one constant that decides how long it is. */
const WINDOW_MINUTES = PASSKEY_REGISTRATION_WINDOW_SECONDS / 60;

export function renderOpened(opened: PasskeyWindowOpened, closesAtLocal: string): string {
  return `The passkey window for ${plainText(opened.deviceName)} is open until ${closesAtLocal}. On that device, open Settings → Daemons → Security → Add a passkey within ${WINDOW_MINUTES} minutes.`;
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
