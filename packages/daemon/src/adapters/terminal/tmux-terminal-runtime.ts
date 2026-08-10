import type { TerminalSize } from '@ferretry/protocol';
import type { TerminalRecord, TerminalRuntimePort } from '../../lib/terminal/contracts.ts';
import { decodeTerminalOpener, encodeTerminalOpener } from '../../lib/terminal/ownership.ts';
import {
  hexInputChunks,
  terminalPaneTarget,
  terminalSnapshotFrame,
  terminalTmuxSessionName,
} from '../../lib/terminal/runtime-policy.ts';
import type { TmuxCommandPort } from '../../lib/tmux/contracts.ts';

const OWNER_OPTION = '@fy_terminal_owner';
const ID_OPTION = '@fy_terminal_id';
const TITLE_OPTION = '@fy_terminal_title';
const CREATED_OPTION = '@fy_terminal_created';
const ROOT_OPTION = '@fy_terminal_root';
/**
 * Ownership rides on the PANE, not in daemon memory or a side file. That is what
 * makes it durable in the sense #34 asks for: it survives a daemon restart and a
 * redeploy, and it disappears exactly when the shell it describes does. A pane
 * that predates this option simply answers with the empty string, which decodes
 * to no opener at all.
 */
const OPENED_BY_OPTION = '@fy_terminal_opened_by';
const SEPARATOR = '\t';

export class TerminalRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalRuntimeError';
  }
}

