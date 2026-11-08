import type { HostFactsPort } from '@ferretry/kernel/contract';
import { loopbackListenersOn } from '../../../proxy/wire/tcp-listeners.ts';
import { type ListenerProof, proveListener } from '../index.ts';

/** The `kernel.hostFacts` reads the prover makes: the socket tables, the process list, each process's stat and descriptors. */
export type ListenerHostFacts = Pick<HostFactsPort, 'pids' | 'procFile' | 'procSystemFile' | 'procFds' | 'procFdLink'>;

/** How the prover reads the host: this process's uid, injected so a test can judge a fake table. */
export interface ListenerProverOptions {
  /** `undefined` where the platform has no uids, which is a host this prover cannot judge. */
  readonly uid?: () => number | undefined;
}

/** What the browser launchers ask: is the listener on `port` the one `pid` (or a child of it) opened? */
export interface ListenerProverPort {
  prove(port: number, pid: number): Promise<ListenerProof>;
  /** The uid of whoever listens on `port` from loopback, for a bind that failed there; `undefined` if unseen. */
  holder(port: number): Promise<number | undefined>;
}

const SOCKET_LINK = /^socket:\[(\d+)\]$/u;

/**
 * Reads the kernel's evidence (through `kernel.hostFacts`; with none, the host proves nothing and every answer is `unknown`) for `lib/browser/control/listener-proof.ts`: the socket tables, and the socket
 * inodes held by the spawned process and its descendants (`/proc/<pid>/fd` links). Descendants count because a
 * supervised child is not always the pid the daemon holds — x11vnc runs under `timeout(1)`, which forks it.
 *
 * Every read that fails is absence, never a throw: a process that exited has no fds, and a host with no `/proc`
 * (macOS) has no tables, which the pure judge turns into `unknown`.
 */
export class ProcListenerProver implements ListenerProverPort {
  private readonly uid: () => number | undefined;

  constructor(
    private readonly facts?: ListenerHostFacts,
    options: ListenerProverOptions = {},
  ) {
    this.uid = options.uid ?? (() => process.getuid?.());
  }

  async prove(port: number, pid: number): Promise<ListenerProof> {
    // The tables are read BEFORE the fds: a socket's fd exists from `socket()`, before it ever listens, so a
    // listener in the table is already in its holder's fd list by the time the list is read.
    const tables = await this.tables();
    const own = await this.socketInodes(pid);
    const first = proveListener(port, this.uid(), { tables, inodes: own });
    if (first.kind !== 'foreign') return first;
    // Only a listener the pid itself does not hold costs the walk over every process for its descendants.
    const tree = await this.descendants(pid);
    const inodes = new Set(own);
    for (const child of tree) for (const inode of await this.socketInodes(child)) inodes.add(inode);
    return proveListener(port, this.uid(), { tables, inodes });
  }

  async holder(port: number): Promise<number | undefined> {
    const tables = await this.tables();
    return tables === undefined ? undefined : loopbackListenersOn(port, tables)[0]?.uid;
  }

  private async tables(): Promise<readonly string[] | undefined> {
    const facts = this.facts;
    if (facts === undefined) return undefined;
    const tables = await Promise.all(
      (['net/tcp', 'net/tcp6'] as const).map(table => facts.procSystemFile(table).catch(() => undefined)),
    );
    const present = tables.filter((table): table is string => table !== undefined);
    return present.length === 0 ? undefined : present;
  }

  private async socketInodes(pid: number): Promise<ReadonlySet<number>> {
    const facts = this.facts;
    if (facts === undefined) return new Set();
    const entries = await facts.procFds(pid).catch(() => []);
    const links = await Promise.all(entries.map(entry => facts.procFdLink(pid, entry).catch(() => '')));
    const inodes = new Set<number>();
    for (const link of links) {
      const match = SOCKET_LINK.exec(link);
      if (match !== null) inodes.add(Number(match[1]));
    }
    return inodes;
  }

  /** Every process descended from `pid`, read from each `/proc/<n>/stat`'s parent field. */
  private async descendants(pid: number): Promise<readonly number[]> {
    const entries = (await this.facts?.pids().catch(() => [])) ?? [];
    const parents = await Promise.all(entries.map(async entry => [entry, await this.parentOf(entry)] as const));
    const found: number[] = [];
    const frontier = [pid];
    for (let parent = frontier.shift(); parent !== undefined; parent = frontier.shift()) {
      for (const [child, of] of parents) {
        if (of !== parent || found.includes(child)) continue;
        found.push(child);
        frontier.push(child);
      }
    }
    return found;
  }

  private async parentOf(entry: number): Promise<number | undefined> {
    const stat = (await this.facts?.procFile(entry, 'stat').catch(() => '')) ?? '';
    // `pid (comm) state ppid …` — the command name may hold spaces and parentheses, so the fields are read from
    // after its LAST closing parenthesis.
    const ppid = stat
      .slice(stat.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/u)[1];
    return ppid !== undefined && /^\d+$/u.test(ppid) ? Number(ppid) : undefined;
  }
}
