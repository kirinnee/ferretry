import type { InputForeground, InputTarget, InputTargetFacts } from '@ferretry/protocol';
import { hexInputChunks, terminalPaneTarget } from '../terminal/runtime-policy.ts';
import type { TmuxCommandPort } from '../tmux/contracts.ts';
import { PANE_PROOF_FORMAT, parsePaneSighting, provePane } from '../tmux/pane-proof.ts';
import { digestLine } from './digest.ts';
import type { InputTargetPort, ObserveResult, TypeResult } from './ports.ts';
import { recognisedConsumer } from './recognised.ts';
import type { ProgramRunner, TerminalModes } from './terminal-modes.ts';

/** Finds the tmux session behind a terminal the agent named (`dev`) or an id, in that session's own listing. */
export interface TerminalLocator {
  locate(sessionId: string, key: string): Promise<{ readonly tmuxSession: string } | undefined>;
}

const TTY_PATH = /^\/dev\/[A-Za-z0-9._/-]+$/u;
const CONTROL = /[\p{Cc}\p{Cf}]/gu;
const ROW = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s*(.*)$/u;

const plain = (text: string, limit: number): string => text.replaceAll(CONTROL, '').slice(0, limit);

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
  const comm = plain(row.comm.split('/').pop() ?? '', 64);
  return { pid: row.pid, pgid: row.pgid, comm: comm === '' ? '?' : comm, argv: plain(row.args, 200) };
}

/**
 * LOOKS AT, AND TYPES INTO, A TMUX TERMINAL. Every fact is read from tmux and the kernel; nothing the agent
 * wrote is used. `type` writes only into the pane the card showed: its fresh proof must match, or nothing is
 * written. The value goes to tmux as hex bytes in one `send-keys -H`, never as typed text.
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
    const located = await this.terminals.locate(sessionId, target.key);
    if (located === undefined) return { ok: false, reason: 'target_gone' };
    const pane = terminalPaneTarget(located);
    const described = await this.tmux.execute([
      'display-message',
      '-p',
      '-t',
      pane,
      `${PANE_PROOF_FORMAT}\t#{pane_tty}\t#{cursor_y}`,
    ]);
    if (described.code !== 0) return { ok: false, reason: 'target_gone' };
    const [proof = '', tty = '', cursor = ''] = described.stdout.trimEnd().split('\t');
    const sighting = parsePaneSighting(proof);
    const cursorRow = /^(?:0|[1-9][0-9]*)$/u.test(cursor) ? Number(cursor) : undefined;
    if (sighting === undefined || sighting.dead || sighting.pid === undefined)
      return { ok: false, reason: 'target_gone' };
    if (!TTY_PATH.test(tty) || cursorRow === undefined) return { ok: false, reason: 'target_gone' };
    const listed = await this.run(['ps', '-t', tty.slice('/dev/'.length), '-o', 'pid=,pgid=,tpgid=,comm=,args=']);
    const foreground = listed === undefined ? undefined : parseForeground(listed);
    if (foreground === undefined) return { ok: false, reason: 'target_gone' };
    const captured = await this.tmux.execute([
      'capture-pane',
      '-p',
      '-S',
      String(cursorRow),
      '-E',
      String(cursorRow),
      '-t',
      pane,
    ]);
    if (captured.code !== 0) return { ok: false, reason: 'target_gone' };
    const promptLine = plain((captured.stdout.split('\n')[0] ?? '').trimEnd(), 200);
    const facts: InputTargetFacts = {
      kind: 'terminal',
      paneProof: {
        paneId: sighting.paneId,
        pid: sighting.pid,
        ...(sighting.sessionCreated === undefined ? {} : { sessionCreated: sighting.sessionCreated }),
      },
      foreground,
      echo: await this.modes.echo(tty),
      cursorRow,
      promptLine,
      promptLineDigest: digestLine(promptLine),
      recognisedConsumer: recognisedConsumer(foreground.comm),
    };
    return { ok: true, facts };
  }

  async type(
    sessionId: string,
    target: InputTarget,
    text: string,
    submit: boolean,
    expected: InputTargetFacts,
  ): Promise<TypeResult> {
    if (target.kind !== 'terminal' || expected.kind !== 'terminal') return 'target_gone';
    const located = await this.terminals.locate(sessionId, target.key);
    if (located === undefined) return 'target_gone';
    const pane = terminalPaneTarget(located);
    const seen = await this.tmux.execute(['display-message', '-p', '-t', pane, PANE_PROOF_FORMAT]);
    const sighting = seen.code === 0 ? parsePaneSighting(seen.stdout) : undefined;
    if (sighting === undefined || sighting.dead || provePane(sighting, expected.paneProof) !== 'proven') {
      return 'target_gone';
    }
    const bytes = new TextEncoder().encode(text);
    for (const chunk of hexInputChunks(bytes, Math.max(1, bytes.byteLength))) {
      const written = await this.tmux.execute(['send-keys', '-H', '-t', pane, ...chunk]);
      if (written.code !== 0) return 'target_gone';
    }
    if (submit) {
      const entered = await this.tmux.execute(['send-keys', '-t', pane, 'Enter']);
      if (entered.code !== 0) return 'target_gone';
    }
    return 'typed';
  }
}
