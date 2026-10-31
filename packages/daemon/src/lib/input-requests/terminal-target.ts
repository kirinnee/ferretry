import type { InputForeground, InputTarget, InputTargetFacts } from '@ferretry/protocol';
import { hexInputChunks, terminalPaneTarget } from '../terminal/runtime-policy.ts';
import type { TmuxCommandPort } from '../tmux/contracts.ts';
import { PANE_PROOF_FORMAT, parsePaneSighting } from '../tmux/pane-proof.ts';
import { digestFacts, digestLine } from './digest.ts';
import type { InputTargetPort, ObserveResult, TypeResult } from './ports.ts';
import { recognisedConsumer } from './recognised.ts';
import type { ProgramRunner, TerminalModes } from './terminal-modes.ts';

/** Finds the tmux session behind a terminal the agent named (`dev`) or an id, in that session's own listing. */
export interface TerminalLocator {
  locate(
    sessionId: string,
    key: string,
  ): Promise<{ readonly tmuxSession: string; readonly id?: string; readonly name?: string } | undefined>;
}

const TTY_PATH = /^\/dev\/[A-Za-z0-9._/-]+$/u;
const CONTROL = /[\p{Cc}\p{Cf}]/gu;
const ROW = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s*(.*)$/u;

const CARRIAGE_RETURN = 0x0d;
/**
 * Text read off the terminal is cut only at this generous bound. The service masks it and THEN cuts it to
 * what may be shown, because cutting first can leave a prefix of a value that no longer matches it.
 */
const RAW_TEXT_LIMIT = 4096;
/** A program name tmux may be asked to compare. Anything else cannot be pinned safely in a format string. */
const PINNABLE_COMMAND = /^[A-Za-z0-9._:+@ -]+$/u;
const GUARD_REFUSED = 'fy-input-guard-refused';

const plain = (text: string, limit: number = RAW_TEXT_LIMIT): string => text.replaceAll(CONTROL, '').slice(0, limit);

/** What tmux can compare in the very command that writes. Echo and the process group are not formats tmux has. */
interface WriteGuard {
  readonly panePid: number;
  readonly command: string;
  readonly cursorRow: number;
}

type Sight =
  | {
      readonly ok: true;
      readonly facts: InputTargetFacts;
      readonly guard: WriteGuard;
      readonly names: readonly string[];
    }
  | { readonly ok: false; readonly reason: 'target_gone' };

interface Described {
  readonly proof: string;
  readonly tty: string;
  readonly cursor: string;
  readonly command: string;
}

/**
 * The foreground process group of a TTY from `ps -o pid=,pgid=,tpgid=,comm=,args=`: the rows whose group is
 * the terminal's foreground group, the group leader first. `undefined` when no process holds the TTY.
 */
export function parseForeground(output: string): InputForeground | undefined {
  const rows = output
    .split('\n')
    .map(line => ROW.exec(line))
    .filter(match => match !== null)
    .map(match => ({
      pid: Number(match[1]),
      pgid: Number(match[2]),
      tpgid: Number(match[3]),
      comm: match[4] ?? '',
      args: match[5] ?? '',
    }))
    .filter(row => row.pid > 0 && row.pgid > 0 && row.pgid === row.tpgid);
  const row = rows.find(candidate => candidate.pid === candidate.pgid) ?? rows[0];
  if (row === undefined) return undefined;
  const comm = plain(row.comm.split('/').pop() ?? '');
  return { pid: row.pid, pgid: row.pgid, comm: comm === '' ? '?' : comm, argv: plain(row.args) };
}

/**
 * LOOKS AT, AND TYPES INTO, A TMUX TERMINAL. Every fact is read from tmux and the kernel; nothing the agent
 * wrote is used. `type` looks at the terminal again, in full, and writes only if every fact (the pane, the
 * foreground program, echo, the prompt line, the cursor) still digests to what the card showed.
 *
 * THE WRITE IS GUARDED, NOT MERELY PRECEDED BY A LOOK. The value goes to tmux as hex bytes in ONE
 * `if-shell -F` whose condition tmux evaluates in its own server, in the same command that runs the
 * `send-keys -H`: the pane's shell pid, the foreground program's name tmux reports, the cursor row and
 * "not dead" must still be what the final look saw, or tmux types nothing. What tmux cannot compare is the
 * foreground process GROUP and the ECHO flag (it has no format for either).
 *
 * THIS IS COMPARE-AND-ENQUEUE. tmux evaluates the condition in its command queue, but `send-keys` only
 * enqueues the bytes into the pane's pty buffer; it does not wait for a program to read them. After the
 * predicate the foreground can become ANY command (not only a same-named one), echo can flip and the
 * prompt can change, and the bytes go to whatever reads the pty next. docs/input-requests.md names this
 * residual risk, and the owner's warning card and the trusted-program gate are the remaining defence.
 * Enter is a trailing carriage return in the same command: there is no second command to fail between the
 * value and Enter, so a write that did not complete cleanly is `uncertain` (the value may be sitting in a
 * hidden buffer) and is never retried.
 */
export class TmuxInputTarget implements InputTargetPort {
  constructor(
    private readonly tmux: TmuxCommandPort,
    private readonly terminals: TerminalLocator,
    private readonly modes: TerminalModes,
    private readonly run: ProgramRunner,
  ) {}

