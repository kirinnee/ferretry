import type { InputForeground, InputTarget, InputTargetFacts } from '@ferretry/protocol';
import { hexInputChunks, terminalPaneTarget } from '../terminal/runtime-policy.ts';
import type { TmuxCommandPort } from '../tmux/contracts.ts';
import { PANE_PROOF_FORMAT, parsePaneSighting } from '../tmux/pane-proof.ts';
import { digestFacts, digestLine } from './digest.ts';
import type {
  CodeProgramPort,
  ObserveResult,
  ProfileProgram,
  ProgramProofPort,
  ProvenProgram,
  TerminalInputTargetPort,
  TypeOptions,
  TypeResult,
} from './ports.ts';
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
/** VKILL in line mode: erases a line typed without Enter, so a reader that changed is not handed it on a later Enter. */
const KILL_LINE = 0x15;

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
      readonly codeProgram?: boolean;
      readonly profileProgram?: ProfileProgram;
    }
  | { readonly ok: false; readonly reason: 'target_gone' };

interface ProvedGroup {
  readonly program: string;
  readonly recognised: boolean;
  readonly setuidRoot: boolean;
}

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
 * Every process of the TTY's foreground process group, from the same `ps` listing as {@link parseForeground}: each
 * one can read what is typed, so a code program is proved only when every one of them is one.
 */
