import type { BrowserLoginStatus } from '@ferretry/protocol';

export { BrowserLoginStatusSchema } from '@ferretry/protocol';

export function renderLoginStatus(status: BrowserLoginStatus): string {
  const lines = [`browser login window: ${status.state}`];
  if (status.state === 'open' || status.state === 'closing') {
    lines.push(`opened ${status.openedAt}`);
    lines.push(`closes ${status.expiresAt}`);
  }
  lines.push(`profile primed: ${status.profilePrimed ? 'yes' : 'no'}`);
  if (status.state === 'open') {
    // The daemon substitutes the real port and a one-shot password; nobody assembles this by hand.
    lines.push(`tunnel: ${status.connection.sshTunnel}`);
    lines.push(`then point a VNC viewer at ${status.connection.host}:${status.connection.port}`);
    lines.push(`password: ${status.connection.password}`);
  }
  if (status.state === 'error' && status.error) lines.push(`error: ${status.error}`);
  return lines.join('\n');
}
