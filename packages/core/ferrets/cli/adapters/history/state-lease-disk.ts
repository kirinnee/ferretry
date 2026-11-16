import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StatePort } from '@ferretry/kernel/contract';
import {
  type ConversationId,
  type ConversationLeaseDisk,
  type HistoryHarness,
  MAX_LEASE_BYTES,
} from '../../../contract/conversation-lease.ts';
import { ConversationLeaseFiles } from '../../../contract/state.ts';
import { type FileLock, loadFileLock } from './file-lock.ts';
import type { ProcessStartSource } from './host-process-starts.ts';

/** What the disk needs of Ferrets' own state: the scoped members that write and remove one name and hand out its path. */
export type LeaseState = Pick<StatePort, 'write' | 'remove' | 'pathOf'>;

export interface StateLeaseDiskOptions {
  /** How long a claim waits for another claimant's read-decide-write to finish. */
  readonly waitMs?: number;
  readonly pollMs?: number;
  /** How the lock's C call is loaded — a test names one that fails. */
  readonly loadLock?: () => FileLock;
}

const LEASE_SUFFIX = '.lease';
const LOCK_NAME = 'pool.lock';

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * Conversation leases as files in Ferrets' own declared state tree (`ConversationLeaseFiles`): a lease is written and
 * removed through the kernel's state port (atomic replace, every parent checked without following a link), and the pool's
 * lock is an exclusive `flock(2)` on `<harness>/pool.lock`, which the kernel drops when its holder closes it or dies.
 *
 * Nothing here is in a folder an agent writes, and nothing is named by a caller: a conversation id is a parsed
 * {@link ConversationId} (no separator, no dot) and the harness is one of two words. Every file this reads is opened
 * without following a link, must be a regular file, and is read at most {@link MAX_LEASE_BYTES}. A lease name that is
 * something else refuses the claim (it throws) rather than being written over.
 */
export class StateLeaseDisk implements ConversationLeaseDisk {
  private readonly waitMs: number;
  private readonly pollMs: number;
  private readonly loadLock: () => FileLock;

  constructor(
    private readonly state: LeaseState,
    private readonly processes: ProcessStartSource,
    options: StateLeaseDiskOptions = {},
  ) {
    this.waitMs = options.waitMs ?? 5_000;
    this.pollMs = options.pollMs ?? 10;
    this.loadLock = options.loadLock ?? loadFileLock;
  }

  async exclusive<T>(harness: HistoryHarness, work: () => Promise<T>): Promise<T> {
    let lock: FileLock;
    try {
      lock = this.loadLock();
    } catch (error) {
      throw new Error(
        `the conversation lease lock could not be loaded here (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const handle = await this.openLock(harness);
    try {
      const deadline = Date.now() + this.waitMs;
      while (!lock.tryLock(handle.fd)) {
        if (Date.now() >= deadline)
          throw new Error(
            `the conversation lease store stayed busy: another claimant held its lock for ${String(this.waitMs)} ms`,
          );
        await new Promise(resolve => setTimeout(resolve, this.pollMs));
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
        this.leasePath(harness, conversation),
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

  async list(harness: HistoryHarness): Promise<readonly string[]> {
    const names = await readdir(this.folder(harness)).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    return names.filter(name => name.endsWith(LEASE_SUFFIX)).map(name => name.slice(0, -LEASE_SUFFIX.length));
  }

  startOf(pid: number): Promise<number | undefined> {
    return this.processes.startOf(pid);
  }

  private leasePath(harness: HistoryHarness, conversation: ConversationId): string {
    return this.state.pathOf(ConversationLeaseFiles, `${harness}/${conversation}${LEASE_SUFFIX}`);
  }

  private folder(harness: HistoryHarness): string {
    return dirname(this.state.pathOf(ConversationLeaseFiles, `${harness}/${LOCK_NAME}`));
  }

  /**
   * The pool's lock file, made if there is none and never replaced (a lock made again under a holder would be another
   * inode, and two claimants would each hold their own). Both folders above it must be real directories, and the file
   * itself a regular one, opened without following a link.
   */
  private async openLock(harness: HistoryHarness): Promise<Awaited<ReturnType<typeof open>>> {
    const folder = this.folder(harness);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    for (const directory of [dirname(folder), folder])
      if (!(await lstat(directory)).isDirectory())
        throw new Error(`refusing the conversation lease lock: ${directory} is not a plain folder`);
    const handle = await open(
      this.state.pathOf(ConversationLeaseFiles, `${harness}/${LOCK_NAME}`),
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    if ((await handle.stat()).isFile()) return handle;
    await handle.close();
    throw new Error('refusing the conversation lease lock: it is not a regular file');
  }
}
