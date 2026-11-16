import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StatePort } from '@ferretry/kernel/contract';
import {
  type ConversationId,
  type ConversationLeaseDisk,
  type HistoryHarness,
  MAX_LEASE_BYTES,
} from '../../../../contract/conversation-lease.ts';
import { ConversationLeaseFiles } from '../../../../contract/state.ts';
import { type ConversationLeaseLock, loadConversationLeaseLock } from './conversation-lease-lock.ts';

/** What the disk needs of Ferrets' own state: the scoped members that write, remove, list and hand out the path of one name. */
export type LeaseState = Pick<StatePort, 'write' | 'remove' | 'pathOf' | 'entries'>;

/** The kernel's clock, as far as the wait for the lock needs it. */
export interface LeaseWaitClock {
  nowMs(): number;
  sleep(ms: number): Promise<void>;
}

/** Tells one run of a pid apart from a later process that reuses the number; `undefined` when the pid is gone. */
export interface LeaseProcessStarts {
  startOf(pid: number): Promise<number | undefined>;
}

export interface ConversationLeaseDiskOptions {
  /** How long a claim waits for another claimant's read-decide-write to finish. */
  readonly waitMs?: number;
  readonly pollMs?: number;
  /** How the lock's C call is loaded — a test names one that fails. */
  readonly loadLock?: () => ConversationLeaseLock;
}

const LEASE_SUFFIX = '.lease';
const LOCK_NAME = 'pool.lock';

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * The daemon's half of the conversation lease disk: the SAME on-disk protocol as `fy history claim`
 * (`cli/adapters/history/state-lease-disk.ts`) — the same `conversation-leases/<harness>/<conversation>.lease` files, the
 * same `pool.lock` and the same `flock(2)` — because a wrapper's claim in a person's terminal and the daemon's own claim
 * must decide against one set of files. The two share only the contract (`ConversationLeaseDisk` and the store over it).
 *
 * A lease is written and removed through the kernel's state port (atomic replace, every parent checked without following
 * a link). Every lease this reads is opened without following a link, must be a regular file, and is read at most
 * {@link MAX_LEASE_BYTES}. The pool's lock file is opened the same way, its two folders must be real directories, and a
 * name that is something else refuses the claim (it throws) rather than being written over. The clock, the platform and
 * the process table are the kernel's, handed in.
 */
export class ConversationLeaseStateDisk implements ConversationLeaseDisk {
  private readonly waitMs: number;
  private readonly pollMs: number;
  private readonly loadLock: () => ConversationLeaseLock;

  constructor(
    private readonly state: LeaseState,
    private readonly processes: LeaseProcessStarts,
    private readonly clock: LeaseWaitClock,
    platform: string,
    options: ConversationLeaseDiskOptions = {},
  ) {
    this.waitMs = options.waitMs ?? 5_000;
    this.pollMs = options.pollMs ?? 10;
    this.loadLock = options.loadLock ?? (() => loadConversationLeaseLock(platform));
  }

  async exclusive<T>(harness: HistoryHarness, work: () => Promise<T>): Promise<T> {
    let lock: ConversationLeaseLock;
    try {
      lock = this.loadLock();
    } catch (error) {
      throw new Error(
        `the conversation lease lock could not be loaded here (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const handle = await this.openLock(harness);
    try {
      const deadline = this.clock.nowMs() + this.waitMs;
      while (!lock.tryLock(handle.fd)) {
        if (this.clock.nowMs() >= deadline)
          throw new Error(
            `the conversation lease store stayed busy: another claimant held its lock for ${String(this.waitMs)} ms`,
          );
        await this.clock.sleep(this.pollMs);
      }
      return await work();
    } finally {
      // The only open of the lock is this one, so closing it lets the next claimant in.
      await handle.close();
    }
  }

  async read(harness: HistoryHarness, conversation: ConversationId): Promise<string | undefined> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(
        this.state.pathOf(ConversationLeaseFiles, `${harness}/${conversation}${LEASE_SUFFIX}`),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    try {
      if (!(await handle.stat()).isFile()) throw new Error(`the lease for ${conversation} is not a regular file`);
      const bytes = Buffer.alloc(MAX_LEASE_BYTES + 1);
      let length = 0;
      for (let read = -1; read !== 0 && length < bytes.length; length += read)
        read = (await handle.read(bytes, length, bytes.length - length, null)).bytesRead;
      return length > MAX_LEASE_BYTES ? undefined : bytes.toString('utf8', 0, length);
    } finally {
      await handle.close();
    }
  }

  async write(harness: HistoryHarness, conversation: ConversationId, text: string): Promise<void> {
    await this.state.write(
      ConversationLeaseFiles,
      new TextEncoder().encode(text),
      `${harness}/${conversation}${LEASE_SUFFIX}`,
    );
  }

  async remove(harness: HistoryHarness, conversation: ConversationId): Promise<void> {
    await this.state.remove(ConversationLeaseFiles, `${harness}/${conversation}${LEASE_SUFFIX}`);
  }

  /** Only lease FILES: a link or a folder that wears a lease's name is never read, and so never stops a release. */
  async list(harness: HistoryHarness): Promise<readonly string[]> {
    const entries = await this.state.entries(ConversationLeaseFiles, harness);
    return entries
      .filter(entry => entry.kind === 'file' && entry.name.endsWith(LEASE_SUFFIX))
      .map(entry => entry.name.slice(0, -LEASE_SUFFIX.length));
  }

  startOf(pid: number): Promise<number | undefined> {
    return this.processes.startOf(pid);
  }

  /**
   * The pool's lock file, made if there is none and never replaced (a lock made again under a holder would be another
   * inode, and two claimants would each hold their own). Both folders above it must be real directories, and the file
   * itself a regular one, opened without following a link.
   */
  private async openLock(harness: HistoryHarness): Promise<Awaited<ReturnType<typeof open>>> {
    const lockPath = this.state.pathOf(ConversationLeaseFiles, `${harness}/${LOCK_NAME}`);
    const folder = dirname(lockPath);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    for (const directory of [dirname(folder), folder])
      if (!(await lstat(directory)).isDirectory())
        throw new Error(`refusing the conversation lease lock: ${directory} is not a plain folder`);
    const handle = await open(
      lockPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    if ((await handle.stat()).isFile()) return handle;
    await handle.close();
    throw new Error('refusing the conversation lease lock: it is not a regular file');
  }
}
