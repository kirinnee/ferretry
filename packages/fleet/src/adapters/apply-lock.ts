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
import { link, mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
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

/**
 * The claim that guards one fleet, named the one way every caller agrees on.
 *
 * Derived from the manifest rather than from a caller's declared roots, because those differ: one
 * composition root declares the state home and another the fleet directory inside it, so a claim
 * keyed on them would give each its own lock and serialize nothing.
 */
export function fleetApplyLockFor(manifestPath: string, options: FleetApplyLockOptions = {}): FleetApplyLock {
  return new FleetApplyLock(path.join(path.dirname(path.resolve(manifestPath)), '.fy-fleet-apply.lock'), options);
}

export class FleetApplyLock {
  private readonly waitMs: number;
  private readonly pollMs: number;
  private readonly isOwnerAlive: (owner: number) => boolean;
  private readonly now: () => number;
  /** Whether taking this claim is what brought the fleet directory into existence. */
  private created: boolean | undefined;

  constructor(
    private readonly lockPath: string,
    options: FleetApplyLockOptions = {},
  ) {
    this.waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.isOwnerAlive = options.isOwnerAlive ?? defaultIsOwnerAlive;
    this.now = options.now ?? Date.now;
  }

  /** Where this claim lives, so a caller can hold it to the same containment as its other writes. */
  get path(): string {
    return this.lockPath;
  }

  async acquire(): Promise<string> {
    try {
      return await this.claimUntil(this.now() + this.waitMs);
    } catch (error) {
      // Nothing was returned, so nobody will ever call release for this attempt. A fleet directory
      // this attempt brought into existence has to go back now, or a host that has never had a
      // fleet is left looking as though it has one.
      if (this.created === true) await this.removeIfEmpty(path.dirname(this.lockPath));
      throw error;
    }
  }

  private async claimUntil(deadline: number): Promise<string> {
    for (;;) {
      const token = randomUUID();
      // Only a name already taken is contention. Anything else — a permission problem, a read-only
      // filesystem — is an operational failure, and looping on it until a timeout would report
      // "another apply holds the lock" about a lock nobody holds.
      if (await this.claim(token)) return token;
      if (this.now() >= deadline) throw new Error(await this.refusal());
      await new Promise(resolve => setTimeout(resolve, this.pollMs));
    }
  }

  /**
   * Publish a fully-formed claim under a name nobody holds. Returns why it could not be taken, or
   * `undefined` once it is held.
   */
  /** True once the claim is held. False means the name is taken; anything else throws. */
  private async claim(token: string): Promise<boolean> {
    const directory = path.dirname(this.lockPath);
    // A first run has no fleet directory yet, and the claim has to precede whatever creates it.
    // Whether this call is what brought it into existence is remembered, so a first run that never
    // gets a token does not leave a fleet directory the host never had.
    this.created ??= await this.ensureDirectory(directory);
    const staged = path.join(directory, `.fy-fleet-apply.${randomUUID()}.claim`);
    const claim: Claim = { owner: globalThis.process.pid, token, at: this.now() };
    // Staging and publishing are caught separately. An `EEXIST` from the staged write means the
    // private name was somehow taken — never contention for the lock — and treating it as such
    // would both misreport it and, in the cleanup below, delete a file this attempt did not make.
    await writeFile(staged, `${JSON.stringify(claim)}\n`, { flag: 'wx', mode: 0o600 });

    let held = false;
    try {
      await link(staged, this.lockPath);
      held = true;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    } finally {
      // Only ever the file this attempt created, and tidying it must never undo a claim that
      // succeeded: throwing here would lose the token the caller needs to release the lock.
      await this.forget(staged, held);
    }
  }

  private async forget(staged: string, held: boolean): Promise<void> {
    try {
      await rm(staged, { force: true });
    } catch (error) {
      if (!held) throw error;
      // The claim is held and the caller must learn its token; a leftover staged copy is inert.
    }
  }

  /** Create the directory when absent, and report whether this call is what created it. */
  private async ensureDirectory(directory: string): Promise<boolean> {
    const first = await mkdir(directory, { recursive: true });
    return first !== undefined;
  }

  /** Say exactly what is holding the fleet, so a person can act on it without guessing. */
  private async refusal(): Promise<string> {
    const held = await this.readClaim();
    if (held === undefined) {
      return `another fleet apply holds ${this.lockPath} and its claim could not be read; remove that file once no apply is running`;
    }
    const liveness = this.livenessOf(held.owner);
    return `another fleet apply holds ${this.lockPath}, claimed by owner ${held.owner} at ${new Date(held.at).toISOString()}; ${liveness}`;
  }

  /**
   * How to describe the holder.
   *
   * A claim naming *this* task is a leak, not a live apply: this task is the one waiting, so it is
   * demonstrably not the one holding. Reporting it as live would tell a person the daemon they are
   * looking at is busy and advise them against clearing the only thing blocking every apply.
   */
  private livenessOf(owner: number): string {
    if (owner === globalThis.process.pid) {
      return 'that is this very task, so the claim was left behind by an earlier apply and this file can be removed';
    }
    return this.isOwnerAlive(owner)
      ? 'that owner is still running'
      : 'that owner is no longer running, so the claim was abandoned and this file can be removed';
  }

  /**
   * Release this claim, and report the lock path when the release could not be verified.
   *
   * It never throws, because it runs after the work it protected: a failure to tidy up a lock file
   * must not replace the apply's own outcome — a committed fleet reported as an unrelated
   * filesystem error is worse than a stale lock, and the caller would lose the only account of what
   * happened to the host. The residue travels back as a value instead, so the outcome keeps its
   * classification *and* says what was left behind.
   */
  async release(token: string): Promise<string | undefined> {
    try {
      const current = await this.readClaim();
      // Unreadable is not "somebody else's". Nothing here ever takes a lock over, so while this
      // holder is running no other claim can legitimately occupy the name — leaving an unreadable
      // one behind would block every future apply, and the refusal would name this very daemon as
      // the live owner and advise against clearing it.
      // A readable claim that is not this one means this holder was superseded: its lock is still
      // on disk and it must not unlink a successor's. That is residue either way — reporting no
      // residue would tell the apply the fleet is free when a claim is sitting there.
      if (current !== undefined && current.token !== token) return this.lockPath;
      await rm(this.lockPath, { force: true });
      // A directory this claim created, and which the apply then left empty, is a directory the
      // host did not have before — leaving it behind would make a rolled-back first run visible.
      if (this.created === true) await this.removeIfEmpty(path.dirname(this.lockPath));
      return undefined;
    } catch {
      return this.lockPath;
    }
  }

  private async removeIfEmpty(directory: string): Promise<void> {
    try {
      await rmdir(directory);
    } catch {
      // Not empty, or not ours to remove. Either way the apply put something there and it stays.
    }
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
