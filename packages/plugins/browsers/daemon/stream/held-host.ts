import type { KernelPorts } from '@ferretry/kernel/contract';
import { pageTarget } from '../pages/acts.ts';
import type { BrowserSubsystem } from '../pages/service.ts';
import type { BrowserViewerHost } from './viewer-contracts.ts';

/**
 * The viewer stream's host: every FRAME put through `kernel.act` (§4.7) as a `stream` act on its page, so a page hold
 * drops it before it is written and a picture of a held page never reaches a viewer (I116) — and the owner's own INPUT
 * put through nothing at all. A person typing, pressing or clicking in the live view is the point of taking a page
 * over, and what a hold protects is the page from the AGENT: an input hold (a card pending, a private value just
 * typed) refuses a ferret's acts, never the owner's delivery (v4: the viewer's input was never held). The act runner
 * would otherwise decide it as `type` / `press` and could refuse the very person it protects.
 */
export function heldViewerHost(kernel: Pick<KernelPorts, 'act'>, host: BrowserSubsystem): BrowserViewerHost {
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
      await host.dispatchHumanInput(sessionId, input);
    },
  };
}
