import type { KernelPorts } from '@ferretry/kernel/contract';
import { pageTarget } from '../pages/acts.ts';
import type { BrowserSubsystem } from '../pages/service.ts';
import {
  type BrowserViewerHost,
  VIEWER_CLOSE_POLICY,
  type ViewerDeliveryGuard,
  ViewerInputRefused,
} from './viewer-contracts.ts';

/**
 * Who is watching, as far as the host needs to know.
 *
 * `mayType` is what the socket's admission proved about the caller (a person on the host or a paired device, never a
 * ferret): the viewer socket is open to a ferret's credential too, and an input path that skips the holds must never carry
 * ITS keystrokes. A viewer that may not type is handed {@link ViewerInputRefused} for every input, whatever the page's holds
 * say — it watches, and the stream ends.
 *
 * `delivery` is set for an AGENT's viewer only: the ONE guard (`./delivery.ts`: sealed output and the page's scope together)
 * every frame of it passes. A person's viewer has none and is never asked.
 */
export interface HeldViewer {
  readonly mayType: boolean;
  readonly delivery?: ViewerDeliveryGuard | undefined;
}

/**
 * The viewer stream's host: every FRAME put through `kernel.act` (§4.7) as a `stream` act on its page, so a page hold
 * drops it before it is written and a picture of a held page never reaches a viewer (I116) — and a PERSON's own INPUT
 * put through nothing at all. A person typing, pressing or clicking in the live view is the point of taking a page
 * over, and what a hold protects is the page from the AGENT: an input hold (a card pending, a private value just
 * typed) refuses a ferret's acts, never the owner's delivery (v4: the viewer's input was never held). The act runner
 * would otherwise decide it as `type` / `press` and could refuse the very person it protects.
 *
 * An AGENT's frame is DELIVERY-GUARDED, in the one guard's order: it is stamped the moment it arrives, before anything is
 * awaited; the page's permission is proved (the one rule, asked once per page); it passes the act runner; and where it
 * leaves — after every await — the stamp is asked again, synchronously. A permission withdrawn in between (a takeover, a
 * value sealed) fails that last check, and one withdrawn with no frame in flight ends the stream at once (`watch`). The
 * stream asks the same guard again before every send of a frame it held back for a congested socket, and hands it to the
 * transport as its send permit.
 */
export function heldViewerHost(
  kernel: Pick<KernelPorts, 'act'>,
  host: BrowserSubsystem,
  viewer: HeldViewer,
): BrowserViewerHost {
  const { mayType, delivery } = viewer;
  return {
    attachViewer: async (sessionId, onFrame, onTerminal) => {
      /** Ends the stream with the guard's sentence, once. */
      let ended = false;
      const end = (reason: string): void => {
        if (ended) return;
        ended = true;
        onTerminal({ code: VIEWER_CLOSE_POLICY, reason });
      };
      // A permission withdrawn while the stream is open ends it AT ONCE, with no frame needed (the stream drops what it held).
      const unwatch = delivery?.watch?.(end);
      let attachment: Awaited<ReturnType<BrowserViewerHost['attachViewer']>>;
      try {
        attachment = await host.attachViewer(
          sessionId,
          frame => {
            const act = async (): Promise<boolean> =>
              (await kernel.act(pageTarget(frame.pageId), 'stream', async () => ({ kind: 'content' as const }))).ok;
            if (delivery === undefined) {
              void act()
                .then(ok => {
                  if (ok) onFrame(frame);
                })
                .catch(() => undefined);
              return;
            }
            // Stamped where it arrives: before the permission is proved and before the act runner is awaited.
            const since = delivery.stamp(frame.pageId);
            void (async () => {
              if (ended) return;
              if (delivery.admit !== undefined && !(await delivery.admit(frame.pageId))) return end(delivery.refusal);
              if (!delivery.mayDeliver(since)) return end(delivery.refusal);
              if (!(await act()) || ended) return;
              // The act was awaited: a takeover or a seal may have begun meanwhile. Asked again where the frame leaves.
              if (delivery.mayDeliver(since)) onFrame(frame);
              else end(delivery.refusal);
            })().catch(() => undefined);
          },
          onTerminal,
        );
      } catch (error) {
        unwatch?.();
        throw error;
      }
      return {
        detach: () => {
          unwatch?.();
          attachment.detach();
        },
      };
    },
    dispatchHumanInput: async (sessionId, input) => {
      if (!mayType) throw new ViewerInputRefused();
      await host.dispatchHumanInput(sessionId, input);
    },
  };
}
