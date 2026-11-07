import type { KernelPorts } from '@ferretry/kernel/contract';
import { pageTarget, writeAct } from '../pages/acts.ts';
import type { BrowserSubsystem } from '../pages/service.ts';
import type { BrowserViewerHost } from './viewer-contracts.ts';

/**
 * The viewer stream's host with every frame and every input put through `kernel.act` (§4.7). A frame is a `stream`
 * act on its page (reads and pictures): a page hold drops it before it is written, so a picture of a held page never
 * reaches a viewer (I116). A person's input is a write act on the page they view — `type` for inserted text (one
 * JSON event, never split: R549), `press` for keys and the mouse — so `InputHolds` decides it inside the page's queue.
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
      const status = await host.status(sessionId);
      if (status.state !== 'running' || !('activePageId' in status)) return await host.dispatchHumanInput(sessionId, input);
      await writeAct(kernel.act, pageTarget(status.activePageId), input.kind === 'insertText' ? 'type' : 'press', async () => {
        await host.dispatchHumanInput(sessionId, input);
      });
    },
  };
}
