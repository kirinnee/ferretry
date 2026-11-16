/**
 * THE DRAFTS-AND-OUTBOX SEAM: names the shared-draft and outbox files need that `./seam.ts` does not carry, kept
 * apart so its owner can fold them in one place.
 *
 *   - DraftStreamClient .... the part of the half's client the shared draft reads, edits and streams through.
 *   - GAP(app-shell) ....... `PluginClient.socket` fills path parameters only and has no query, and its `onClose`
 *     hears a reason, not a close code. So the stream cannot name an Agenda item's own draft (`?item=`), cannot pass
 *     where a returning composer's copy stood (`?generation=&epoch=&rev=`), and cannot tell the daemon's "read the
 *     whole draft again" close (4413) from any other. Until it can: an item slot opens no stream (its draft stays this
 *     device's own and is still read and edited through the two routes), every reconnect asks for the whole draft,
 *     and a close whose reason is not a number is read as an ordinary disconnect.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';

/** The client capabilities the shared draft uses: reads and edits by route key, and the live stream when it exists. */
export type DraftStreamClient = Pick<PluginClient, 'call' | 'socket'>;

/** The close code a socket's `onClose` reason spells, when it spells one; 1006 (abnormal) otherwise. */
export const closeCodeOf = (reason: string): number => {
  const leading = /^\s*(\d{4})\b/u.exec(reason);
  return leading === null ? 1006 : Number(leading[1]);
};
