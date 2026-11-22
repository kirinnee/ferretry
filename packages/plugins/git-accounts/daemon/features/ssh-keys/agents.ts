/**
 * One `ssh-agent` per account, so a ferret that may push as an account can USE its key through a socket and can never
 * read it. The supervisor owns three facts:
 *
 * - The sockets, the pinned `known_hosts` and the public key files live in ONE private folder at a STABLE path: this
 *   plugin's own kernel-made `downloads` folder, the same on every run. A ferret that was started before a daemon
 *   restart or update still has `SSH_AUTH_SOCK` and `UserKnownHostsFile` in its environment, and those paths must
 *   still mean the same thing afterwards (a fresh temp folder per run left them pointing at nothing, and a push failed
 *   with "Host key verification failed"). The path is bounded to fit a unix socket; the agent makes each socket 0600.
 * - The private key reaches the agent on `ssh-add -`'s STDIN and nowhere else: not an argument, not an environment
 *   variable, not a file.
 * - Agents start lazily, on the first ask for an account's socket (and at boot for the accounts that have a key, so a
 *   ferret that outlived a restart finds its socket again), and stop when the account is removed or the daemon stops.
 * - A socket name is the account's, never reused for another account. A stale file left by an agent that died unclean is
 *   removed before the new one binds; an agent that is still stopping is waited for first, because it removes its own
 *   socket path when it exits and would otherwise remove the new agent's.
 *
 * - An agent is a child of the daemon, so a clean stop kills every one. After an UNCLEAN daemon death (SIGKILL) nobody
 *   stopped them: the next boot finds this daemon's own leftovers (an `ssh-agent -D -a <this folder>/gha_<id>.sock` of its
 *   own uid, `sweep.ts`) and ends them BEFORE the first new agent starts. A power loss takes them with the machine.
 */
import type { ChildHandle, Clock, Log, SpawnPort } from '@ferretry/kernel/contract';
import { ApiError } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import { GIT_ACCOUNT_CODES, type GitAccountId, githubKnownHosts } from '../../../contract/index.ts';
import { type LeftoverAgents, sweepLeftoverAgents } from './sweep.ts';

/** The whole wait for an agent to listen: it holds the account's queue, so it is bounded in wall-clock time. */
const READY_DEADLINE_MS = 5_000;
const READY_WAIT_MS = 50;
const READY_PROBE_MS = 1_000;
const KNOWN_HOSTS_NAME = 'known_hosts';
/** A unix socket path is limited (104 bytes on macOS, 108 on Linux): a longer one is refused up front, in words. */
const MAX_SOCKET_PATH = 100;
/** The longest an agent that is stopping is waited for before its replacement starts. */
const STOP_WAIT_MS = 3_000;

/** The private folder the agents live in: stable across runs, made by the kernel, never listed to a ferret. */
export interface RunFolder {
  /** The absolute path; the same on every run. */
  readonly path: string;
  /** Whether every folder down to it is a plain folder only this user can change. */
  isPrivate(): Promise<boolean>;
  /** Removes one name (a stale socket); nothing when it is not there. */
  remove(name: string): Promise<void>;
  /** Writes one file with exactly `mode`, replacing what was there atomically. */
  publish(name: string, text: string, mode: number): Promise<void>;
  /** Makes the folder `name` (when it is not there), removes everything in it, and leaves it with exactly `mode`. */
  emptyDirectory(name: string, mode: number): Promise<void>;
}

interface Running {
  readonly socket: string;
  readonly child: ChildHandle;
}

export class AgentSupervisor {
  readonly #running = new Map<GitAccountId, Running>();
  /** An agent that was told to stop: its exit, so a replacement waits for it to have removed its socket. */
  readonly #stopping = new Map<GitAccountId, Promise<unknown>>();
  readonly #starting = new Map<GitAccountId, Promise<string | undefined>>();
  #knownHosts: Promise<string> | undefined;
  #swept: Promise<unknown> | undefined;
  #stopped = false;

