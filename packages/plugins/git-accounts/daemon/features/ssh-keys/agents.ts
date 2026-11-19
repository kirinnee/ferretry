/**
 * One `ssh-agent` per account, so a ferret that may push as an account can USE its key through a socket and can never
 * read it. The supervisor owns three facts:
 *
 * - The sockets live in ONE private (0700) scratch folder with a short path (a unix socket path is limited to ~104
 *   bytes, which a folder under the state directory can exceed); the agent makes each socket 0600.
 * - The private key reaches the agent on `ssh-add -`'s STDIN and nowhere else: not an argument, not an environment
 *   variable, not a file.
 * - Agents start lazily, on the first ask for an account's socket, and stop when the account is removed or the daemon
 *   stops.
 *
 * DECLARED GAP: an agent is a child of the daemon. After an UNCLEAN daemon death (SIGKILL, power loss) it is not stopped
 * by anyone; it keeps the key in its memory, behind a 0600 socket in a 0700 folder of this user, until it is killed or
 * the machine restarts. A clean stop kills every agent.
 */
import type { ChildHandle, Clock, Log, ScratchDirectory, ScratchPort, SpawnPort } from '@ferretry/kernel/contract';
import { ApiError } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import { GIT_ACCOUNT_CODES, type GitAccountId, githubKnownHosts } from '../../../contract/index.ts';

/** The whole wait for an agent to listen: it holds the account's queue, so it is bounded in wall-clock time. */
const READY_DEADLINE_MS = 5_000;
const READY_WAIT_MS = 50;
const READY_PROBE_MS = 1_000;
const KNOWN_HOSTS_NAME = 'known_hosts';

interface Running {
  readonly socket: string;
  readonly child: ChildHandle;
}

export class AgentSupervisor {
  #folder: Promise<ScratchDirectory> | undefined;
  readonly #running = new Map<GitAccountId, Running>();
  readonly #starting = new Map<GitAccountId, Promise<string | undefined>>();
  #knownHosts: Promise<string> | undefined;
  #stopped = false;
  /** A socket name is never reused: an agent that died unclean leaves its socket file, and `-a` refuses an existing one. */
  #generation = 0;

  constructor(
    private readonly spawn: Pick<SpawnPort, 'run' | 'start'>,
    private readonly scratch: ScratchPort,
    private readonly clock: Pick<Clock, 'sleep' | 'after'>,
    private readonly log: Pick<Log, 'warn'>,
  ) {}

  /** The socket of the account's agent, starting it and loading `privateKey` into it when it is not running. */
  socketFor(id: GitAccountId, privateKey: () => Promise<string | undefined>): Promise<string | undefined> {
    const live = this.#running.get(id);
    if (live !== undefined) return Promise.resolve(live.socket);
    const pending = this.#starting.get(id);
    if (pending !== undefined) return pending;
    const started = (async () => {
      const key = await privateKey();
      if (key === undefined) return undefined;
      return await this.#start(id, key);
    })().finally(() => this.#starting.delete(id));
    this.#starting.set(id, started);
    return started;
  }

  /** Stops one account's agent (its key leaves memory with it). */
  stop(id: GitAccountId): void {
    const live = this.#running.get(id);
    this.#running.delete(id);
    live?.child.kill('SIGTERM');
  }

  /** The daemon is stopping: every agent ends, and the folder of sockets goes. */
  async stopAll(): Promise<void> {
    this.#stopped = true;
    for (const id of [...this.#running.keys()]) this.stop(id);
    const folder = this.#folder;
    this.#folder = undefined;
    this.#knownHosts = undefined;
    await (await folder)?.close().catch(() => undefined);
  }

  /** A `known_hosts` file pinning GitHub's published keys, kept beside the sockets (read-only to everyone but this user). */
  knownHostsFile(): Promise<string> {
    this.#knownHosts ??= (async () => {
      const folder = await this.#folderOf();
      await folder.writeFile(KNOWN_HOSTS_NAME, githubKnownHosts(), 0o600);
      return `${folder.path}/${KNOWN_HOSTS_NAME}`;
    })();
    const known = this.#knownHosts;
    // A failure must not stick: the next ask tries again.
    known.catch(() => {
      if (this.#knownHosts === known) this.#knownHosts = undefined;
    });
    return known;
  }

  async #start(id: GitAccountId, privateKey: string): Promise<string> {
    if (this.#stopped) throw unavailable();
    const folder = await this.#folderOf();
    this.#generation += 1;
    const socket = `${folder.path}/${id}-${String(this.#generation)}.sock`;
    // `-D`: stay in the foreground, so the daemon owns the process; `-a`: this socket and no other.
    const child = this.spawn.start('ssh-agent', ['-D', '-a', socket], { sealed: true, ownGroup: true });
    // Nothing the agent says is worth keeping, but it must be READ: a closed read end kills the agent with SIGPIPE when it
    // prints `SSH_AUTH_SOCK`, and a stream nobody reads can stall it.
    void child.stdout.pipeTo(new WritableStream()).catch(() => undefined);
    void child.stderr.pipeTo(new WritableStream()).catch(() => undefined);
    void child.exited.then(() => {
      if (this.#running.get(id)?.child === child) this.#running.delete(id);
    });
    try {
      await this.#untilReady(socket);
      // A daemon that stopped while this agent was coming up must not hand it the key.
      if (this.#stopped) throw unavailable();
      // The key goes in on stdin. `SSH_AUTH_SOCK` is a path, not a secret; nothing else rides along (`sealed`).
      const added = await this.spawn.run('ssh-add', ['-'], {
        sealed: true,
        env: { SSH_AUTH_SOCK: socket },
        stdin: privateKey,
        timeout: milliseconds(10_000),
      });
      if (added.exitCode !== 0 || this.#stopped) throw unavailable();
    } catch (error) {
      child.kill('SIGTERM');
      this.log.warn('git-accounts: an account agent could not be started', { account: id });
      throw error instanceof ApiError ? error : unavailable();
    }
    this.#running.set(id, { socket, child });
    return socket;
  }

  /**
   * `ssh-add -l` answers 0 (keys) or 1 (none) once the agent listens, and 2 while it cannot be reached. The WHOLE wait,
   * probes included, ends at {@link READY_DEADLINE_MS}: this runs inside the account's start, which others queue behind.
   */
  async #untilReady(socket: string): Promise<void> {
    const over = new AbortController();
    const cancel = this.clock.after(milliseconds(READY_DEADLINE_MS), () => over.abort());
    const late = new Promise<undefined>(resolve => over.signal.addEventListener('abort', () => resolve(undefined)));
    try {
      while (!over.signal.aborted) {
        const probe = await Promise.race([
          this.spawn
            .run('ssh-add', ['-l'], {
              sealed: true,
              env: { SSH_AUTH_SOCK: socket },
              timeout: milliseconds(READY_PROBE_MS),
            })
            .catch(() => undefined),
          late,
        ]);
        if (probe !== undefined && (probe.exitCode === 0 || probe.exitCode === 1)) return;
        await this.clock.sleep(milliseconds(READY_WAIT_MS), over.signal).catch(() => undefined);
      }
      throw unavailable();
    } finally {
      cancel();
    }
  }

  #folderOf(): Promise<ScratchDirectory> {
    if (this.#stopped) return Promise.reject(unavailable());
    this.#folder ??= this.scratch.open();
    return this.#folder;
  }
}

function unavailable(): ApiError {
  return new ApiError(
    503,
    'the ssh-agent for this Git account could not be started',
    GIT_ACCOUNT_CODES.agentUnavailable,
  );
}
