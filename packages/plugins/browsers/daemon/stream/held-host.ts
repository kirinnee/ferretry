import type { KernelPorts } from '@ferretry/kernel/contract';
import { pageTarget } from '../pages/acts.ts';
import type { BrowserSubsystem } from '../pages/service.ts';
import { type BrowserViewerHost, VIEWER_CLOSE_POLICY, ViewerInputRefused } from './viewer-contracts.ts';

/**
 * The viewer stream's host: every FRAME put through `kernel.act` (§4.7) as a `stream` act on its page, so a page hold
 * drops it before it is written and a picture of a held page never reaches a viewer (I116) — and a PERSON's own INPUT
 * put through nothing at all. A person typing, pressing or clicking in the live view is the point of taking a page
 * over, and what a hold protects is the page from the AGENT: an input hold (a card pending, a private value just
 * typed) refuses a ferret's acts, never the owner's delivery (v4: the viewer's input was never held). The act runner
 * would otherwise decide it as `type` / `press` and could refuse the very person it protects.
 *
 * `mayType` is what the socket's admission proved about the caller (a person on the host or a paired device, never a
 * ferret): the viewer socket is open to a ferret's credential too, and an input path that skips the holds must never
 * carry ITS keystrokes. A viewer that may not type is handed {@link ViewerInputRefused} for every input, whatever the
 * page's holds say — it watches, and the stream ends.
 *
 * `admit` is what a FERRET's viewer adds: asked before every frame whether the ferret may still see that page (the one
 * rule the page tools use: its own, and nobody holds it). A page that stops being admitted — a person took it over, the
 * view moved to a person's page — ends the stream on a policy close, and no frame of it is sent. A person's viewer
 * passes no `admit` and is never asked. A sealed value on a page (secure copy) joins the same rule, not a second check.
 */
export function heldViewerHost(
  kernel: Pick<KernelPorts, 'act'>,
  host: BrowserSubsystem,
  mayType: boolean,
  admit?: (pageId: string) => Promise<boolean>,
): BrowserViewerHost {
  /** One look at a time per page: frames that arrive while it is being made share its answer. */
  const asking = new Map<string, Promise<boolean>>();
  const admitted = async (pageId: string): Promise<boolean> => {
    if (admit === undefined) return true;
    const pending = asking.get(pageId) ?? admit(pageId).catch(() => false);
    asking.set(pageId, pending);
    try {
      return await pending;
    } finally {
      if (asking.get(pageId) === pending) asking.delete(pageId);
    }
  };
  return {
    attachViewer: async (sessionId, onFrame, onTerminal) => {
      let ended = false;
      return await host.attachViewer(
        sessionId,
        frame => {
          void admitted(frame.pageId)
            .then(async allowed => {
              if (ended) return;
              if (!allowed) {
                ended = true;
                onTerminal({ code: VIEWER_CLOSE_POLICY, reason: 'this page is no longer yours to watch' });
                return;
              }
              const decision = await kernel.act(pageTarget(frame.pageId), 'stream', async () => ({
                kind: 'content' as const,
              }));
              if (decision.ok && !ended) onFrame(frame);
            })
            .catch(() => undefined);
        },
        onTerminal,
      );
    },
    dispatchHumanInput: async (sessionId, input) => {
      if (!mayType) throw new ViewerInputRefused();
      await host.dispatchHumanInput(sessionId, input);
    },
  };
}
