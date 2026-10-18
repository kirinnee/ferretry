import type { PermissionAnswerRequest, PermissionAnswerResult, PermissionRequest } from '@ferretry/protocol';
import type { TmuxCommandPort } from '../../tmux/contracts.ts';
import { parsePermissionPrompt, permissionAnswerKeys } from '../../tmux/permission-prompt.ts';
import type { SessionPaneProof } from '../console/service.ts';

/**
 * ANSWERING A HARNESS PERMISSION PROMPT FOR A PERSON WHO IS NOT AT THE TERMINAL.
 *
 * A person saw one prompt — `requestId` names it — and picked a choice. Three things make that safe:
 *
 *   1. THE PROMPT IS RE-READ FIRST. The pane is captured and parsed again right before the key goes in;
 *      if it no longer shows that very request (answered at the terminal, replaced by the next one,
 *      gone with the turn), nothing is typed and the caller is told the prompt is gone. A key meant for
 *      one prompt never lands on another.
 *   2. ONE KEY, THE HARNESS'S OWN. A digit picks a row and Escape refuses — see
 *      {@link permissionAnswerKeys} for why no Enter follows the digit.
 *   3. THE PANE SAYS WHETHER IT WORKED. After the key the pane is read until the prompt is gone, and
 *      the answer reports what it saw. A prompt still up is reported, never answered twice.
 *
 * Answers to one session are taken one at a time, so two devices answering at once cannot both pass
 * the re-read before either key lands. This never answers anything by itself: every key here is a
 * person's choice, carried by a governed route.
 */

/** The live frame and the keyboard of a session's own pane, as the attach proof names it. */
export interface SessionPermissionPane {
  /** The visible frame, as text. */
  capture(sessionId: string): Promise<string>;
  /** Writes exactly these bytes; answers how many were written. */
  write(sessionId: string, bytes: Uint8Array): Promise<number>;
}

/** Why an answer was refused before any key was sent. */
export type PermissionAnswerRefusal = 'gone' | 'invalid_choice';

export class PermissionAnswerError extends Error {
  constructor(
    readonly refusal: PermissionAnswerRefusal,
    message: string,
    /** What the pane shows instead, when it shows a prompt at all. */
    readonly current?: PermissionRequest | undefined,
  ) {
    super(message);
    this.name = 'PermissionAnswerError';
  }
}

export interface PermissionAnswerTiming {
  /** How many times the pane is re-read after the key before the prompt is called still up. */
  readonly settleReads: number;
  readonly settleMs: number;
}

const DEFAULT_TIMING: PermissionAnswerTiming = { settleReads: 15, settleMs: 200 };

export class SessionPermissionService {
  private readonly queue = new Map<string, Promise<unknown>>();

  constructor(
    private readonly pane: SessionPermissionPane,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly timing: PermissionAnswerTiming = DEFAULT_TIMING,
  ) {}

  /** Answers the prompt `answer.requestId` names, if — and only if — the pane still shows it. */
  async answer(sessionId: string, answer: PermissionAnswerRequest): Promise<PermissionAnswerResult> {
    const before = this.queue.get(sessionId) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(async () => await this.answerNow(sessionId, answer));
    const settled = run.catch(() => undefined);
    this.queue.set(sessionId, settled);
    try {
      return await run;
    } finally {
      if (this.queue.get(sessionId) === settled) this.queue.delete(sessionId);
    }
  }

  private async answerNow(sessionId: string, answer: PermissionAnswerRequest): Promise<PermissionAnswerResult> {
    const shown = parsePermissionPrompt(await this.pane.capture(sessionId));
    if (shown?.id !== answer.requestId)
      throw new PermissionAnswerError(
        'gone',
        'this prompt is gone: the agent’s screen no longer shows it, so nothing was sent',
        shown,
      );
    const keys = permissionAnswerKeys(shown, answer);
    if (keys === undefined)
      throw new PermissionAnswerError(
        'invalid_choice',
        `the prompt has no choice ${answer.kind === 'choice' ? answer.number : ''}`.trim(),
        shown,
      );
    await this.pane.write(sessionId, new TextEncoder().encode(keys));
    for (let read = 0; read < this.timing.settleReads; read += 1) {
      await this.sleep(this.timing.settleMs);
      const after = parsePermissionPrompt(await this.pane.capture(sessionId).catch(() => ''));
      if (after?.id !== answer.requestId) return { requestId: answer.requestId, cleared: true };
    }
    return { requestId: answer.requestId, cleared: false };
  }
}

/**
 * The visible frame of a session's PROVED pane — the one its attach proof names, never whatever pane a
 * session name resolves to at the moment of the read.
 */
export class ProvedPaneCapture {
  constructor(
    private readonly panes: SessionPaneProof,
    private readonly tmux: Pick<TmuxCommandPort, 'execute'>,
  ) {}

  async capture(sessionId: string): Promise<string> {
    const target = await this.panes.resolve(sessionId);
    const result = await this.tmux.execute(['capture-pane', '-p', '-t', target.paneId]);
    if (result.code !== 0)
      throw new Error(
        `session ${sessionId}'s pane could not be read: ${result.stderr.trim() || `tmux exited ${result.code}`}`,
      );
    return result.stdout;
  }
}