  constructor(
    private readonly spawn: Pick<SpawnPort, 'run' | 'start'>,
    private readonly folder: RunFolder,
    private readonly clock: Pick<Clock, 'sleep' | 'after'>,
    private readonly log: Pick<Log, 'warn'>,
    /** The host's process table, to end agents an earlier unclean death left behind. Absent: nothing is swept. */
    private readonly leftovers?: LeftoverAgents,
  ) {}

  /**
   * Ends this daemon's own agents that an earlier run left behind (`sweep.ts`). Runs once, and every start waits for it,
   * so it can never end an agent THIS run started. Never throws.
   */
  sweepLeftovers(): Promise<unknown> {
    this.#swept ??=
      this.leftovers === undefined
        ? Promise.resolve()
        : sweepLeftoverAgents({
            leftovers: this.leftovers,
            folder: this.folder.path,
            remove: name => this.folder.remove(name),
            clock: this.clock,
            log: this.log,
          });
    return this.#swept;
  }

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
    if (live === undefined) return;
    const gone = live.child.exited.then(
      () => undefined,
      () => undefined,
    );
    this.#stopping.set(id, gone);
    void gone.then(() => {
      if (this.#stopping.get(id) === gone) this.#stopping.delete(id);
    });
    live.child.kill('SIGTERM');
  }

  /** The daemon is stopping: every agent ends. The folder stays: a running ferret's paths must mean the same next run. */
  async stopAll(): Promise<void> {
    this.#stopped = true;
    for (const id of [...this.#running.keys()]) this.stop(id);
    this.#knownHosts = undefined;
    await Promise.race([
      Promise.allSettled([...this.#stopping.values()]),
      this.clock.sleep(milliseconds(STOP_WAIT_MS)).catch(() => undefined),
    ]);
  }

  /** The path an account's agent listens on: the same on every run. */
  socketPath(id: GitAccountId): string {
    return `${this.folder.path}/${id}.sock`;
  }

  /** A file holding the account's PUBLIC key (ssh's `IdentityFile` and git's `user.signingkey`); a public key is not a secret. */
  async publicKeyFile(id: GitAccountId, publicKey: string): Promise<string> {
    await this.#ready();
    await this.folder.publish(`${id}.pub`, `${publicKey.trim()}\n`, 0o644);
    return `${this.folder.path}/${id}.pub`;
  }

  /** A `known_hosts` file pinning GitHub's published keys, kept beside the sockets (read-only to everyone but this user). */
  knownHostsFile(): Promise<string> {
    this.#knownHosts ??= (async () => {
      await this.#ready();
      await this.folder.publish(KNOWN_HOSTS_NAME, githubKnownHosts(), 0o600);
      return `${this.folder.path}/${KNOWN_HOSTS_NAME}`;
    })();
    const known = this.#knownHosts;
    // A failure must not stick: the next ask tries again.
    known.catch(() => {
      if (this.#knownHosts === known) this.#knownHosts = undefined;
    });
    return known;
  }

  async #start(id: GitAccountId, privateKey: string): Promise<string> {
    await this.#ready();
    // An agent an earlier run left behind is ended first (it would run on, unreachable, once its socket is replaced).
    await this.sweepLeftovers();
    // The last agent of this account is gone before the next binds: it removes its socket path as it exits.
    const leaving = this.#stopping.get(id);
    if (leaving !== undefined)
      await Promise.race([leaving, this.clock.sleep(milliseconds(STOP_WAIT_MS)).catch(() => undefined)]);
    const socket = this.socketPath(id);
    // A file left by an agent that died unclean: `-a` refuses an existing path.
    await this.folder.remove(`${id}.sock`);
    if (this.#stopped) throw unavailable();
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

  /** The folder is private and the longest socket path fits; otherwise nothing starts. */
  async #ready(): Promise<void> {
    if (this.#stopped) throw unavailable();
    if (this.socketPath('gha_99999999999999999999').length > MAX_SOCKET_PATH || !(await this.folder.isPrivate())) {
      this.log.warn('git-accounts: the agent folder is not private or its path is too long for a socket');
      throw unavailable();
    }
  }
}

function unavailable(): ApiError {
  return new ApiError(
    503,
    'the ssh-agent for this Git account could not be started',
    GIT_ACCOUNT_CODES.agentUnavailable,
  );
}
