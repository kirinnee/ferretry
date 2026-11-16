/**
 * THE PANE READ for the live activity line: the agent's visible screen, from Terminals' snapshot route
 * (`GET /v1/ferrets/:ferretId/snapshot`) through the half's one client, as a {@link PaneFrameReader}.
 *
 * The route is Terminals' (Conversation declares none; the client guards the call by the route's owner), so this reads the
 * one frame and parses nothing: `usePaneActivity` hands the text to `parsePaneActivity`. It asks for a LIVE capture of
 * the visible `screen` only, which is all the status line needs — the whole scrollback every poll would otherwise
 * carry over the relay — and it is `quiet`: a read the page makes on its own never raises a passkey prompt, the line just
 * says less (a failed read is no error, see `usePaneActivity`).
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { PaneFrameReader } from './live-activity.tsx';

/** Terminals' pane snapshot route, by manifest key. */
const PANE_SNAPSHOT_ROUTE = 'GET /v1/ferrets/:ferretId/snapshot';

export const paneFrameReader =
  (client: Pick<PluginClient, 'call'>, ferretId: string): PaneFrameReader =>
  async signal => {
    signal.throwIfAborted();
    const answer = await client.call<unknown>(PANE_SNAPSHOT_ROUTE, {
      params: { ferretId },
      query: { live: 'true', scope: 'screen' },
      quiet: true,
      signal,
    });
    signal.throwIfAborted();
    return typeof answer === 'string' ? answer : String(answer ?? '');
  };
