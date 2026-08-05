/**
 * An exclusive lock over one fleet directory, held across separate invocations.
 *
 * Two applies that overlap capture each other's writes as "the state before", so their rollbacks
 * undo one another and neither report is true. An in-memory queue only orders the applies made
 * through one object; the command-line tool and the daemon are different invocations entirely, and
 * the fleet they contend for is a directory, so the claim has to live in that directory too.
 *
 * **A claim is never observed half-written.** It is built under a private name and published with
 * `link(2)`, which is atomic and fails if the name is taken. An exclusive create would leave a
 * zero-length file visible to a contender for as long as the write takes.
 *
 * **Nothing is ever taken over automatically, and that is the deliberate choice.** Reclaiming an
 * abandoned claim needs an atomic compare-and-replace that a filesystem does not offer: a reaper
 * that reads a dead claim, then renames it, can move a live successor's claim instead — the claim
 * it read is not the claim it moves — and a third contender can take the name it just freed. The
 * result is exactly the double apply the lock exists to prevent, arrived at by the code meant to
 * protect it. So a claim is only ever released by the holder that made it, proven by a random token
 * that has to still be present. A holder that dies leaves its claim behind; the refusal then names
 * the file, its owner, and whether that owner is still running, and a person removes it. That is a
 * worse failure to *recover* from and a much better one to *have*.
 *
 * The crash semantics this implies are the honest ones and are not claimed away: an apply
 * interrupted by a killed task leaves both its lock and its moved-aside evidence on disk.
 */
import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const ClaimSchema = z.strictObject({
  /** Identifier of the running task that made the claim, reported for recovery. */
  owner: z.number().int().positive(),
  /** Unguessable per-claim value, so a holder can prove a lock is still the one it took. */
  token: z.string().min(1),
  /** Epoch milliseconds the claim was made. */
  at: z.number().int().nonnegative(),
});

type Claim = z.output<typeof ClaimSchema>;

export interface FleetApplyLockOptions {
  /** How long to wait for the holder to finish before refusing. */
  readonly waitMs?: number;
  readonly pollMs?: number;
  /** Liveness check for a claim's owner. Diagnostic only — it never authorises a takeover. */
  readonly isOwnerAlive?: (owner: number) => boolean;
  readonly now?: () => number;
}

const DEFAULT_WAIT_MS = 60 * 1000;
const DEFAULT_POLL_MS = 25;

function defaultIsOwnerAlive(owner: number): boolean {
  try {
    globalThis.process.kill(owner, 0);
    return true;
  } catch (error) {
    // Not permitted to signal it means it belongs to someone else and is very much alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class FleetApplyLock {
  private readonly waitMs: number;
  private readonly pollMs: number;
  private readonly isOwnerAlive: (owner: number) => boolean;
  private readonly now: () => number;

  constructor(
    private readonly lockPath: string,
    options: FleetApplyLockOptions = {},
  ) {
    this.waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.isOwnerAlive = options.isOwnerAlive ?? defaultIsOwnerAlive;
    this.now = options.now ?? Date.now;
  }

  /** Run `work` with the fleet held exclusively, releasing this claim however it ends. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    const token = await this.acquire();
    try {
      return await work();
    } finally {
      await this.release(token);
    }
  }

  private async acquire(): Promise<string> {
    const deadline = this.now() + this.waitMs;
    let lastFailure = '';
    for (;;) {
      const token = randomUUID();
      const failure = await this.claim(token);
      if (failure === undefined) return token;
      lastFailure = failure;
      if (this.now() >= deadline) throw new Error(await this.refusal(lastFailure));
      await new Promise(resolve => setTimeout(resolve, this.pollMs));
    }
  }

  /**
   * Publish a fully-formed claim under a name nobody holds. Returns why it could not be taken, or
   * `undefined` once it is held.
   */
  private async claim(token: string): Promise<string | undefined> {
    const directory = path.dirname(this.lockPath);
    // A first run has no fleet directory yet, and the claim has to precede whatever creates it.
    await mkdir(directory, { recursive: true });
    const staged = path.join(directory, `.fy-fleet-apply.${randomUUID()}.claim`);
    const claim: Claim = { owner: globalThis.process.pid, token, at: this.now() };
    // Both halves sit inside the cleanup, so a write that fails after the exclusive create leaves
    // no half-formed claim behind for the next attempt to trip over.
    try {
      await writeFile(staged, `${JSON.stringify(claim)}\n`, { flag: 'wx', mode: 0o600 });
      await link(staged, this.lockPath);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      await rm(staged, { force: true });
    }
  }

  /** Say exactly what is holding the fleet, so a person can act on it without guessing. */
  private async refusal(lastFailure: string): Promise<string> {
    const held = await this.readClaim();
    if (held === undefined) {
      return `another fleet apply holds ${this.lockPath} and its claim could not be read; remove that file once no apply is running (${lastFailure})`;
    }
    const liveness = this.isOwnerAlive(held.owner)
      ? 'that owner is still running'
      : 'that owner is no longer running, so the claim was abandoned and this file can be removed';
    return `another fleet apply holds ${this.lockPath}, claimed by owner ${held.owner} at ${new Date(held.at).toISOString()}; ${liveness}`;
  }

  /** Release only while this exact claim is still the one present. */
  private async release(token: string): Promise<void> {
    const current = await this.readClaim();
    if (current?.token !== token) return;
    await rm(this.lockPath, { force: true });
  }

  private async readClaim(): Promise<Claim | undefined> {
    let document: string;
    try {
      document = await readFile(this.lockPath, 'utf8');
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(document);
    } catch {
      return undefined;
    }
    const claim = ClaimSchema.safeParse(parsed);
    return claim.success ? claim.data : undefined;
  }
}
