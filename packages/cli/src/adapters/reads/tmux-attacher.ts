import type { ProcessIncarnation, SessionAttachTarget } from '@ferretry/protocol';
import { processIncarnationFor } from '@ferretry/protocol/process-incarnation';
import type { ITerminalAttacher } from '../../lib/reads/ports.ts';
import { SessionCommandError } from '../../lib/session/errors.ts';

export interface TmuxAttachCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * What the host can say about a pane process's start identity.
 *
 * `gone` and `unavailable` are different answers on purpose. A process that is not running is
 * evidence the daemon's proof is stale, and refuses. A host with no way to read a start identity at
 * all is the absence of evidence, which is not a reason to refuse every attach forever.
 */
export type ProcessStart =
  | { readonly kind: 'known'; readonly value: number }
  | { readonly kind: 'gone' }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** Host process operations kept behind a port so no unit test reaches a real tmux server. */
export interface TmuxAttachProcess {
  executable(): string | undefined;
  inspect(argv: readonly string[]): Promise<TmuxAttachCommandResult>;
  interact(argv: readonly string[]): Promise<number>;
  processStart(pid: number): Promise<ProcessStart>;
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
    /^%(?:0|[1-9][0-9]*)$/u.test(paneId) &&
    Number.isSafeInteger(pid) &&
    pid > 1
    ? { tmuxSession, paneId, pid }
    : undefined;
}

/**
 * Re-checks the daemon's short-lived proof, then hands the terminal to exactly that tmux session.
 *
 * No name is derived locally. Inspection addresses the daemon-supplied private socket and exact pane
 * id, compares the tmux session, pane id, pid and process start identity, and only then performs the
 * interactive action. Inside that SAME tmux server it switches the current client; inside a different
 * server it refuses rather than nesting or switching an unrelated client.
 *
 * The start identity is read by the very module the daemon wrote it with
 * (`@ferretry/protocol/process-incarnation`), so the two sides cannot disagree about its unit. A
 * mismatch names every check that failed. When the host genuinely has no source for the identity, the
 * attach continues on session, pane id and pid against the proof the daemon observed moments ago, and
 * says so through `notice`.
 */
export class ExactTmuxAttacher implements ITerminalAttacher {
  constructor(
    private readonly process: TmuxAttachProcess,
    private readonly environment: Readonly<Record<string, string | undefined>>,
    private readonly notice: (message: string) => void = () => undefined,
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
    const failed: string[] = [];
    if (observed.tmuxSession !== target.tmuxSession)
      failed.push(`tmux session is "${observed.tmuxSession}", the daemon proved "${target.tmuxSession}"`);
    if (observed.paneId !== target.paneId)
      failed.push(`pane id is ${observed.paneId}, the daemon proved ${target.paneId}`);
    if (observed.pid !== target.pid)
      failed.push(`pane pid is ${String(observed.pid)}, the daemon proved ${String(target.pid)}`);
    const start = observed.pid === target.pid ? await this.process.processStart(observed.pid) : undefined;
    if (start?.kind === 'known' && start.value !== target.processStartTicks)
      failed.push(
        `process start identity is ${String(start.value)}, the daemon proved ${String(target.processStartTicks)}`,
      );
    if (start?.kind === 'gone') failed.push(`pane process ${String(observed.pid)} is no longer running`);
    if (failed.length > 0)
      throw new SessionCommandError(
        `the live pane no longer matches the daemon attach proof (${failed.join('; ')}); refusing to attach`,
      );
    if (start?.kind === 'unavailable')
      this.notice(
        `could not check the pane's process start identity (${start.reason}); attaching on the tmux session, pane id and pid the daemon just proved`,
      );

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

/** The real tmux and process operations. Every argv is executed directly, never through a shell. */
export class BunTmuxAttachProcess implements TmuxAttachProcess {
  constructor(private readonly incarnation: ProcessIncarnation = processIncarnationFor()) {}

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

  async processStart(pid: number): Promise<ProcessStart> {
    try {
      const value = await this.incarnation.startOf(pid);
      return value === undefined ? { kind: 'gone' } : { kind: 'known', value };
    } catch (error) {
      return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
    }
  }
}
