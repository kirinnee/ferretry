import type { LoginShellPort } from '../../lib/terminal/login-shell.ts';
import type { TmuxCommandPort, TmuxCommandResult } from '../../lib/tmux/contracts.ts';
import { isTmuxServerAbsent } from '../../lib/tmux/server-absent.ts';
import type { JobRuntimePort, RunningJob } from '../../lib/jobs/contracts.ts';
import {
  JOB_ID_OPTION,
  JOB_OWNER_OPTION,
  JOB_TMUX_PREFIX,
  jobPaneArgv,
  jobTmuxSessionName,
} from '../../lib/jobs/policy.ts';
import type { TerminalLimiter } from '../terminal/tmux-terminal-runtime.ts';

const SEPARATOR = '\t';

export class JobRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobRuntimeError';
  }
}

/**
 * The keeper: each job is a tmux session of its own on the daemon-owned server (the same server and the same limits scope as a
 * terminal — this reuses the terminal runtime's ports, it does not fork them). The session is marked on itself
 * (`@fy_job_owner`, `@fy_job_id`), so the tmux server — which outlives the daemon — is the only memory a restart needs.
 * It runs the wrapper script directly (no interactive shell): when the wrapper exits, the pane and the session close.
 */
export class TmuxJobRuntime implements JobRuntimePort {
  constructor(
    private readonly tmux: TmuxCommandPort,
    private readonly loginShell: LoginShellPort,
    /** The same limiter terminals use; applied to a job an agent started. */
    private readonly limits?: TerminalLimiter,
    private readonly environment: () => Readonly<Record<string, string>> = () => ({}),
    private readonly pause: (ms: number) => Promise<void> = async ms => await new Promise(resolve => setTimeout(resolve, ms)),
  ) {}

  async start(input: Parameters<JobRuntimePort['start']>[0]): Promise<RunningJob> {
    const tmuxSession = jobTmuxSessionName(input.owner, input.id);
    const shell = await this.loginShell.shell();
    const wrapper = jobPaneArgv({ dir: input.dir, shell, command: input.command });
    const argv =
      input.limited && this.limits !== undefined
        ? await this.limits.command(input.owner, wrapper, { terminal: true })
        : wrapper;
    const result = await this.tmux.execute([
      'new-session',
      '-d',
      '-s',
      tmuxSession,
      '-c',
      input.cwd,
      '-x',
      '200',
      '-y',
      '50',
      ...Object.entries(this.environment()).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
      ...argv,
      ';',
      'set-option',
      '-t',
      tmuxSession,
      JOB_OWNER_OPTION,
      input.owner,
      ';',
      'set-option',
      '-t',
      tmuxSession,
      JOB_ID_OPTION,
      input.id,
    ]);
    if (result.code !== 0) {
      await this.tmux.execute(['kill-session', '-t', tmuxSession]).catch(() => undefined);
      throw new JobRuntimeError(`could not start the job: ${result.stderr.trim() || 'tmux command failed'}`);
    }
    return { owner: input.owner, id: input.id, tmuxSession };
  }

  async list(): Promise<readonly RunningJob[]> {
    const result = await this.listSessions();
    if (result.code !== 0) {
      if (isTmuxServerAbsent(result.stderr) || /no sessions/iu.test(result.stderr)) return [];
      throw new JobRuntimeError(`could not list jobs: ${result.stderr.trim() || 'tmux command failed'}`);
    }
    const jobs: RunningJob[] = [];
    for (const line of result.stdout.split('\n')) {
      const [tmuxSession = '', owner = '', id = ''] = line.split(SEPARATOR);
      if (!tmuxSession.startsWith(JOB_TMUX_PREFIX) || owner === '' || !/^[a-f0-9]{12}$/u.test(id)) continue;
      jobs.push({ owner, id, tmuxSession });
    }
    return jobs;
  }

  /**
   * The server lives only while a session does, so the moment the last job ends it exits — and a listing that reached it
   * as it went answers `server exited unexpectedly`. That is a race, not a failure: asked again, the server is gone and
   * holds nothing. A few tries, each a moment apart, settle it; a server that keeps saying it is still a real failure.
   */
  private async listSessions(): Promise<TmuxCommandResult> {
    let result: TmuxCommandResult;
    for (let attempt = 0; ; attempt += 1) {
      result = await this.tmux.execute([
        'list-sessions',
        '-F',
        ['#{session_name}', `#{${JOB_OWNER_OPTION}}`, `#{${JOB_ID_OPTION}}`].join(SEPARATOR),
      ]);
      if (result.code === 0 || !/server exited unexpectedly/iu.test(result.stderr) || attempt >= 4) return result;
      await this.pause(40);
    }
  }

  async kill(job: RunningJob): Promise<void> {
    const result = await this.tmux.execute(['kill-session', '-t', job.tmuxSession]);
    if (result.code !== 0 && !/can't find session/iu.test(result.stderr) && !isTmuxServerAbsent(result.stderr))
      throw new JobRuntimeError(`could not close the job: ${result.stderr.trim()}`);
  }
}
