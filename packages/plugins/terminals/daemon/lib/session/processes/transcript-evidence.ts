import type { SessionProcessExit } from '@ferretry/protocol';
import type { TranscriptEvent, TranscriptJsonValue } from '../../transcript/types.ts';

/**
 * WHAT THE HARNESS ITSELF RECORDED ABOUT ITS TOOL COMMANDS, read off the conversation. Pure.
 *
 * The operating system can say a process is running and where its output goes; only the transcript
 * says which commands the agent did not wait for, how one ended, and — for a foreground command whose
 * output file Claude Code deletes on return — what it printed.
 */
export interface CommandResult {
  /** The command as the agent wrote it (the tool call's own input). */
  readonly command: string;
  readonly text: string;
  readonly exit: SessionProcessExit;
  /** When the result was recorded, where the transcript says. */
  readonly atMs?: number;
}

export interface TranscriptEvidence {
  /** Claude Code task ids of commands started with `run_in_background`. */
  readonly backgroundTaskIds: ReadonlySet<string>;
  /** How a background task ended, from Claude Code's `<task-notification>`. */
  readonly taskExits: ReadonlyMap<string, SessionProcessExit>;
  /** Every finished shell tool call, oldest first. */
  readonly commandResults: readonly CommandResult[];
}

export const NO_TRANSCRIPT_EVIDENCE: TranscriptEvidence = {
  backgroundTaskIds: new Set(),
  taskExits: new Map(),
  commandResults: [],
};

const SHELL_TOOLS = new Set(['Bash', 'exec_command', 'shell', 'local_shell', 'container.exec']);
const BACKGROUND_STARTED = /Command running in background with ID: ([A-Za-z0-9_-]{1,64})/gu;
const TASK_NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/gu;

function textOf(value: TranscriptJsonValue | undefined): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value
      .map(item =>
        item !== null && typeof item === 'object' && !Array.isArray(item) && typeof item.text === 'string'
          ? item.text
          : '',
      )
      .join('');
  return '';
}

/** The command a shell tool call asked for, whichever harness's spelling it uses. */
function commandOf(input: TranscriptJsonValue): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as { readonly [key: string]: TranscriptJsonValue };
  const candidate = record.command ?? record.cmd;
  if (typeof candidate === 'string') return candidate.trim() || undefined;
  if (Array.isArray(candidate)) {
    const words = candidate.filter((word): word is string => typeof word === 'string');
    // Codex's `["bash", "-lc", "<command>"]`: the command is the script, not the shell.
    if (words.length === 3 && /^-[a-z]*c$/u.test(words[1] ?? '')) return words[2]?.trim() || undefined;
    return words.join(' ').trim() || undefined;
  }
  return undefined;
}

function exitOf(text: string, isError: boolean): SessionProcessExit {
  const stated = /(?:^|\n)\s*Exit code:? (-?\d+)/u.exec(text)?.[1];
  const code = stated === undefined ? (isError ? undefined : 0) : Number(stated);
  return { ...(code === undefined ? {} : { code }), failed: isError || (code !== undefined && code !== 0) };
}

function instant(timestamp: string | undefined): number | undefined {
  if (timestamp === undefined) return undefined;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : undefined;
}

function notificationsIn(text: string, exits: Map<string, SessionProcessExit>): void {
  for (const match of text.matchAll(TASK_NOTIFICATION)) {
    const body = match[1] ?? '';
    const taskId = /<task-id>([A-Za-z0-9_-]{1,64})<\/task-id>/u.exec(body)?.[1];
    if (taskId === undefined) continue;
    const status = /<status>([a-z_]+)<\/status>/u.exec(body)?.[1];
    const stated = /\(exit code (-?\d+)\)/u.exec(body)?.[1];
    const code = stated === undefined ? undefined : Number(stated);
    exits.set(taskId, {
      ...(code === undefined ? {} : { code }),
      failed: status !== 'completed' || (code !== undefined && code !== 0),
    });
  }
}

export function transcriptEvidence(events: readonly TranscriptEvent[]): TranscriptEvidence {
  const calls = new Map<string, string>();
  const backgroundTaskIds = new Set<string>();
  const taskExits = new Map<string, SessionProcessExit>();
  const commandResults: CommandResult[] = [];
  for (const event of events) {
    if (event.kind === 'tool-call') {
      if (!SHELL_TOOLS.has(event.call.name)) continue;
      const command = commandOf(event.call.input);
      if (command !== undefined) calls.set(event.call.id, command);
    } else if (event.kind === 'tool-result') {
      const text = event.result.text ?? textOf(event.result.content);
      notificationsIn(text, taskExits);
      const command = calls.get(event.result.callId);
      if (command === undefined) continue;
      const started = [...text.matchAll(BACKGROUND_STARTED)].map(match => match[1] as string);
      if (started.length > 0) {
        for (const id of started) backgroundTaskIds.add(id);
        continue;
      }
      const atMs = instant(event.timestamp);
      commandResults.push({
        command,
        text,
        exit: exitOf(text, event.result.isError),
        ...(atMs === undefined ? {} : { atMs }),
      });
    } else if (event.kind === 'message') {
      notificationsIn(event.text, taskExits);
    }
  }
  return { backgroundTaskIds, taskExits, commandResults };
}

/**
 * The recorded result of the command a process ran: the latest result for that exact command recorded
 * after the process started. A result without a timestamp is accepted only when nothing better exists.
 */
export function resultFor(
  evidence: TranscriptEvidence,
  label: string | undefined,
  startedAtMs: number,
): CommandResult | undefined {
  if (label === undefined) return undefined;
  const candidates = evidence.commandResults.filter(result => result.command === label);
  const timed = candidates.filter(result => result.atMs !== undefined && result.atMs >= startedAtMs - 1_000);
  return timed.at(-1) ?? candidates.filter(result => result.atMs === undefined).at(-1);
}
