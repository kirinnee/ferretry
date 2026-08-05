/**
 * An exclusive lock over one fleet directory, held across separate invocations.
 *
 * Two applies that overlap capture each other's writes as "the state before", so their rollbacks
 * undo one another and neither report is true. An in-memory queue only orders the applies made
 * through one object; the command-line tool and the daemon are different invocations entirely, and
 * the fleet they contend for is a directory, so the claim has to live in that directory too.
 *
 * **A claim is a small directory, and every operation on it carries its own proof.** It is built
 * complete under a private name — a directory holding one file named after an unguessable token —
 * and published by renaming it onto the lock's name. Renaming onto an occupied name is refused, so
 * an existing claim is never replaced, and a claim is never observed half-written. An *empty*
 * directory left on the name is residue rather than a claim, and is taken over explicitly — see
 * `claim` — rather than by relying on POSIX rename-over-an-empty-directory, which Windows lacks.
 *
 * The shape is chosen for the *release*, though. A lock that is a single file can only be released
 * by reading it, deciding it is ours, and deleting it — and that decision is stale the instant it is
 * made, so a claim cleared by a person and re-taken by a successor in the gap gets deleted by the
 * holder that was superseded. A directory releases without any such decision: unlink the token file,
 * whose name only this holder can know, then `rmdir` the directory, which the kernel refuses unless
 * it is empty. Neither call can reach a successor's claim, and neither depends on anything that was
 * true a moment ago.
 *
 * **Nothing is ever taken over automatically, and that is the deliberate choice.** Reclaiming an
 * abandoned claim needs an atomic compare-and-replace that a filesystem does not offer: a reaper
 * that reads a dead claim, then renames it, can move a live successor's claim instead — the claim
 * it read is not the claim it moves — and a third contender can take the name it just freed. The
 * result is exactly the double apply the lock exists to prevent, arrived at by the code meant to
 * protect it. So a claim is only ever released by the holder that made it, proven by a random token
 * that has to still be present. A holder that dies leaves its claim behind; the refusal then names
 * the claim, its owner, and whether that owner is still running, and a person removes it. That is a
 * worse failure to *recover* from and a much better one to *have*.
 *
 * The crash semantics this implies are the honest ones and are not claimed away: an apply
 * interrupted by a killed task leaves both its lock and its moved-aside evidence on disk.
 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/** Basename prefix of the token file that is a holder's sole proof of owning a claim. */
const CLAIM_PREFIX = 'claim-';

/** Basename prefix of a claim being built, before it is published under the lock's name. */
const STAGED_CLAIM_PREFIX = '.fy-fleet-apply.';

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Whether a publication failed because the lock name is already held.
 *
 * Renaming a directory onto a non-empty one is refused, and which code says so is the platform's
 * choice: Linux reports `ENOTEMPTY`, others `EEXIST`. `ENOTDIR` is the same answer in a different
 * shape — a regular file is sitting there, which is what a claim written by an older release looks
 * like — and it is contention too: something holds the name and this attempt must not remove it.
 */
function isNameTaken(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOTDIR';
}

const ClaimSchema = z.strictObject({
  /** Identifier of the running task that made the claim, reported for recovery. */
  owner: z.number().int().positive(),
  /** Unguessable per-claim value, so a holder can prove a lock is still the one it took. */
  token: z.string().min(1),
  /** Epoch milliseconds the claim was made. */
  at: z.number().int().nonnegative(),
});

type Claim = z.output<typeof ClaimSchema>;

/**
 * What is actually sitting at the lock path.
 *
 * `absent` and `unreadable` are kept apart because the two demand opposite actions. Collapsing them
 * into one "no claim I can identify" made a release unlink whatever was there: a holder that had
 * been superseded — its stale claim cleared by a person, as the refusal invites, and the name then
 * taken by somebody new — would delete the successor's claim if that successor's file could not be
 * read for any reason. Absent means there is nothing to remove; unreadable means there is something
 * there and no proof it is ours, which is exactly when to leave it alone and say so.
 */
