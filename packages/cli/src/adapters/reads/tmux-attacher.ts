import type { SessionAttachTarget } from '@ferretry/protocol';
import type { ITerminalAttacher } from '../../lib/reads/ports.ts';
import { SessionCommandError } from '../../lib/session/errors.ts';

export interface TmuxAttachCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Host process operations kept behind a port so no unit test reaches a real tmux server. */
export interface TmuxAttachProcess {
  executable(): string | undefined;
  inspect(argv: readonly string[]): Promise<TmuxAttachCommandResult>;
  interact(argv: readonly string[]): Promise<number>;
  processStartTicks(pid: number): Promise<number | undefined>;
}

/** Linux `/proc/<pid>/stat` field 22, after the parenthesized command name. */
export function parseProcessStartTicks(text: string): number | undefined {
  const close = text.lastIndexOf(')');
  if (close < 1) return undefined;
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  if (fields.length < 20) return undefined;
  const value = Number(fields[19]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** The socket portion of tmux's `TMUX=/path/socket,pid,index` environment record. */
export function currentTmuxSocket(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  const fields = value.split(',');
  if (fields.length < 3) return undefined;
  const pid = Number(fields.at(-2));
  const client = Number(fields.at(-1));
  if (!Number.isSafeInteger(pid) || pid <= 1 || !Number.isSafeInteger(client) || client < 0) return undefined;
  const socket = fields.slice(0, -2).join(',');
  return socket.startsWith('/') ? socket : undefined;
}

function observedIdentity(text: string):
  | {
      readonly tmuxSession: string;
      readonly paneId: string;
      readonly pid: number;
    }
  | undefined {
  const [tmuxSession = '', paneId = '', rawPid = '', ...rest] = text.trim().split('\t');
  const pid = Number(rawPid);
  return rest.length === 0 &&
    tmuxSession !== '' &&
    /^%[1-9][0-9]*$/u.test(paneId) &&
    Number.isSafeInteger(pid) &&
    pid > 1
    ? { tmuxSession, paneId, pid }
    : undefined;
}

/**
 * Re-checks the daemon's short-lived proof, then hands the terminal to exactly that tmux session.
 *
 * No name is derived locally. Inspection addresses the daemon-supplied private socket and exact pane
 * id, compares the tmux session, pane id, pid and `/proc` start ticks, and only then performs the
 * interactive action. Inside that SAME tmux server it switches the current client; inside a different
 * server it refuses rather than nesting or switching an unrelated client.
 */
export class ExactTmuxAttacher implements ITerminalAttacher {
  constructor(
    private readonly process: TmuxAttachProcess,
    private readonly environment: Readonly<Record<string, string | undefined>>,
  ) {}

  async attach(target: SessionAttachTarget): Promise<number> {
    const executable = this.process.executable();
    if (executable === undefined) throw new SessionCommandError('tmux is not installed on this host');
    const inspected = await this.process.inspect([
      executable,
      '-S',
      target.socketPath,
      'display-message',
      '-p',
      '-t',
      target.paneId,
      '#{session_name}\t#{pane_id}\t#{pane_pid}',
    ]);
    const observed = inspected.code === 0 ? observedIdentity(inspected.stdout) : undefined;
    if (observed === undefined)
      throw new SessionCommandError(
        inspected.stderr.trim() || 'tmux no longer reports the pane identity the daemon supplied',
      );
    const ticks = await this.process.processStartTicks(observed.pid);
    if (
      observed.tmuxSession !== target.tmuxSession ||
      observed.paneId !== target.paneId ||
      observed.pid !== target.pid ||
      ticks !== target.processStartTicks
    )
      throw new SessionCommandError('the live pane no longer matches the daemon attach proof; refusing to attach');

    const ambientTmux = this.environment.TMUX;
    const current = currentTmuxSocket(ambientTmux);
    if (ambientTmux !== undefined && ambientTmux !== '' && current === undefined)
      throw new SessionCommandError('the current TMUX environment is malformed; refusing to choose an attach server');
    if (current !== undefined && current !== target.socketPath)
      throw new SessionCommandError(
        'this terminal is attached to a different tmux server; detach from it before attaching to the session',
      );
    const action = current === target.socketPath ? 'switch-client' : 'attach-session';
    // `select-pane` makes the registered agent pane active before the client enters the session. The
    // exact pane was just revalidated; the attach itself still names the registered session because
    // tmux's attach target grammar accepts sessions, not pane ids.
    return await this.process.interact([
      executable,
      '-S',
      target.socketPath,
      'select-pane',
      '-t',
      target.paneId,
      ';',
      action,
      '-t',
      target.tmuxSession,
    ]);
  }
}

/** The real tmux and procfs operations. Every argv is executed directly, never through a shell. */
export class BunTmuxAttachProcess implements TmuxAttachProcess {
  executable(): string | undefined {
    return Bun.which('tmux') ?? undefined;
  }

  async inspect(argv: readonly string[]): Promise<TmuxAttachCommandResult> {
    const child = Bun.spawn([...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }

  async interact(argv: readonly string[]): Promise<number> {
    return await Bun.spawn([...argv], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }).exited;
  }

  async processStartTicks(pid: number): Promise<number | undefined> {
    try {
      return parseProcessStartTicks(await Bun.file(`/proc/${pid}/stat`).text());
    } catch {
      return undefined;
    }
  }
}
