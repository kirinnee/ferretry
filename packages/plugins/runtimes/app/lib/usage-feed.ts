/**
 * THE QUOTA ROWS OF ONE DAEMON, read through Usage's contract (`GET /v1/usage`, `UsageFeedViewSchema`).
 *
 * Runtimes `uses` Usage optionally: Usage is the owner of the feed and of how it is collected, and the picker only
 * reads it. Three answers, kept apart so each says what it knows:
 *   - rows: the feed was read;
 *   - none, no complaint: Usage is off on this daemon (the shell's client refuses the call without sending it), so
 *     the picker is simply drawn without quota;
 *   - none, with a sentence: Usage is on and the read failed. The picker still works and says quota is missing.
 */

import { type UsageAccountView, UsageFeedViewSchema } from '@ferretry/plugin-usage/contract';
import { type RuntimesClient, callFailure } from './client.ts';

export const USAGE_FEED_ROUTE = 'GET /v1/usage' as const;

/** The code the shell's client throws, unsent, for a call to a plugin that is off on this daemon. */
const PLUGIN_OFF = 'plugin_paused';

export interface UsageRows {
  readonly rows: readonly UsageAccountView[];
  /** Why the feed is missing, when Usage is on and could not be read. `null` when read, or when Usage is off. */
  readonly error: string | null;
}

export const NO_USAGE: UsageRows = Object.freeze({ rows: [], error: null });

export const readUsageRows = async (client: RuntimesClient): Promise<UsageRows> => {
  let answer: unknown;
  try {
    answer = await client.call(USAGE_FEED_ROUTE);
  } catch (failure) {
    const detail = callFailure(failure);
    if (detail?.code === PLUGIN_OFF) return NO_USAGE;
    const why = typeof detail?.message === 'string' && detail.message !== '' ? ` (${detail.message})` : '';
    return { rows: [], error: `Quota could not be read${why}.` };
  }
  const feed = UsageFeedViewSchema.safeParse(answer);
  if (!feed.success) return { rows: [], error: 'Quota could not be read (the answer was not a usage feed).' };
  return { rows: feed.data.accounts, error: null };
};
