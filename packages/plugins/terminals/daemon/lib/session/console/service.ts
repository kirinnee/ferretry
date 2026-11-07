import type { SessionAttachTarget } from '@ferretry/protocol';
import { hexInputChunks } from '../../terminal/runtime-policy.ts';
import type { TmuxCommandPort } from '../../tmux/contracts.ts';

/**
 * TYPING INTO A SESSION'S OWN PANE — the agent's Claude / Codex CLI, which the session page calls its
 * Console.
 *
 * WHICH PANE IS THE WHOLE QUESTION. A session name re-resolves to whatever pane is active when tmux
 * runs the command, and a name is exactly what a reused or replaced session would answer to. So the
 * pane is the one the attach proof names: the session's single durable registration, freshly matched
 * on pane id, pid and process-start incarnation (`SessionAttachService`). Missing or contradictory
 * evidence refuses the write; it never falls back to a name.
 *
 * WHAT IS WRITTEN IS EXACTLY WHAT WAS SENT. The bytes go through `send-keys -H` as hex, the same way a
 * session terminal's keystrokes do, so tmux interprets nothing — no key names, no `;` separators —
 * and a write is byte-for-byte what the reader's keyboard produced.
 */
export interface SessionPaneProof {
  resolve(sessionId: string): Promise<SessionAttachTarget>;
}

/** Why the write itself failed after the pane was proved — it died, or tmux refused the keys. */
export class SessionConsoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionConsoleError';
  }
}

export class SessionConsoleService {
  constructor(
    private readonly panes: SessionPaneProof,
    private readonly tmux: Pick<TmuxCommandPort, 'execute'>,
  ) {}

  /** Writes `bytes` to the session's proved pane and answers how many were written. */
  async write(sessionId: string, bytes: Uint8Array): Promise<number> {
    const target = await this.panes.resolve(sessionId);
    for (const chunk of hexInputChunks(bytes)) {
      const result = await this.tmux.execute(['send-keys', '-H', '-t', target.paneId, ...chunk]);
      if (result.code !== 0)
        throw new SessionConsoleError(
          `session ${sessionId}'s pane did not take the input: ${result.stderr.trim() || `tmux exited ${result.code}`}`,
        );
    }
    return bytes.byteLength;
  }
}
