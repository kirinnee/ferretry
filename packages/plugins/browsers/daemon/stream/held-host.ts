import type { KernelPorts } from '@ferretry/kernel/contract';
import { pageTarget } from '../pages/acts.ts';
import type { BrowserSubsystem } from '../pages/service.ts';
import { type BrowserViewerHost, ViewerInputRefused } from './viewer-contracts.ts';

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
 */
export function heldViewerHost(
  kernel: Pick<KernelPorts, 'act'>,
  host: BrowserSubsystem,
  mayType: boolean,
): BrowserViewerHost {
  return {
    attachViewer: async (sessionId, onFrame, onTerminal) =>
      await host.attachViewer(
        sessionId,
        frame => {
          void kernel
            .act(pageTarget(frame.pageId), 'stream', async () => ({ kind: 'content' as const }))
            .then(decision => {
              if (decision.ok) onFrame(frame);
            })
            .catch(() => undefined);
        },
        onTerminal,
      ),
    dispatchHumanInput: async (sessionId, input) => {
      if (!mayType) throw new ViewerInputRefused();
      await host.dispatchHumanInput(sessionId, input);
    },
  };
}
