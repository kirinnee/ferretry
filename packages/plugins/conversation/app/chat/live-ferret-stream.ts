/**
 * THE CHAT'S LIVE EVENT STREAM for the ferret on screen: `GET /v1/events` (Ferrets' journal socket) opened for ONE
 * ferret with the two optional feeds the chat asks for, `live=1` (the working turn's readout and any compaction) and
 * `transcript=1` ("the transcript just changed").
 *
 *   - a `live` frame is parsed with Ferrets' own `FerretLiveActivitySchema` and published to the page's hub, which keeps
 *     only the latest sample (a readout is the present);
 *   - a `transcript` frame carries no content: it nudges the chat's refresh, which re-reads through the ordinary reads;
 *   - every other frame (the journal's own events and idle proofs) is not the chat's and is ignored. A frame that does
 *     not parse is dropped: the reads are the truth, the stream is only a hurry-up.
 *
 * NO JOURNAL REPLAY. A bare `GET /v1/events?sessionId=` replays the ferret's whole journal (a page of 1 000 events at a
 * time) before it goes live, and the chat reads none of those events: it wants only the `live` and `transcript` frames, which
 * the daemon sends after the replay and which do not depend on the cursor. Over a relay, for a long session, that replay
 * is megabytes on every chat open. There is no cheaper way to ask for "from now": `tail` is the fleet stream's and is
 * refused with a session id, the summary the chat reads carries no journal cursor, and the per-ferret events route only
 * pages forward from a cursor, so finding the latest one would itself read the whole journal. So the chat opens at the
 * end of the journal: `after` is the largest safe integer ({@link FROM_NOW}), the daemon's replay finds nothing past it
 * and sends no `event` frame, and a live journal event (always numbered below it) is dropped by the daemon's own
 * duplicate check rather than sent.
 *
 * A stream that ends is opened again after a pause unless the daemon refused it (`1008`, `4403`): a refusal is not a
 * drop, and dialling again would only be refused again. While there is no stream a compaction can no longer be
 * vouched for, so it is withdrawn from the sample rather than left saying "Compacting" forever.
 */
import { useEffect, useMemo, useRef } from 'react';
import { createLiveActivityHub, type LiveActivityFeed } from '@ferretry/app';
import { type FerretLiveActivity, FerretLiveActivitySchema } from '@ferretry/core-ferrets/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';

/** Ferrets' journal socket, by manifest key. */
const EVENTS_SOCKET = 'GET /v1/events';

/** The pause before a dropped stream is opened again. */
const LIVE_STREAM_RETRY_MS = 5_000;

/** The cursor that starts the stream past every journal event: no replay and no `event` frames, only `live` and `transcript`. */
const FROM_NOW = String(Number.MAX_SAFE_INTEGER);

/** Close codes that are the daemon (or the carrier) saying no, not a drop. */
const REFUSAL_CLOSE_CODES: ReadonlySet<number> = new Set([1008, 4403]);

/** What one text frame off the stream means to the chat: a readout, "the transcript moved", or nothing. */
type LiveFrame =
  | { readonly kind: 'live'; readonly live: FerretLiveActivity }
  | { readonly kind: 'transcript' }
  | { readonly kind: 'ignored' };

/** Reads one frame for `ferretId`. Total: a frame that is not valid JSON, not this ferret's or not a shape we know is ignored. */
const readLiveFrame = (data: string | Uint8Array, ferretId: string): LiveFrame => {
  if (typeof data !== 'string') return { kind: 'ignored' };
  let frame: unknown;
  try {
    frame = JSON.parse(data);
  } catch {
    return { kind: 'ignored' };
  }
  if (typeof frame !== 'object' || frame === null) return { kind: 'ignored' };
  const { kind } = frame as { readonly kind?: unknown };
  if (kind === 'transcript') {
    const moved = (frame as { readonly transcript?: { readonly sessionId?: unknown } }).transcript;
    return moved?.sessionId === ferretId ? { kind: 'transcript' } : { kind: 'ignored' };
  }
  if (kind === 'live') {
    const parsed = FerretLiveActivitySchema.safeParse((frame as { readonly live?: unknown }).live);
    return parsed.success && parsed.data.sessionId === ferretId
      ? { kind: 'live', live: parsed.data }
      : { kind: 'ignored' };
  }
  return { kind: 'ignored' };
};

/**
 * Opens the live stream for `ferretId` while the chat is on screen, and returns the feed the page reads. `onTranscript`
 * is called for each "the transcript moved" frame (the chat nudges its refresh); it is read fresh, so a caller may pass
 * a new function every render. A client that opens no live stream (`socket` absent) gives a feed that never says anything.
 */
export function useLiveFerretStream(
  client: PluginClient,
  ferretId: string,
  onTranscript: () => void,
): LiveActivityFeed<FerretLiveActivity> {
  // One hub per client and ferret, so a sample can never be read as another ferret's.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the client and the ferret are what the hub is FOR.
  const hub = useMemo(() => createLiveActivityHub<FerretLiveActivity>(), [client, ferretId]);
  const latest = useRef(onTranscript);
  latest.current = onTranscript;
  useEffect(() => {
    if (client.socket === undefined) return;
    let stopped = false;
    let closeStream: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const open = (): void => {
      if (stopped || client.socket === undefined) return;
      let ended = false;
      const socket = client.socket(
        EVENTS_SOCKET,
        {},
        {
          onFrame: data => {
            if (stopped) return;
            const frame = readLiveFrame(data, ferretId);
            if (frame.kind === 'live') hub.publish(frame.live);
            else if (frame.kind === 'transcript') latest.current();
          },
          onClose: (_reason, code) => {
            if (ended) return;
            ended = true;
            closeStream = undefined;
            if (stopped) return;
            // No stream, no vouching for a compaction that was running when it ended.
            const last = hub.current();
            if (last?.compaction !== undefined) {
              const { compaction: _withdrawn, ...rest } = last;
              hub.publish(rest);
            }
            if (code !== undefined && REFUSAL_CLOSE_CODES.has(code)) return;
            timer = setTimeout(open, LIVE_STREAM_RETRY_MS);
          },
        },
        { sessionId: ferretId, after: FROM_NOW, live: '1', transcript: '1' },
      );
      closeStream = () => {
        ended = true;
        socket.close();
      };
    };
    open();
    return () => {
      stopped = true;
      clearTimeout(timer);
      closeStream?.();
    };
  }, [client, ferretId, hub]);
  return hub;
}
