import type { SerialExecutor } from '../../seams/ports.ts';
import type { SessionId } from '../../seams/ferret-id.ts';
import { SendRefused, type SendRepository, type SendTarget, SendUnavailable, TERMINAL_SEND_STATUSES } from './types.ts';

/**
 * What the harness's turn stop did (Ferrets' `HarnessInterrupted`): whether its stop key was pressed — it is not at a
 * pane that shows no work unless the key is harmless there — and whether the pane still showed work afterwards,
 * absent when it could not be read.
 */
export interface TurnStopped {
  readonly pressed: boolean;
  readonly working?: boolean | undefined;
}

export interface SessionInterruptPorts {
  readonly repository: Pick<SendRepository, 'read' | 'transition'>;
  /**
   * Stops the turn with the harness's own stop key, under the harness's own rule for when it may be pressed: Ferrets
   * reads the pane, presses at most once, and reads it again. Throws its refusal, which pressed nothing.
   */
  readonly stopTurn: (id: SessionId) => Promise<TurnStopped>;
  /** Serializes the interrupts of one ferret, so two stops cannot both read the same "before". */
  readonly serial: SerialExecutor;
}

/**
 * STOPS WHATEVER THE AGENT IS DOING, AND HANDS THE TERMINAL BACK (today's `interruptLocked`).
 *
 * The refusals only the session layer can make come FIRST, before the harness is asked to press anything: a session
 * whose last shutdown was never confirmed, one holding a structured question (a stop key at a rendered question
 * answers it with whatever the key lands on), and one with no running turn at all. Whether the key is pressed is the
 * harness's rule and Ferrets' to apply; the state edge is not conditional on it — the stop is what was asked for.
 */
export class SessionInterrupt {
  constructor(private readonly ports: SessionInterruptPorts) {}

  async interrupt(id: SessionId): Promise<SendTarget> {
    return await this.ports.serial.run(id, async () => await this.locked(id));
  }

  private async locked(id: SessionId): Promise<SendTarget> {
    const target = await this.ports.repository.read(id);
    if (target === undefined) throw new SendRefused(`session not found: ${id}`);
    if (target.status === 'kill_failed')
      throw new SendUnavailable(
        `the previous terminal shutdown for ${id} was not confirmed; stop it successfully rather than interrupting it`,
      );
    if (target.pendingQuestion !== undefined)
      throw new SendUnavailable(
        `session ${id} is holding structured question ${target.pendingQuestion.toolUseId}; abandoning a ` +
          'rendered question is not served yet, and a generic interrupt would answer it by accident',
      );
    if (TERMINAL_SEND_STATUSES.has(target.status))
      throw new SendRefused(`session ${id} is ${target.status}; there is no running turn to interrupt`);
    const stopped = await this.ports.stopTurn(id);
    // An interactive pane with no active work goes to `awaiting_user`, not `interrupted`: the human
    // pressed stop and the terminal is theirs again. `interrupted` would also be STICKY — the status
    // an idle session claims forever — so a person who paused their own agent would keep being shown
    // as having interrupted it. A pane that could not be read afterwards proves nothing, so it stays `interrupted`.
    const handedBack = target.mode === 'interactive' && stopped.working === false;
    return await this.ports.repository.transition(id, {
      event: 'control.interrupted',
      status: handedBack ? 'awaiting_user' : 'interrupted',
      health: 'idle',
      promptReady: true,
      ...(handedBack ? {} : { reason: 'interrupted by client' }),
      data: { pressed: stopped.pressed },
    });
  }
}
