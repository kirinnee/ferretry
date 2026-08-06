import type { CgroupCommandPort, CgroupCommandResult } from '../../lib/cgroups/index.ts';

/**
 * Running one host-manager command.
 *
 * NO SHELL, EVER. The argv is passed as a vector, so a session id that reached a unit name — it
 * cannot, `safeUnitPart` sees to that — still could not become word-splitting or expansion.
 *
 * A NON-ZERO EXIT IS A RESULT, NOT A THROW. "There is no user manager on this session" and "that
 * property does not exist" are answers the domain reports to the operator in the manager's own
 * words; only a failure to launch the executable at all is exceptional, and that arrives as the
 * rejection the caller already handles.
 *
 * BOTH STREAMS ARE DRAINED ALONGSIDE THE EXIT, so a command that fills a pipe cannot deadlock this
 * daemon.
 *
 * AND IT IS BOUNDED. Every caller runs inside the session lifecycle's serial executor — the
 * settings save takes it exclusively, a launch takes it under the session's key — so a user manager
 * that accepts the connection and never answers would not stall one request, it would stall every
 * session start, stop and resume in the daemon for as long as it stayed silent. A wedged host is a
 * real state (a `--user` manager mid-restart, a saturated bus) and an unbounded wait is not a
 * behaviour a daemon may have. So the wait is capped, the child is killed, and the timeout is
 * reported as the refusal it is: a non-zero result whose text names the executable and the bound,
 * which the domain restates through `CgroupError('failed')` like any other refusal.
 *
 * THE READS ARE RACED AGAINST THE KILL rather than awaited after it. A signal closes nothing by
 * itself — anything the child left holding the write end keeps the pipe open — so reading to end of
 * stream after a kill is the same unbounded wait wearing a different hat. This mirrors the Git
 * runner, which is this repository's proven shape for exactly that hazard.
 */

/** Long enough that a healthy manager under load answers, short enough that a wedged one cannot
 *  hold the lifecycle barrier past a person's patience. */
export const DEFAULT_CGROUP_COMMAND_TIMEOUT_MS = 10_000;

/** What a command that never answered is reported as. Negative on purpose: it is not an exit status
 *  the manager chose, and no real one can collide with it. */
export const CGROUP_COMMAND_TIMEOUT_CODE = -1;

/** A refusal this daemon composed, capped so a manager that streams cannot grow the heap. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

const ABANDONED = Symbol('abandoned');

/** Reads a stream to its end, or gives up the moment the command is abandoned. */
async function readOrAbandon(
  stream: ReadableStream<Uint8Array>,
  abandoned: Promise<typeof ABANDONED>,
): Promise<string> {
  const text = await Promise.race([new Response(stream).text(), abandoned]);
  return text === ABANDONED ? '' : text;
}

export interface SpawnCgroupCommandOptions {
  /** Injectable only so a test can prove the bound in milliseconds rather than in seconds. */
  readonly timeoutMs?: number;
}

export class SpawnCgroupCommands implements CgroupCommandPort {
  private readonly timeoutMs: number;

  constructor(options: SpawnCgroupCommandOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CGROUP_COMMAND_TIMEOUT_MS;
  }

  async execute(argv: readonly string[]): Promise<CgroupCommandResult> {
    const [executable, ...rest] = argv;
    if (executable === undefined) throw new Error('a cgroup command needs an executable');
    const child = Bun.spawn([executable, ...rest], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    const abandoned = Promise.withResolvers<typeof ABANDONED>();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      abandoned.resolve(ABANDONED);
    }, this.timeoutMs);
    try {
      const [code, stdout, stderr] = await Promise.all([
        Promise.race([child.exited, abandoned.promise]),
        readOrAbandon(child.stdout, abandoned.promise),
        readOrAbandon(child.stderr, abandoned.promise),
      ]);
      if (code !== ABANDONED) return { code, stdout, stderr };
      // Reaped in the background: the signal has been sent and this daemon must not wait on the
      // exit of something it has already stopped waiting for.
      void child.exited.catch(() => undefined);
      return {
        code: CGROUP_COMMAND_TIMEOUT_CODE,
        stdout,
        stderr: `${executable} did not answer within ${this.timeoutMs}ms and was killed; the host manager is not responding`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
