import type { SessionId } from '../../../lib/session-id.ts';
import type { SendPaneObservation, SendTerminal } from '../../../lib/session/send/types.ts';
import { paneShowsActiveWork, type TmuxController } from '../../../lib/tmux/index.ts';
import type { TmuxPaneDelivery } from '../../tmux/pane-delivery.ts';
import type { TmuxPaneQueue } from '../../tmux/pane-queue.ts';

/**
 * The terminal side of a send, over the daemon's own isolated tmux socket.
 *
 * Every address goes through the injected controller, which refuses a bare executable name — so no
 * lookup can land on a tmux server the host already runs, and nothing here can touch a pane this
 * daemon did not create. That matters more on this path than on any other: a send TYPES, and a
 * keystroke sent to somebody else's terminal cannot be taken back.
 *
 * THE STOP KEY IS ESCAPE, and it is the only key this adapter presses on its own initiative. It is
 * the safe stop-the-current-turn key in both harness TUIs, while `C-c` is the QUIT path — Codex exits
 * on it at an idle prompt. Exactly one keystroke per call, with no internal retries: a stop that did
 * not take is something the caller re-decides, not something this loop insists on.
 */
export class TmuxSendTerminal implements SendTerminal {
  constructor(
    private readonly tmux: TmuxController,
    private readonly session: (id: SessionId) => Promise<string>,
    private readonly delivery: TmuxPaneDelivery,
    private readonly queueDelivery: TmuxPaneQueue,
  ) {}

  async observe(id: SessionId): Promise<SendPaneObservation> {
    const state = await this.tmux.state(await this.session(id));
    return {
      alive: state.alive,
      dead: state.dead,
      promptReady: state.promptReady,
      activeWork: paneShowsActiveWork(state.visible),
    };
  }

  async deliver(id: SessionId, text: string): Promise<void> {
    await this.delivery.deliver(await this.session(id), text);
  }

  async queue(id: SessionId, text: string): Promise<void> {
    await this.queueDelivery.queue(await this.session(id), text);
  }

  /**
   * Ends the active turn and waits for the pane to come back to a prompt.
   *
   * The readiness wait is bounded and its failure is swallowed on purpose: whether the pane settled
   * is answered by READING it afterwards, not by whether a wait returned. A caller that treated a
   * timeout as fatal would refuse a send into a pane that was, by then, perfectly ready.
   */
  async stopActiveTurn(id: SessionId): Promise<SendPaneObservation> {
    const session = await this.session(id);
    await this.tmux.sendKey(session, 'Escape');
    await this.delivery.waitReady(session).catch(() => undefined);
    return await this.observe(id);
  }

  async pressStopKey(id: SessionId): Promise<void> {
    await this.tmux.sendKey(await this.session(id), 'Escape');
  }
}
