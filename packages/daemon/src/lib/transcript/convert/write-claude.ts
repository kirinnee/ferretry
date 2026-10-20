import { derivedUuid, type RenderableEntry, toolLine } from './render.ts';

/**
 * The neutral conversation, written as a Claude Code transcript its own `--resume` accepts.
 *
 * THE SHAPE, as Claude Code 2.1.281 and 2.1.304 read it back (measured by resuming converted files
 * against a loopback model and reading the request they sent): a linear chain of `user` and
 * `assistant` records linked by `parentUuid`, each naming the session, the working directory and the
 * version. An assistant turn is one record whose content holds its text and its `tool_use` blocks; a
 * shell command's result follows as a `user` record holding the `tool_result`, which is what the
 * Messages API requires after every `tool_use`.
 *
 * Text tool activity is folded into the agent's own message, so the history alternates the way the
 * API expects and never claims a tool call this Claude could be asked to account for.
 */

/** Claude's shell tool, the one native call a conversion writes. */
export const CLAUDE_SHELL_TOOL = 'Bash';

export interface ClaudeWriteRequest {
  readonly entries: readonly RenderableEntry[];
  /** The new Claude session id, which is also the file's name. */
  readonly sessionId: string;
  readonly cwd: string;
  /** The Claude Code version that will resume it. */
  readonly version: string;
  /** Who the history says answered, recorded on each assistant message. */
  readonly model: string;
  /** The timestamp an entry without its own takes. */
  readonly at: string;
}

type Block = Readonly<Record<string, unknown>>;

export function writeClaudeTranscript(request: ClaudeWriteRequest): string {
  const lines: string[] = [];
  let parent: string | null = null;
  let index = 0;
  let calls = 0;
  let last = request.at;
  let pending: Block[] = [];
  let pendingAt = request.at;

  const record = (type: 'user' | 'assistant', message: Block, timestamp: string): void => {
    const uuid = derivedUuid(request.sessionId, index);
    index += 1;
    lines.push(
      JSON.stringify({
        parentUuid: parent,
        isSidechain: false,
        type,
        message,
        uuid,
        timestamp,
        userType: 'external',
        cwd: request.cwd,
        sessionId: request.sessionId,
        version: request.version,
      }),
    );
    parent = uuid;
  };

  const flush = (): void => {
    if (pending.length === 0) return;
    const usesTool = pending.some(block => block.type === 'tool_use');
    record(
      'assistant',
      {
        id: `msg_${derivedUuid(request.sessionId, index).replaceAll('-', '')}`,
        type: 'message',
        role: 'assistant',
        model: request.model,
        content: pending,
        stop_reason: usesTool ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      pendingAt,
    );
    pending = [];
  };

  const say = (text: string, at: string): void => {
    if (pending.length === 0) pendingAt = at;
    pending.push({ type: 'text', text });
  };

  for (const entry of request.entries) {
    const at = entry.at ?? last;
    last = at;
    if (entry.kind === 'user') {
      flush();
      record('user', { role: 'user', content: entry.text }, at);
    } else if (entry.kind === 'assistant') say(entry.text, at);
    else if (entry.kind === 'tool') say(toolLine(entry), at);
    else {
      if (pending.length === 0) pendingAt = at;
      calls += 1;
      const id = `toolu_conv_${calls.toString().padStart(4, '0')}`;
      pending.push({
        type: 'tool_use',
        id,
        name: CLAUDE_SHELL_TOOL,
        input: {
          command: entry.command,
          description:
            entry.workdir === undefined
              ? 'Carried over from the earlier harness'
              : `Carried over; ran in ${entry.workdir}`,
        },
      });
      flush();
      record(
        'user',
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: id, content: entry.output, is_error: entry.failed }],
        },
        at,
      );
    }
  }
  flush();
  return `${lines.join('\n')}\n`;
}