type ClaimState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'held'; readonly claim: Claim };

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
  /**
   * Whether taking the claim is what brought the fleet directory into existence.
   *
   * Per *acquisition*, not per object. One lock is reused across applies, and the first run's
   * cleanup can remove the fleet directory again — so a value carried over from an earlier
   * acquisition would both skip the creation the next one needs and misreport who made it.
   */
  private created = false;

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
    // Fresh for this acquisition: what an earlier one created it has already accounted for.
    this.created = false;
    try {
      return await this.claimUntil(this.now() + this.waitMs);
    } catch (error) {
      // Nothing was returned, so nobody will ever call release for this attempt. A fleet directory
      // this attempt brought into existence has to go back now, or a host that has never had a
      // fleet is left looking as though it has one.
      if (this.created) await this.removeIfEmpty(path.dirname(this.lockPath));
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

  /** Where this claim's own proof of ownership lives. Named by the token, so nobody else has it. */
  private tokenPath(token: string): string {
    return path.join(this.lockPath, `${CLAIM_PREFIX}${token}.json`);
  }

  /** True once the claim is held. False means the name is taken; anything else throws. */
  private async claim(token: string): Promise<boolean> {
    const directory = path.dirname(this.lockPath);
    // A first run has no fleet directory yet, and the claim has to precede whatever creates it.
    // Asked on every attempt rather than remembered across them: a lock object outlives one apply,
    // and the previous acquisition's cleanup may have taken the directory away again. Whether any
    // attempt in *this* acquisition created it is what accumulates, so a first run that never gets
    // a token does not leave a fleet directory the host never had.
    if (await this.ensureDirectory(directory)) this.created = true;
    const staged = path.join(directory, `${STAGED_CLAIM_PREFIX}${randomUUID()}`);
    const claim: Claim = { owner: globalThis.process.pid, token, at: this.now() };
    // Built complete under a private name, then published in one move. Staging and publishing are
    // caught separately: a failure here is never contention for the lock, and misreporting it as
    // contention would also make the cleanup below delete something this attempt did not make.
    await mkdir(staged, { mode: 0o700 });
    try {
      await writeFile(path.join(staged, `${CLAIM_PREFIX}${token}.json`), `${JSON.stringify(claim)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      // An *empty* directory on the name is not a claim — a claim is published whole, in one
      // rename, so it is never observed empty — it is residue from an interrupted release, and
      // refusing it would leave every future apply blocked by nothing at all. It is cleared
      // explicitly rather than by letting `rename` replace it, which works on POSIX and not on
      // Windows: doing it here makes the publication mean the same thing everywhere. `rmdir` is the
      // guard and it is atomic, so if a claim occupies the name — always non-empty — this removes
      // nothing, and a successor who publishes between it and the rename below simply wins.
      await this.removeIfEmpty(this.lockPath);
      // A published claim always holds its token file, so the name is now either free or occupied by
      // something this attempt must not disturb. Renaming onto an occupied name is refused.
      await rename(staged, this.lockPath);
      return true;
    } catch (error) {
      if (isNameTaken(error)) return false;
      throw error;
    } finally {
      // A successful publication moved this name away, so the removal finds nothing. It never
      // touches a claim: the name is private to this attempt.
      await rm(staged, { recursive: true, force: true });
    }
  }

  /** Create the directory when absent, and report whether this call is what created it. */
  private async ensureDirectory(directory: string): Promise<boolean> {
    const first = await mkdir(directory, { recursive: true });
    return first !== undefined;
  }

  /** Say exactly what is holding the fleet, so a person can act on it without guessing. */
  private async refusal(): Promise<string> {
    const state = await this.readClaim();
    // The claim was released between the last attempt and this read. Saying it could not be read
    // would send a person looking for a file that is not there; the honest answer is to try again.
    if (state.kind === 'absent') {
      return `could not take ${this.lockPath} before the deadline, and the claim is now gone; run the apply again`;
    }
    if (state.kind === 'unreadable') {
      return `another fleet apply holds ${this.lockPath} and its claim could not be read; remove that directory once no apply is running`;
    }
    const held = state.claim;
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
      return 'that is this very task, so the claim was left behind by an earlier apply and it can be removed';
    }
    return this.isOwnerAlive(owner)
      ? 'that owner is still running'
      : 'that owner is no longer running, so the claim was abandoned and it can be removed';
  }

  /**
   * Release this claim, and report the lock path when the release could not be verified.
   *
   * **Nothing here reads the lock and then acts on what it read.** That shape cannot be made safe:
   * between deciding "this claim is mine" and removing it, a person can clear the claim and a
   * successor can take the name, and the removal then deletes theirs — the double apply the lock
   * exists to prevent, produced by the code releasing it. Every check that could authorise a delete
   * is stale the moment it is made.
   *
   * So the release is two primitives that each carry their own proof:
   *
   * 1. `unlink` of this claim's **own token file**. The name contains a value only this holder has,
   *    so it can only ever name this holder's proof. A successor's claim is a different name in a
   *    different directory and is untouchable by this call.
   * 2. `rmdir` of the claim directory. It removes only an *empty* directory, and a published claim
   *    is never empty. So if a successor has already taken the freed name, this fails instead of
   *    deleting their claim — the emptiness check and the removal are one operation in the kernel,
   *    which is exactly what a read followed by a delete could never be.
   *
   * It never throws, because it runs after the work it protected: a failure to tidy up must not
   * replace the apply's own outcome — a committed fleet reported as an unrelated filesystem error is
   * worse than a stale lock, and the caller would lose the only account of what happened to the
   * host. The residue travels back as a value instead.
   */
  async release(token: string): Promise<string | undefined> {
    try {
      try {
        await unlink(this.tokenPath(token));
      } catch (error) {
        if (!isMissing(error)) return this.lockPath;
        // This holder's proof is not there, so it holds nothing and has nothing to remove. Whatever
        // occupies the name now — a successor's claim, or nothing at all — is not its business.
        return (await this.claimExists()) ? this.lockPath : undefined;
      }
      // Only an empty directory goes, so a successor who took the freed name in the meantime is
      // safe. If something is still in there, what it is decides whether anybody needs to know.
      // Both a successor's claim and an empty name mean nothing of this holder's is left: `held` is
      // somebody else's business, and `absent` is the removal having raced a contender who cleared
      // the directory first — reporting either as residue would have a caller told the fleet is
      // blocked by a lock nobody holds. Only something unreadable will block the next apply and has
      // to be named. That read describes; it never authorises a removal.
      if (!(await this.removeIfEmpty(this.lockPath))) {
        return (await this.readClaim()).kind === 'unreadable' ? this.lockPath : undefined;
      }
      // A directory this claim created, and which the apply then left empty, is a directory the
      // host did not have before — leaving it behind would make a rolled-back first run visible.
      if (this.created) await this.removeIfEmpty(path.dirname(this.lockPath));
      return undefined;
    } catch {
      return this.lockPath;
    }
  }

  /**
   * Whether anything at all occupies the lock name, asked only to describe, never to authorise.
   *
   * Only `ENOENT` is absence. Any other failure — a permission change, an ancestor that stopped
   * being a directory — means the name could not be looked at, not that nothing is there, and
   * answering "nothing" would have a release report a free fleet while a claim still blocks every
   * later apply. The same reasoning `readClaim` applies to a directory it cannot list.
   */
  private async claimExists(): Promise<boolean> {
    try {
      await lstat(this.lockPath);
      return true;
    } catch (error) {
      return !isMissing(error);
    }
  }

  /** True once the directory is gone. `rmdir` refuses a non-empty one, which is the whole guard. */
  private async removeIfEmpty(directory: string): Promise<boolean> {
    try {
      await rmdir(directory);
      return true;
    } catch {
      // Not empty, or not ours to remove. Either way something is there and it stays.
      return false;
    }
  }

  private async readClaim(): Promise<ClaimState> {
    let names: string[];
    try {
      names = await readdir(this.lockPath);
    } catch (error) {
      // Only a missing directory is `absent`. A permission failure, or a regular file sitting where
      // the claim directory belongs — a claim left by an older release — means something is there
      // that this call cannot read, and calling that "nothing" would licence removing it.
      return isMissing(error) ? { kind: 'absent' } : { kind: 'unreadable' };
    }
    // Only the exact shape this code publishes counts as a claim: one entry, and nothing else in
    // the directory. Anything extra is not a claim somebody holds — it is something that will make
    // every future publication fail — and calling it `held` would let a release report a clean
    // handover while leaving the fleet blocked.
    const [name] = names;
    if (names.length !== 1 || name === undefined || !name.startsWith(CLAIM_PREFIX)) {
      return { kind: 'unreadable' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.join(this.lockPath, name), 'utf8'));
    } catch {
      return { kind: 'unreadable' };
    }
    const claim = ClaimSchema.safeParse(parsed);
    if (!claim.success) return { kind: 'unreadable' };
    // The filename is the holder's proof and the document is what gets reported. If they disagree,
    // the pair was not published by this code, and the release that trusts the name would be
    // unlinking on the strength of a document that names somebody else.
    if (name !== `${CLAIM_PREFIX}${claim.data.token}.json`) return { kind: 'unreadable' };
    return { kind: 'held', claim: claim.data };
  }
}
