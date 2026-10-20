/**
 * The two tool calls a delivery between ferrets leaves in a transcript, read for what they ARE.
 *
 *   * THE RECEIVER READING ITS HAND-OFF. A message that travelled as a file reaches the agent as one
 *     line pointing at that file, and the agent's next move is to open it — a `Read` on Claude, a
 *     `cat`/`sed` on Codex. The message row already shows what the file holds, so a successful read of
 *     it is the delivery's own plumbing; only a FAILED one is something the reader needs to see.
 *   * THE SENDER SENDING. A ferret messages another by running the CLI's `send` (or `reply`) verb in
 *     its shell. Shown as a raw tool call that reads as `Bash · fy send tanna "…"`; read here into who
 *     it went to, what it said, and where it got to, so the transcript can show a "Sent to" card.
 *
 * DEGRADE DIRECTION. Anything not recognised stays an ordinary tool call: a send the parser cannot read
 * is shown as the command that ran, never as a card claiming a recipient or a body it did not see.
 */

import type { ToolCall, TranscriptEntry } from './session-screens.ts';

/** The command a shell-running tool call ran, for Claude's `Bash` and Codex's exec tools. */
export const shellCommandOf = (call: Pick<ToolCall, 'use'>): string | undefined => {
  const { name, input } = call.use;
  const lower = (name ?? '').toLowerCase();
  const object = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : undefined;
  if (object === undefined) return undefined;
  const fields = object as Record<string, unknown>;
  if (lower === 'bash') return typeof fields['command'] === 'string' ? fields['command'] : undefined;
  if (lower === 'exec_command') return typeof fields['cmd'] === 'string' ? fields['cmd'] : undefined;
  if (lower === 'shell' || lower === 'local_shell') {
    const command = fields['command'];
    if (!Array.isArray(command) || !command.every(part => typeof part === 'string')) return undefined;
    // `["bash", "-lc", "<script>"]` is how Codex runs every script; the script is the command.
    const shells = new Set(['bash', 'sh', 'zsh']);
    if (command.length === 3 && shells.has(command[0] as string) && /^-l?c$/u.test(command[1] as string))
      return command[2] as string;
    return command.join(' ');
  }
  return undefined;
};

/** One shell word as written, and whether any of it was a shell expansion this reader cannot run. */
export interface Word {
  readonly text: string;
  readonly expanded: boolean;
}

/** What ends a simple command, outside quotes. */
const OPERATORS = new Set([';', '&', '|', '\n']);

/**
 * `"$(cat <<'EOF' … EOF)"` — the one expansion agents use to send a long message — replaced by its
 * body. The tag may be quoted or bare; the body is taken verbatim, as a quoted heredoc is.
 */