function number(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function failure(message: string, stderr: string): TerminalRuntimeError {
  return new TerminalRuntimeError(`${message}: ${stderr.trim() || 'tmux command failed'}`);
}

function isRecordId(value: string): boolean {
  return /^[a-f0-9]{12}$/u.test(value);
}

/** tmux-backed independent shell terminals over the daemon's injected private socket. */
export class TmuxTerminalRuntime implements TerminalRuntimePort {
  constructor(
    private readonly tmux: TmuxCommandPort,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async list(): Promise<readonly TerminalRecord[]> {
    const format = [
      '#{session_name}',
      `#{${OWNER_OPTION}}`,
      `#{${ID_OPTION}}`,
      `#{${TITLE_OPTION}}`,
      `#{${CREATED_OPTION}}`,
      `#{${ROOT_OPTION}}`,
      `#{${OPENED_BY_OPTION}}`,
      '#{session_activity}',
      '#{window_width}',
      '#{window_height}',
    ].join(SEPARATOR);
    const result = await this.tmux.execute(['list-sessions', '-F', format]);
    if (result.code !== 0) {
      if (/no server running|failed to connect|no sessions/i.test(result.stderr)) return [];
      throw failure('could not list terminal sessions', result.stderr);
    }
    const records: TerminalRecord[] = [];
    for (const line of result.stdout.split('\n')) {
      if (!line) continue;
      const [
        tmuxSession = '',
        ownerId = '',
        id = '',
        title = '',
        created = '',
        root = '',
        openedBy = '',
        activity = '',
        cols = '',
        rows = '',
      ] = line.split(SEPARATOR);
      const parsedCreatedAtMs = Date.parse(created);
      // An unreadable or unwritten opener contributes no key at all, so the view
      // reports "unrecorded" rather than a class this build invented for it.
      const opener = decodeTerminalOpener(openedBy);
      const createdAtMs = Number.isFinite(parsedCreatedAtMs) ? parsedCreatedAtMs : this.now();
      const record: TerminalRecord = {
        id,
        ownerId,
        title,
        root,
        tmuxSession,
        createdAtMs,
        // THE TWO CLOCKS DISAGREE ON PRECISION, so the later one is not always
        // the larger number. Creation is our own ISO stamp, written to the pane
        // in MILLISECONDS; activity is tmux's `#{session_activity}`, a UNIX time
        // in WHOLE SECONDS. A terminal opened at …:19.997 that has not been
        // typed into since therefore reports activity at …:19.000 — earlier than
        // its own creation — and the protocol refuses that listing outright, so
        // one freshly opened shell made `GET …/terminals` unparseable for every
        // reader of it: the composer's `%` menu, which never opened and re-asked
        // on every keystroke because a rejected answer is never cached, and the
        // terminal pane beside it. Clamping here rather than relaxing the schema
        // keeps monotonicity a property of the record, which is what every
        // consumer already reads it as; the lost sub-second is tmux's own
        // resolution and was never ours to report.
        lastActivityAtMs: Math.max(createdAtMs, number(activity, this.now() / 1_000) * 1_000),
        cols: Math.max(1, Math.trunc(number(cols, 100))),
        rows: Math.max(1, Math.trunc(number(rows, 30))),
        ...(opener === undefined ? {} : { openedBy: opener }),
      };
      if (!tmuxSession.startsWith('fy-webterm-') || !isRecordId(id) || !ownerId || !root.startsWith('/')) continue;
      records.push(record);
    }
    return records;
  }

  async create(input: Parameters<TerminalRuntimePort['create']>[0]): Promise<TerminalRecord> {
    const createdAtMs = this.now();
    const tmuxSession = terminalTmuxSessionName(input.ownerId, input.id);
    const result = await this.tmux.execute([
      'new-session',
      '-d',
      '-s',
      tmuxSession,
      '-c',
      input.cwd,
      '-x',
      String(input.size.cols),
      '-y',
      String(input.size.rows),
      '/bin/sh',
      '-l',
      ';',
      'set-option',
      '-t',
      tmuxSession,
      OWNER_OPTION,
      input.ownerId,
      ';',
      'set-option',
      '-t',
      tmuxSession,
      ID_OPTION,
      input.id,
      ';',
      'set-option',
      '-t',
      tmuxSession,
      TITLE_OPTION,
      input.title,
      ';',
      'set-option',
      '-t',
      tmuxSession,
      CREATED_OPTION,
      new Date(createdAtMs).toISOString(),
      ';',
      'set-option',
      '-t',
      tmuxSession,
      ROOT_OPTION,
      input.cwd,
      // Written in the SAME command as the pane it describes: a second round
      // trip could lose the race with a list that is already running, and a
      // terminal that briefly reports no owner is a terminal a reader may type
      // into believing nobody else is there.
      ...(input.openedBy === undefined
        ? []
        : [';', 'set-option', '-t', tmuxSession, OPENED_BY_OPTION, encodeTerminalOpener(input.openedBy)]),
      ';',
      'set-window-option',
      '-t',
      `${tmuxSession}:0`,
      'history-limit',
      '5000',
    ]);
    if (result.code !== 0) {
      await this.tmux.execute(['kill-session', '-t', tmuxSession]).catch(() => undefined);
      throw failure('could not create terminal', result.stderr);
    }
    return {
      id: input.id,
      ownerId: input.ownerId,
      title: input.title,
      root: input.cwd,
      tmuxSession,
      createdAtMs,
      lastActivityAtMs: createdAtMs,
      ...input.size,
      ...(input.openedBy === undefined ? {} : { openedBy: input.openedBy }),
    };
  }

  async rename(record: TerminalRecord, title: string): Promise<void> {
    const result = await this.tmux.execute(['set-option', '-t', record.tmuxSession, TITLE_OPTION, title]);
    if (result.code !== 0) throw failure('terminal no longer exists', result.stderr);
  }

  async resize(record: TerminalRecord, size: TerminalSize): Promise<void> {
    const result = await this.tmux.execute([
      'resize-window',
      '-t',
      record.tmuxSession,
      '-x',
      String(size.cols),
      '-y',
      String(size.rows),
    ]);
    if (result.code !== 0) throw failure('terminal no longer exists', result.stderr);
  }

  async write(record: TerminalRecord, bytes: Uint8Array): Promise<void> {
    for (const chunk of hexInputChunks(bytes)) {
      const result = await this.tmux.execute(['send-keys', '-H', '-t', terminalPaneTarget(record), ...chunk]);
      if (result.code !== 0) throw failure('terminal no longer exists', result.stderr);
    }
  }

  async capture(record: TerminalRecord): Promise<Uint8Array> {
    const [capture, cursor] = await Promise.all([
      this.tmux.execute(['capture-pane', '-p', '-e', '-S', '-2000', '-t', terminalPaneTarget(record)]),
      this.tmux.execute(['display-message', '-p', '-t', terminalPaneTarget(record), '#{cursor_x}\t#{cursor_y}']),
    ]);
    if (capture.code !== 0 || cursor.code !== 0) throw new TerminalRuntimeError('terminal no longer exists');
    const [x = '0', y = '0'] = cursor.stdout.trim().split(SEPARATOR);
    return new TextEncoder().encode(terminalSnapshotFrame(capture.stdout, number(x, 0), number(y, 0)));
  }

  async kill(record: TerminalRecord): Promise<void> {
    const result = await this.tmux.execute(['kill-session', '-t', record.tmuxSession]);
    if (result.code !== 0 && !/can't find session|no server running/i.test(result.stderr)) {
      throw failure('could not close terminal', result.stderr);
    }
  }
}
