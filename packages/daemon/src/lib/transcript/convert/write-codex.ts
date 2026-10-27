import { exitCodeOf, type RenderableEntry, toolLine } from './render.ts';

/**
 * The neutral conversation, written as a Codex rollout its own `resume` accepts.
 *
 * THE SHAPE, as Codex 0.145.0, 0.156.1, 0.163.0 and 0.164.0 read it back (measured by resuming converted
 * rollouts against a loopback model and reading the request each sent): a `session_meta` record
 * naming the thread, its working directory and the CLI version, then `response_item` records — the
 * Responses API items Codex hands back to the model on resume. Each user and agent message also gets
 * the `event_msg` mirror Codex's own screen replays when it reopens a thread, so the person sees the
 * history in the pane as well as the model having it.
 *
 * A shell command crosses as an `exec_command` call with its `function_call_output`, the pair the
 * Responses API requires; `exec_command` is the shell tool every gated version declares.
 */

/** Codex's shell tool, the one native call a conversion writes. */
export const CODEX_SHELL_TOOL = 'exec_command';

export interface CodexWriteRequest {
  readonly entries: readonly RenderableEntry[];
  /** The new thread id, which also names the rollout file. */
  readonly threadId: string;
  readonly cwd: string;
  /** The Codex version that will resume it. */
  readonly version: string;
  /** When the thread was created, and the timestamp an entry without its own takes. */
  readonly at: string;
  /**
   * Extra workspace roots to record, as a launch's `--add-dir` would. Ferretry's correlation root
   * goes here so the rollout carries the session's token from its first record, exactly as a
   * rollout Codex started itself would.
   */
  readonly workspaceRoots: readonly string[];
  /**
   * The model provider the target login runs, recorded on the thread. Codex 0.145's interactive resume
   * restores the thread's provider and refuses one that names none ("Model provider `` not found"),
   * while its `exec resume` does not care — so this is written even though the check cannot see it.
   */
  readonly modelProvider: string;
}

/** The rollout's file name under `sessions/YYYY/MM/DD/`, from its creation time and thread id. */
export function codexRolloutRelativePath(threadId: string, at: string): string {
  const [, year, month, day, hour, minute, second] = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/u.exec(at) ?? [
    '',
    '1970',
    '01',
    '01',
    '00',
    '00',
    '00',
  ];
  return `sessions/${year}/${month}/${day}/rollout-${year}-${month}-${day}T${hour}-${minute}-${second}-${threadId}.jsonl`;
}

export function writeCodexRollout(request: CodexWriteRequest): string {
  const lines: string[] = [];
  let calls = 0;
  let last = request.at;
  const push = (timestamp: string, type: string, payload: Readonly<Record<string, unknown>>): void => {
    lines.push(JSON.stringify({ timestamp, type, payload }));
  };

  push(request.at, 'session_meta', {
    id: request.threadId,
    timestamp: request.at,
    cwd: request.cwd,
    originator: 'codex_cli_rs',
    cli_version: request.version,
    source: 'cli',
    model_provider: request.modelProvider,
    runtime_workspace_roots: [request.cwd, ...request.workspaceRoots],
  });

  let said: string[] = [];
  let saidAt = request.at;
  const flush = (): void => {
    if (said.length === 0) return;
    const text = said.join('\n\n');
    push(saidAt, 'response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    });
    push(saidAt, 'event_msg', { type: 'agent_message', message: text });
    said = [];
  };
  const say = (text: string, at: string): void => {
    if (said.length === 0) saidAt = at;
    said.push(text);
  };

  for (const entry of request.entries) {
    const at = entry.at ?? last;
    last = at;
    if (entry.kind === 'user') {
      flush();
      push(at, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: entry.text }] });
      push(at, 'event_msg', { type: 'user_message', message: entry.text, images: [] });
    } else if (entry.kind === 'assistant') say(entry.text, at);
    else if (entry.kind === 'tool') say(toolLine(entry), at);
    else {
      flush();
      calls += 1;
      const callId = `call_conv_${calls.toString().padStart(4, '0')}`;
      const { code, rest } = exitCodeOf(entry.output);
      const exit = code ?? (entry.failed ? 1 : 0);
      push(at, 'response_item', {
        type: 'function_call',
        name: CODEX_SHELL_TOOL,
        arguments: JSON.stringify({
          cmd: entry.command,
          ...(entry.workdir === undefined ? {} : { workdir: entry.workdir }),
        }),
        call_id: callId,
      });
      push(at, 'response_item', {
        type: 'function_call_output',
        call_id: callId,
        output: `Process exited with code ${exit}\nOutput:\n${rest}`,
      });
    }
  }
  flush();
  return `${lines.join('\n')}\n`;
}
