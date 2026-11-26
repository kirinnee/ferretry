import type { ConnectorGrantView, ConnectorPendingView, ConnectorStatus } from '../../contract/index.ts';

/**
 * Text that came from a client or the network, made safe to print: a connector client names ITSELF (dynamic
 * registration), so its name is attacker-influenced text on the owner's terminal. The daemon strips control
 * characters too; this is the second line, because an escape sequence in a name is an escape sequence in a shell.
 */
function plainText(text: string): string {
  return text.replace(/\p{Cc}/gu, '');
}

const scopesWords = (scopes: readonly string[]): string =>
  scopes.includes('fleet:write') ? 'read and drive your ferrets' : 'read your ferrets';

/** "in 9 min", "in 40 s", or "expired" — a sign-in lives ten minutes, so nothing longer is needed. */
export function expiresIn(expiresAt: string, now: number): string {
  const seconds = Math.round((Date.parse(expiresAt) - now) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return 'expired';
  return seconds < 90 ? `in ${String(seconds)} s` : `in ${String(Math.round(seconds / 60))} min`;
}

function renderPending(pending: ConnectorPendingView, now: number): string {
  return [
    `  ${pending.matchCode}  ${JSON.stringify(plainText(pending.clientName))} from ${plainText(pending.redirectHost)}`,
    `           would ${scopesWords(pending.scopes)}; expires ${expiresIn(pending.expiresAt, now)}; id ${pending.id}`,
  ].join('\n');
}

function renderGrant(grant: ConnectorGrantView): string {
  const state = grant.revokedAt === undefined ? '' : '  (revoked)';
  return [
    `  ${grant.id}  ${JSON.stringify(plainText(grant.clientName))} from ${plainText(grant.redirectHost)}${state}`,
    `           can ${scopesWords(grant.scopes)}; approved by ${plainText(grant.approvedBy)}; last used ${grant.lastUsedAt ?? 'never'}`,
  ].join('\n');
}

/**
 * The status report: whether the connector is on and where Claude reaches it, then what waits for the owner, then
 * the grants. Short, plain, and each section says what to type next.
 */
export function renderStatus(status: ConnectorStatus, clientName: string, now: number): string {
  if (!status.enabled)
    return ['The Claude connector is off.', status.disabledReason === undefined ? '' : plainText(status.disabledReason)]
      .filter(line => line !== '')
      .join('\n');
  const lines = ['The Claude connector is on.', `MCP URL: ${status.mcpUrl ?? '(unknown)'}`, ''];
  if (status.pending.length === 0) lines.push('No sign-in is waiting.');
  else
    lines.push(
      `Waiting for you (${String(status.pending.length)}):`,
      ...status.pending.map(entry => renderPending(entry, now)),
      `Approve the one whose code matches the page you opened: \`${clientName} connector approve <code>\`.`,
    );
  lines.push('');
  const live = status.grants.filter(grant => grant.revokedAt === undefined);
  if (status.grants.length === 0) lines.push('No client has been approved yet.');
  else
    lines.push(
      `Approved clients (${String(live.length)} live):`,
      ...status.grants.map(renderGrant),
      `Take one away: \`${clientName} connector revoke <id>\`.`,
    );
  return lines.join('\n');
}

export const renderApproved = (grant: ConnectorGrantView, clientName: string): string =>
  `Approved ${JSON.stringify(plainText(grant.clientName))} (${grant.id}). It can ${scopesWords(grant.scopes)} until you revoke it with \`${clientName} connector revoke ${grant.id}\`.`;

export const renderDenied = (pending: ConnectorPendingView): string =>
  `Denied ${JSON.stringify(plainText(pending.clientName))}. Nothing was signed in.`;

export const renderRevoked = (grant: ConnectorGrantView): string =>
  `Revoked ${JSON.stringify(plainText(grant.clientName))} (${grant.id}). It is refused on its very next call.`;