  async observe(sessionId: string, target: InputTarget): Promise<ObserveResult> {
    if (target.kind !== 'terminal') return { ok: false, reason: 'unsupported' };
    const sight = await this.look(sessionId, target.key);
    return sight.ok ? { ok: true, facts: sight.facts, names: sight.names } : sight;
  }

  private async describe(pane: string): Promise<Described | undefined> {
    const described = await this.tmux.execute([
      'display-message',
      '-p',
      '-t',
      pane,
      `${PANE_PROOF_FORMAT}\t#{pane_tty}\t#{cursor_y}\t#{pane_current_command}`,
    ]);
    if (described.code !== 0) return undefined;
    const [proof = '', tty = '', cursor = '', command = ''] = described.stdout.replace(/\r?\n$/u, '').split('\t');
    return { proof, tty, cursor, command };
  }

  /**
   * Looks at the terminal. tmux is asked about the pane first (to learn its TTY) and AGAIN last: the answers
   * must agree, and the last one is what the write is guarded with, so the facts tmux can bind are the
   * freshest observation made.
   */
  private async look(sessionId: string, key: string): Promise<Sight> {
    const located = await this.terminals.locate(sessionId, key);
    if (located === undefined) return { ok: false, reason: 'target_gone' };
    const pane = terminalPaneTarget(located);
    const first = await this.describe(pane);
    if (first === undefined) return { ok: false, reason: 'target_gone' };
    const sighting = parsePaneSighting(first.proof);
    const cursorRow = /^(?:0|[1-9][0-9]*)$/u.test(first.cursor) ? Number(first.cursor) : undefined;
    if (sighting === undefined || sighting.dead || sighting.pid === undefined)
      return { ok: false, reason: 'target_gone' };
    if (!TTY_PATH.test(first.tty) || cursorRow === undefined) return { ok: false, reason: 'target_gone' };
    const listed = await this.run(['ps', '-t', first.tty.slice('/dev/'.length), '-o', 'pid=,pgid=,tpgid=,comm=,args=']);
    const foreground = listed === undefined ? undefined : parseForeground(listed);
    if (foreground === undefined) return { ok: false, reason: 'target_gone' };
    const captured = await this.tmux.execute([
      'capture-pane',
      '-p',
      '-N',
      '-S',
      String(cursorRow),
      '-E',
      String(cursorRow),
      '-t',
      pane,
    ]);
    if (captured.code !== 0) return { ok: false, reason: 'target_gone' };
    const promptLine = plain(captured.stdout.split('\n')[0] ?? '');
    const echo = await this.modes.echo(first.tty);
    const last = await this.describe(pane);
    if (
      last === undefined ||
      last.proof !== first.proof ||
      last.tty !== first.tty ||
      last.cursor !== first.cursor ||
      last.command !== first.command
    )
      return { ok: false, reason: 'target_gone' };
    const facts: InputTargetFacts = {
      kind: 'terminal',
      paneProof: {
        paneId: sighting.paneId,
        pid: sighting.pid,
        ...(sighting.sessionCreated === undefined ? {} : { sessionCreated: sighting.sessionCreated }),
      },
      foreground,
      echo,
      cursorRow,
      promptLine,
      promptLineDigest: digestLine(promptLine),
      recognisedConsumer: recognisedConsumer(foreground.comm),
    };
    return {
      ok: true,
      facts,
      guard: { panePid: sighting.pid, command: last.command, cursorRow },
      names: [...new Set([key, located.name, located.id].filter((name): name is string => name !== undefined))],
    };
  }

  async type(
    sessionId: string,
    target: InputTarget,
    text: string,
    submit: boolean,
    expected: InputTargetFacts,
  ): Promise<TypeResult> {
    if (target.kind !== 'terminal' || expected.kind !== 'terminal') return 'target_gone';
    const fresh = await this.look(sessionId, target.key);
    if (!fresh.ok || fresh.facts.kind !== 'terminal') return 'target_gone';
    if (digestFacts(fresh.facts) !== digestFacts(expected)) return 'target_changed';
    const { guard } = fresh;
    if (!PINNABLE_COMMAND.test(guard.command)) return 'target_changed';
    const paneId = fresh.facts.paneProof.paneId;
    const bytes = new TextEncoder().encode(text);
    const keys = submit ? new Uint8Array([...bytes, CARRIAGE_RETURN]) : bytes;
    const [chunk = []] = hexInputChunks(keys, keys.byteLength);
    const condition = [
      `#{==:#{pane_pid},${guard.panePid}}`,
      `#{==:#{pane_current_command},${guard.command}}`,
      `#{==:#{cursor_y},${guard.cursorRow}}`,
      '#{==:#{pane_dead},0}',
    ].reduce((left, right) => `#{&&:${left},${right}}`);
    try {
      const written = await this.tmux.execute([
        'if-shell',
        '-F',
        '-t',
        paneId,
        condition,
        ['send-keys', '-H', '-t', paneId, ...chunk].join(' '),
        `display-message -p ${GUARD_REFUSED}`,
      ]);
      if (written.code !== 0) return 'uncertain';
      return written.stdout.includes(GUARD_REFUSED) ? 'target_changed' : 'typed';
    } catch {
      return 'uncertain';
    }
  }
}