const HEREDOC_SUBSTITUTION = /\$\(cat <<-?\s*(['"]?)(\w+)\1\n([\s\S]*?)\n\2\n?\s*\)/gu;

const expandHeredocs = (script: string): { readonly script: string; readonly bodies: readonly string[] } => {
  const bodies: string[] = [];
  const replaced = script.replace(HEREDOC_SUBSTITUTION, (_all, _quote, _tag, body: string) => {
    bodies.push(body);
    return `\u0000${bodies.length - 1}\u0000`;
  });
  return { script: replaced, bodies };
};

/**
 * The words of the FIRST simple command in `script`, POSIX-quoted. Enough of the shell to read what an
 * agent writes: single and double quotes, backslash escapes, and the heredoc substitution above. Any
 * other `$`/backtick inside a word marks it expanded rather than guessing at its value.
 */
export const simpleCommands = (script: string): readonly (readonly Word[])[] => {
  const { script: source, bodies } = expandHeredocs(script);
  const commands: Word[][] = [[]];
  let text = '';
  let expanded = false;
  let open = false;
  const current = (): Word[] => commands[commands.length - 1] as Word[];
  const end = (): void => {
    if (open) current().push({ text, expanded });
    text = '';
    expanded = false;
    open = false;
  };
  const placeholder = (at: number): number => {
    const close = source.indexOf('\u0000', at + 1);
    text += bodies[Number(source.slice(at + 1, close))] ?? '';
    open = true;
    return close;
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] as string;
    if (character === '\u0000') index = placeholder(index);
    else if (character === "'") {
      const close = source.indexOf("'", index + 1);
      if (close === -1) return [];
      text += source.slice(index + 1, close);
      open = true;
      index = close;
    } else if (character === '"') {
      open = true;
      for (index += 1; index < source.length && source[index] !== '"'; index += 1) {
        const inner = source[index] as string;
        if (inner === '\u0000') index = placeholder(index);
        else if (inner === '\\' && /["\\$`]/u.test(source[index + 1] ?? '')) {
          text += source[index + 1];
          index += 1;
        } else {
          if (inner === '$' || inner === '`') expanded = true;
          text += inner;
        }
      }
      if (index >= source.length) return [];
    } else if (character === '\\') {
      if (source[index + 1] !== '\n') text += source[index + 1] ?? '';
      if (source[index + 1] !== '\n') open = true;
      index += 1;
    } else if (character === ' ' || character === '\t') end();
    else if (OPERATORS.has(character)) {
      end();
      commands.push([]);
    } else {
      if (character === '$' || character === '`') expanded = true;
      text += character;
      open = true;
    }
  }
  end();
  return commands.filter(command => command.length > 0);
};

/** Where a ferret's message to another got to, as the sending side can tell. */
export type SentState = 'sending' | 'delivered' | 'queued' | 'failed' | 'replied';

/** A ferret's `send` as the transcript shows it. */
export interface SentMessage {
  /** The ferret it was addressed to: a name or a session id, as typed. */
  readonly to: string;
  /** What it said; `null` when it came from a file or a shell expansion this reader did not run. */
  readonly body: string | null;
  /** The file the message was read from, when it was. */
  readonly messageFile?: string;
  /** The sender parked on an answer (`--ask`). */
  readonly ask: boolean;
  readonly state: SentState;
  /** Why it failed, in the CLI's own words. */
  readonly reason?: string;
}

/** The `send` options that take a value, so the value is not read as the message. */
const VALUE_FLAGS = new Set(['-f', '--file', '--message-file', '--until']);

/** How Codex's exec tool says a command failed. */
const CODEX_EXIT = /Process exited with code (\d+)/u;

const failureReason = (text: string): string => {
  const output = text.split(/\nOutput:\n/u).at(-1) ?? text;
  const line =
    output
      .split('\n')
      .map(part => part.trim())
      .find(part => part !== '') ?? '';
  return line.replace(/^error:\s*/iu, '');
};

const stateOf = (call: Pick<ToolCall, 'result'>): Pick<SentMessage, 'state' | 'reason'> => {
  const result = call.result;
  if (result === undefined) return { state: 'sending' };
  const text = result.text ?? '';
  const exit = CODEX_EXIT.exec(text)?.[1];
  if (result.isError === true || (exit !== undefined && exit !== '0'))
    return { state: 'failed', reason: failureReason(text) };
  // `describeDisposition`'s words: everything but a plain delivery is held somewhere first.
  if (/^\s*(?:delivered|revived the session)\b/mu.test(text)) return { state: 'delivered' };
  return { state: 'queued' };
};

/** The binary's own name, or a path ending in it. */
const isClient = (word: string, clientName: string): boolean => word === clientName || word.endsWith(`/${clientName}`);

/**
 * Where the client starts in one simple command, or -1 when the command is not the client's. Only
 * `direnv exec <dir> fy …` may stand in front of it, so a command that merely mentions it is not one.
 */
export const clientAt = (words: readonly Word[], clientName: string): number => {
  const start = words.findIndex(word => isClient(word.text, clientName));
  const launcher = words.slice(0, start).map(word => word.text);
  const launched = start === 0 || (start === 3 && launcher[0] === 'direnv' && launcher[1] === 'exec');
  return start !== -1 && launched ? start : -1;
};

/**
 * The `send` a tool call ran, or `null` when it is any other call.
 *
 * Only a command that IS a send counts: `<client> send <ferret> …` or `<client> reply <ferret> …`,
 * possibly behind `cd …&&` or `direnv exec . `. A command that merely mentions one (`echo "fy send"`)
 * is not one, because its first word is not the client.
 */
export const readSentMessage = (call: Pick<ToolCall, 'use' | 'result'>, clientName: string): SentMessage | null => {
  const script = shellCommandOf(call);
  if (script === undefined || !script.includes(clientName)) return null;
  for (const words of simpleCommands(script)) {
    const start = clientAt(words, clientName);
    if (start === -1) continue;
    const verb = words[start + 1]?.text;
    const to = words[start + 2];
    if ((verb !== 'send' && verb !== 'reply') || to === undefined || to.expanded || to.text.startsWith('-')) continue;
    const parts: string[] = [];
    let expanded = false;
    let ask = false;
    let messageFile: string | undefined;
    const rest = words.slice(start + 3);
    for (let index = 0; index < rest.length; index += 1) {
      const word = rest[index] as Word;
      if (VALUE_FLAGS.has(word.text)) {
        if (word.text === '--message-file') messageFile = rest[index + 1]?.text;
        index += 1;
      } else if (word.text === '--ask') ask = true;
      else if (word.text.startsWith('--')) continue;
      else {
        parts.push(word.text);
        expanded ||= word.expanded;
      }
    }
    const typed = parts.join(' ').trim();
    return {
      to: to.text,
      body: expanded || (typed === '' && messageFile !== undefined) ? null : typed,
      ...(messageFile === undefined ? {} : { messageFile }),
      ask,
      ...stateOf(call),
    };
  }
  return null;
};

/** A command that only reads one file: `cat`, `sed -n`, `head`, `tail`, `nl`. */
const READERS = new Set(['cat', 'sed', 'head', 'tail', 'nl', 'less', 'more', 'bat']);

/**
 * Whether this call is the agent opening the hand-off document at `path` — the delivery's own read.
 *
 * Claude's `Read` names the file; Codex runs a one-command read of it. A command that does anything
 * else (a pipe, a second command, a redirect) is the agent's own work and is not hidden.
 */
export const isHandoffRead = (call: Pick<ToolCall, 'use'>, path: string): boolean => {
  const { name, input } = call.use;
  if ((name ?? '').toLowerCase() === 'read') {
    const fields = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    return fields['file_path'] === path || fields['path'] === path;
  }
  const script = shellCommandOf(call);
  if (script === undefined || /[|;&<>]/u.test(script)) return false;
  const commands = simpleCommands(script);
  const words = commands[0];
  if (commands.length !== 1 || words === undefined) return false;
  return READERS.has(words[0]?.text ?? '') && words.at(-1)?.text === path;
};

/** The calls of one tool row, without the hand-off read at `path` unless that read failed. */
const withoutHandoffRead = (calls: readonly ToolCall[], path: string): readonly ToolCall[] =>
  calls.filter(call => !(isHandoffRead(call, path) && call.result?.isError !== true));

/**
 * The transcript with each delivery read for what it is: the receiver's successful read of its own
 * hand-off taken out, and every `send` a ferret ran lifted out of its tool group into a row of its own
 * (`sent`), between the calls that ran before and after it.
 *
 * A hand-off's read is looked for only between that hand-off and the next message on the user channel,
 * and only once — a second read of the same file is the agent's own business. Rows keep their ids: the
 * first piece of a split group keeps the group's, so a re-render never remounts what did not move.
 */
export const projectDeliveries = (
  entries: readonly TranscriptEntry[],
  clientName: string,
): readonly TranscriptEntry[] => {
  const out: TranscriptEntry[] = [];
  let handoffPath: string | undefined;
  for (const entry of entries) {
    if (entry.kind === 'user') handoffPath = entry.handoff?.path;
    if (entry.kind !== 'tool' || entry.tools === undefined) {
      out.push(entry);
      continue;
    }
    let calls = entry.tools;
    if (handoffPath !== undefined) {
      const kept = withoutHandoffRead(calls, handoffPath);
      if (kept.length !== calls.length) handoffPath = undefined;
      calls = kept;
    }
    let run: ToolCall[] = [];
    let first = true;
    const flush = (): void => {
      if (run.length === 0) return;
      const id = first ? entry.id : `${entry.id}:${(run[0] as ToolCall).key}`;
      out.push({ ...entry, id, text: run.length === 1 ? 'ran a tool' : `ran ${run.length} tools`, tools: run });
      first = false;
      run = [];
    };
    for (const call of calls) {
      const sent = readSentMessage(call, clientName);
      if (sent === null) {
        run.push(call);
        continue;
      }
      flush();
      const at = call.ts === undefined ? Number.NaN : Date.parse(call.ts);
      out.push({
        id: `sent:${call.key}`,
        kind: 'tool',
        text: `sent to ${sent.to}`,
        tools: [call],
        sent,
        ...(Number.isFinite(at) ? { at } : {}),
      });
    }
    flush();
  }
  return out;
};

/** Who a user-channel row came from, by every name it can be addressed by. */
const sendersOf = (entry: TranscriptEntry): readonly string[] =>
  [entry.peer?.name, entry.peer?.sessionId, entry.send?.fromName, entry.send?.from].filter(
    (name): name is string => name !== undefined,
  );

/**
 * A sent message the recipient has since answered reads `replied` — the one proof a sender's own
 * transcript holds that the message was READ, not merely delivered.
 *
 * Run after the ledger has chipped each row (`placeLedgerRows`), because a peer message that travelled
 * as a file names its sender only through its delivered send.
 */
export const markReplies = (entries: readonly TranscriptEntry[]): readonly TranscriptEntry[] => {
  const later = new Set<string>();
  const marked: TranscriptEntry[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as TranscriptEntry;
    if (entry.kind === 'user') for (const name of sendersOf(entry)) later.add(name);
    const sent = entry.sent;
    const answered = sent !== undefined && sent.state !== 'failed' && later.has(sent.to);
    marked.push(answered ? { ...entry, sent: { ...sent, state: 'replied' } } : entry);
  }
  return marked.reverse();
};