export function foregroundPids(output: string): readonly number[] {
  return output
    .split('\n')
    .map(line => ROW.exec(line))
    .filter(match => match !== null)
    .map(match => ({ pid: Number(match[1]), pgid: Number(match[2]), tpgid: Number(match[3]) }))
    .filter(row => row.pid > 0 && row.pgid > 0 && row.pgid === row.tpgid)
    .map(row => row.pid);
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
export class TmuxInputTarget implements TerminalInputTargetPort {
  constructor(
    private readonly tmux: TmuxCommandPort,
    private readonly terminals: TerminalLocator,
    private readonly modes: TerminalModes,
    private readonly run: ProgramRunner,
    /** Whether the foreground runs a code program this account cannot replace; absent: none ever does. */
    private readonly programs?: CodeProgramPort,
    /** What the kernel proves about who can read the TTY; absent: nothing is proved, so every card is unverified. */
    private readonly proofs?: ProgramProofPort,
  ) {}

  /**
   * The terminal's screen and the 50 rows above it, wrapped rows joined, for the DAEMON's own yes-or-no look for a
   * just-typed value after a sign-in. Never published. `undefined` when it cannot be had.
   */
  async screen(sessionId: string, key: string, surfaces: readonly string[]): Promise<string | undefined> {
    const located = await this.terminals.locate(sessionId, key);
    // A terminal opened again under the same name is another terminal: nothing is said about it.
    if (located?.id === undefined || !surfaces.includes(located.id)) return undefined;
    const captured = await this.tmux.execute([
      'capture-pane',
      '-p',
      '-J',
      '-N',
      '-S',
      '-50',
      '-t',
      terminalPaneTarget(located),
    ]);
    return captured.code === 0 ? captured.stdout : undefined;
  }

  /**
   * The line at the terminal's cursor now, read as a card's prompt line is, for the DAEMON's own look at whether a code
   * it typed went through (the same prompt again, or not). Never published. `undefined` when it cannot be had.
   */
  async promptLine(sessionId: string, key: string, surfaces: readonly string[]): Promise<string | undefined> {
    const located = await this.terminals.locate(sessionId, key);
    if (located?.id === undefined || !surfaces.includes(located.id)) return undefined;
    const pane = terminalPaneTarget(located);
    const described = await this.describe(pane);
    const cursor = described?.cursor;
    if (cursor === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(cursor)) return undefined;
    const captured = await this.tmux.execute(['capture-pane', '-p', '-N', '-S', cursor, '-E', cursor, '-t', pane]);
    return captured.code === 0 ? plain(captured.stdout.split('\n')[0] ?? '') : undefined;
  }

  async observe(sessionId: string, target: InputTarget): Promise<ObserveResult> {
    if (target.kind !== 'terminal') return { ok: false, reason: 'unsupported' };
    const sight = await this.look(sessionId, target.key);
    return sight.ok
      ? {
          ok: true,
          facts: sight.facts,
          names: sight.names,
          ...(sight.codeProgram ? { codeProgram: true as const } : {}),
          ...(sight.profileProgram === undefined ? {} : { profileProgram: sight.profileProgram }),
        }
      : sight;
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
    const canonical = await this.modes.canonical?.(first.tty);
    // EVERY process of the foreground group can read the TTY (an ssh LocalCommand or ProxyCommand child, a pipeline
    // led by sudo, a shell that renamed itself), and so can a process of another session that opened it by its path.
    // So each member must be proved, and no stranger may hold it, or nothing is: the card is unverified.
    const members = listed === undefined ? [] : foregroundPids(listed);
    const alone = (await this.proofs?.heldElsewhere(first.tty).catch(() => undefined)) === false;
    const group = alone ? await this.proveGroup(foreground.pid, members) : undefined;
    const profile = alone && group === undefined ? await this.proveProfileGroup(foreground.pid, members) : undefined;
    const programs = this.programs;
    const codeProgram =
      alone &&
      programs !== undefined &&
      members.length > 0 &&
      (await Promise.all(members.map(async pid => await programs.codeProgram(pid).catch(() => false)))).every(Boolean);
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
      ...(group === undefined ? {} : { program: group.program }),
      recognisedConsumer: group?.recognised === true,
      ...(canonical === undefined ? {} : { canonical }),
      ...(group?.setuidRoot === true ? { trustedProgram: true as const } : {}),
    };
    return {
      ok: true,
      facts,
      guard: { panePid: sighting.pid, command: last.command, cursorRow },
      codeProgram,
      ...(profile === undefined ? {} : { profileProgram: profile }),
      names: [...new Set([key, located.name, located.id].filter((name): name is string => name !== undefined))],
    };
  }

  /**
   * The foreground group, proved member by member: the ONE program every member is proved to run, whether it asks for
   * a secret, and whether every member runs setuid root. `undefined` when any member is unproved, or two members run
   * different programs (sudo leading a proved `sh` still hands the terminal to a shell).
   */
  private async proveGroup(leader: number, members: readonly number[]): Promise<ProvedGroup | undefined> {
    const proofs = this.proofs;
    if (proofs === undefined || !members.includes(leader)) return undefined;
    const proved = await Promise.all(
      members.map(async pid => ({ pid, proven: await proofs.prove(pid).catch(() => undefined) })),
    );
    const named = proved.flatMap(({ pid, proven }) => (proven === undefined ? [] : [{ pid, proven }]));
    const head = named.find(member => member.pid === leader);
    if (named.length !== members.length || head === undefined) return undefined;
    const all = (test: (proven: ProvenProgram) => boolean): boolean => named.every(member => test(member.proven));
    if (!all(proven => proven.name === head.proven.name)) return undefined;
    const program = plain(head.proven.name, 64);
    if (program === '') return undefined;
    return {
      program,
      recognised: recognisedConsumer(program),
      setuidRoot: all(proven => proven.setuidRoot),
    };
  }

  /**
   * The foreground group proved with the owner's own profile allowed: every member proved, by a root folder or setuid
   * as above or through the profile, all running ONE program, at least one of them only through the profile.
   * `undefined` otherwise. Asked only when {@link proveGroup} proved nothing.
   */
  private async proveProfileGroup(leader: number, members: readonly number[]): Promise<ProfileProgram | undefined> {
    const proofs = this.proofs;
    if (proofs?.proveProfile === undefined || !members.includes(leader)) return undefined;
    const proveProfile = proofs.proveProfile.bind(proofs);
    const proved = await Promise.all(
      members.map(async pid => {
        const rooted = await proofs.prove(pid).catch(() => undefined);
        if (rooted !== undefined) return { name: rooted.name, path: undefined };
        const profiled = await proveProfile(pid).catch(() => undefined);
        return profiled === undefined ? undefined : { name: profiled.name, path: profiled.path };
      }),
    );
    const first = proved[0];
    if (first === undefined || proved.some(member => member === undefined || member.name !== first.name))
      return undefined;
    const path = proved.find(member => member?.path !== undefined)?.path;
    const name = plain(first.name, 64);
    return path === undefined || name === '' ? undefined : { name, path: plain(path, 512) };
  }

  async type(
    sessionId: string,
    target: InputTarget,
    text: string,
    submit: boolean,
    expected: InputTargetFacts,
    options?: TypeOptions,
  ): Promise<TypeResult> {
    if (target.kind !== 'terminal' || expected.kind !== 'terminal') return 'target_gone';
    const fresh = await this.look(sessionId, target.key);
    if (!fresh.ok || fresh.facts.kind !== 'terminal') return 'target_gone';
    if (digestFacts(fresh.facts) !== digestFacts(expected)) return 'target_changed';
    // A code kept visible because a code program held the terminal: another member joining the foreground group (a
    // reader the ferret started) is no change to the facts, so the program is proved again here.
    if (options?.codeProgram === true && fresh.codeProgram !== true) return 'target_changed';
    // A rule that pasted on the strength of a program from the owner's profile types only while that program holds it.
    const profile = options?.profileProgram;
    if (
      profile !== undefined &&
      (fresh.profileProgram?.name !== profile.name || fresh.profileProgram.path !== profile.path)
    )
      return 'target_changed';
    const { guard } = fresh;
    if (!PINNABLE_COMMAND.test(guard.command)) return 'target_changed';
    const paneId = fresh.facts.paneProof.paneId;
    const bytes = new TextEncoder().encode(text);
    // A grant fill types only while its line is still held: asked after the last look, as the last thing before the write.
    if (options?.proceed?.() === false) return 'target_changed';
    const condition = [
      `#{==:#{pane_pid},${guard.panePid}}`,
      `#{==:#{pane_current_command},${guard.command}}`,
      `#{==:#{cursor_y},${guard.cursorRow}}`,
      '#{==:#{pane_dead},0}',
    ].reduce((left, right) => `#{&&:${left},${right}}`);
    const write = async (keys: Uint8Array): Promise<'typed' | 'refused' | 'uncertain'> => {
      const [chunk = []] = hexInputChunks(keys, keys.byteLength);
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
        return written.stdout.includes(GUARD_REFUSED) ? 'refused' : 'typed';
      } catch {
        return 'uncertain';
      }
    };
    if (options?.reprove !== true) {
      const once = await write(submit ? new Uint8Array([...bytes, CARRIAGE_RETURN]) : bytes);
      return once === 'refused' ? 'target_changed' : once;
    }
    // A standing rule: the value without Enter, the reader proved again, then Enter (secrev-1301 M1).
    const typed = await write(bytes);
    if (typed === 'refused') return 'guard_refused';
    if (typed === 'uncertain') return 'uncertain';
    if (!(await this.sameReader(sessionId, target.key, fresh.facts))) {
      await this.tmux.execute(['send-keys', '-H', '-t', paneId, KILL_LINE.toString(16)]).catch(() => undefined);
      return 'reader_changed';
    }
    if (!submit) return 'typed';
    const entered = await write(new Uint8Array([CARRIAGE_RETURN]));
    if (entered === 'refused') {
      await this.tmux.execute(['send-keys', '-H', '-t', paneId, KILL_LINE.toString(16)]).catch(() => undefined);
      return 'reader_changed';
    }
    return entered;
  }

  /**
   * Whether the reader the kernel proved before the write still holds the terminal after the value went in without
   * Enter: the same foreground process and group, still the one setuid-root program, echo off, line mode, in the same
   * pane. A line-mode reader can't have read the value yet, so the real sudo is always still there; anything else
   * means the reader changed in the race between the last look and the write. A look that fails counts as changed.
   */
  private async sameReader(
    sessionId: string,
    key: string,
    before: Extract<InputTargetFacts, { readonly kind: 'terminal' }>,
  ): Promise<boolean> {
    const again = await this.look(sessionId, key).catch(() => undefined);
    if (again?.ok !== true || again.facts.kind !== 'terminal') return false;
    const after = again.facts;
    return (
      after.paneProof.paneId === before.paneProof.paneId &&
      after.paneProof.pid === before.paneProof.pid &&
      after.foreground.pid === before.foreground.pid &&
      after.foreground.pgid === before.foreground.pgid &&
      after.program !== undefined &&
      after.program === before.program &&
      after.trustedProgram === true &&
      after.echo === 'off' &&
      after.canonical === true
    );
  }
}
