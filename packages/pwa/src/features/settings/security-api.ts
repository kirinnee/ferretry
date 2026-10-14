/**
 * The browser's half of the security log route.
 *
 * Like the pairing calls beside it, this takes a client rather than building one, so a log read for
 * daemon A is never shown under daemon B. The log names devices and events and never a credential, so
 * there is nothing here to forget — but nothing is cached either, because a security log read from
 * memory is a security log that can be out of date without saying so.
 */

import { type AuditView, AuditViewSchema, type IFyApiClient } from '@ferretry/protocol';

export type SecurityLogClient = Pick<IFyApiClient, 'request'>;

export const AUDIT_PATH = '/v1/audit';
/** How many records the panel asks for: enough for "what happened recently", well inside the cap. */
export const SECURITY_LOG_LIMIT = 100;

/**
 * One page of the log: the recent activity, and the security changes from `keptOffset` back.
 *
 * Both lists are bounded by `limit`; the changes are a list of their own so no amount of activity can
 * push one off the page, and `keptTotal` says how many older pages there are to ask for.
 */
export async function readSecurityLog(
  client: SecurityLogClient,
  limit = SECURITY_LOG_LIMIT,
  keptOffset = 0,
): Promise<AuditView> {
  const skip = keptOffset === 0 ? '' : `&keptOffset=${String(keptOffset)}`;
  return await client.request(`${AUDIT_PATH}?limit=${String(limit)}${skip}`, AuditViewSchema);
}
