import type { LiveFeedSignal } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { PageChanged } from '../../contract/index.ts';

/** How often a read is repeated while the daemon's event feed is not saying what changed. */
export const PAGE_POLL_MS = 10_000;

/** The safety-net read while the feed is live, for a page closed or moved without an event. */
export const PAGE_LIVE_POLL_MS = 120_000;

/**
 * One session's page changes as the feed a read stands back for (`startFeedAwarePoll`): every `browsers.page-changed`
 * of THIS session — a page opened or closed, taken over, handed over, asked for, or an agent driving — and, where the
 * shell says it, whether the feed is live.
 */
export const pageChangeFeed = (client: PluginClient, sessionId: string): LiveFeedSignal => {
  const feed = client.feed;
  return {
    subscribe: listener =>
      client.subscribe(PageChanged, change => {
        if (change.ferret === sessionId) listener(change);
      }),
    ...(feed === undefined ? {} : { isLive: () => feed.isLive(), subscribeLive: feed.subscribeLive }),
  };
};
