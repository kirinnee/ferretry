/**
 * THE DRAFTS-AND-OUTBOX SEAM: names the shared-draft and outbox files need that `./seam.ts` does not carry, kept
 * apart so its owner can fold them in one place.
 *
 *   - DraftStreamClient .... the part of the half's client the shared draft reads, edits and streams through.
 *   - `PluginClient.socket` takes a query and reports the close code, so the stream names an Agenda item's own draft
 *     (`?item=`), says where a returning composer's copy stood (`?generation=&epoch=&rev=`, all or none) so a
 *     reconnect reads only what moved, and tells the daemon's "read the whole draft again" close (4413) from any
 *     other. A shell that reports no close code leaves it spelled in the reason, and a reason that is not a number
 *     reads as an ordinary disconnect.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';

/** The client capabilities the shared draft uses: reads and edits by route key, and the live stream when it exists. */
export type DraftStreamClient = Pick<PluginClient, 'call' | 'socket'>;

/** The close code a reason spells, when the shell gave no code: 1006 (abnormal) if it spells none. */
export const closeCodeOf = (reason: string): number => {
  const leading = /^\s*(\d{4})\b/u.exec(reason);
  return leading === null ? 1006 : Number(leading[1]);
};
