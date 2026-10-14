/**
 * Which process a pid number means, and whether this invocation is in a position to know.
 *
 * A pid alone proves nothing about a process that is not this one. It is meaningful only inside one
 * PID namespace on one boot of one kernel, and it is reused once its process exits. So a lifecycle
 * claim that recorded only `owner: 4242` could never be called abandoned: a missing 4242 might be a
 * live holder in a container sharing `/tmp`, and a present 4242 might be an unrelated process that
 * inherited the number. Every killed `fy daemon start` therefore blocked the next lifecycle command for
 * the whole wait budget and then blamed "another PID namespace" for a process that had simply died.
 *
 * What makes a verdict possible is recording, beside the pid, the SCOPE the number was issued in and
 * the moment that process started:
 *
 * - **Linux**: the boot id and the PID namespace `/proc/self/ns/pid` names, and field 22 of
 *   `/proc/<pid>/stat` — the start time in clock ticks since boot, which never changes for the life of a
 *   process and is not derived from the wall clock, so setting the clock cannot move it.
 * - **macOS**: the boot session UUID, and `ps -o lstart=`, which reports the time recorded when the
 *   process was created. macOS has no PID namespaces, so one boot is the whole scope.
 *
 * Inside a matching scope the answers are authoritative in BOTH directions: no process of that number
 * means it exited, and a different start time means the number was reused. Outside it — a different
 * namespace, or a host that offers neither source — the observation decides nothing, and the caller
 * keeps the old, conservative behaviour.
 */
import { readFile, readlink } from 'node:fs/promises';
import type { IDaemonProcessPort } from '../../lib/daemon/ports.ts';

/** Where a pid number names exactly one process: one boot, one PID namespace. */
export interface ProcessScope {
  readonly boot: string;
  readonly namespace: string;
}

/** What this invocation can see of one pid, from inside its own scope. */
export type ObservedProcess =
  | { readonly kind: 'running'; readonly start: string }
  | { readonly kind: 'gone' }
  /** This host offers no way to ask, or would not answer for this process. Decides nothing. */
  | { readonly kind: 'unknown' };

export interface IProcessIncarnationPort {
  /** The scope this invocation's pids are issued in, or `undefined` when this host cannot say. */
  scope(): Promise<ProcessScope | undefined>;
  /** Process `pid` as seen from this invocation's scope. */
  observe(pid: number): Promise<ObservedProcess>;
}

/** macOS has no PID namespaces; this stands for the one there is, so scopes still compare. */
const DARWIN_NAMESPACE = 'darwin';

/** The field of `/proc/<pid>/stat` that holds the start time, counted from the first field after `comm`. */
const STAT_START_TIME_INDEX = 22 - 3;

export interface HostProcessIncarnationsOptions {
  /** Where `/proc` is. A test points it elsewhere to reach the branch a host without one takes. */
  readonly procDirectory?: string;
  readonly sysctl?: string;
  readonly ps?: string;
}

export class HostProcessIncarnations implements IProcessIncarnationPort {
  constructor(
    private readonly processes: IDaemonProcessPort,
    private readonly options: HostProcessIncarnationsOptions = {},
  ) {}

  async scope(): Promise<ProcessScope | undefined> {
    const boot = await readText(`${this.#proc}/sys/kernel/random/boot_id`);
    if (boot !== undefined) {
      const namespace = await readlink(`${this.#proc}/self/ns/pid`).catch(() => undefined);
      return boot === '' || namespace === undefined ? undefined : { boot, namespace };
    }
    const session = await this.processes.run([this.options.sysctl ?? 'sysctl', '-n', 'kern.bootsessionuuid']);
    const uuid = session.stdout.trim();
    return session.code === 0 && uuid !== '' ? { boot: uuid, namespace: DARWIN_NAMESPACE } : undefined;
  }

  async observe(pid: number): Promise<ObservedProcess> {
    if ((await readText(`${this.#proc}/self/stat`)) !== undefined) return await this.#observeProc(pid);
    const listed = await this.processes.run([this.options.ps ?? 'ps', '-o', 'lstart=', '-p', String(pid)]);
    // `ps` exits 1 with nothing printed for a pid that does not exist; a missing `ps` is 127.
    if (listed.code === 127) return { kind: 'unknown' };
    const start = listed.stdout.trim();
    if (listed.code === 0 && start !== '') return { kind: 'running', start };
    return listed.code === 1 && start === '' ? { kind: 'gone' } : { kind: 'unknown' };
  }

  get #proc(): string {
    return this.options.procDirectory ?? '/proc';
  }

  async #observeProc(pid: number): Promise<ObservedProcess> {
    const stat = await readFile(`${this.#proc}/${String(pid)}/stat`, 'utf8').then(
      contents => contents,
      (error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : undefined),
    );
    if (stat === null) return { kind: 'gone' };
    // `comm` is in parentheses and may itself hold spaces or parentheses, so fields count from the
    // LAST closing one.
    const start = stat
      ?.slice(stat.lastIndexOf(')') + 2)
      .split(' ')
      .at(STAT_START_TIME_INDEX);
    return start === undefined || !/^\d+$/u.test(start) ? { kind: 'unknown' } : { kind: 'running', start };
  }
}

async function readText(path: string): Promise<string | undefined> {
  return await readFile(path, 'utf8').then(
    contents => contents.trim(),
    () => undefined,
  );
}
