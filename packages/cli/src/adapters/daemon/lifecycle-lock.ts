/**
 * The claim that serializes one daemon's mutating lifecycle commands across separate invocations.
 *
 * Two `fy daemon` runs are unrelated to each other, so ordering them inside one object orders nothing:
 * a second invocation could write the service definition between the first one's root reconciliation
 * and its own definition write, leaving a unit that names snapshot A while the roots hold B's closure.
 * The thing they contend for is identified by a path, so the claim lives at a path too.
 *
 * **A claim is a small directory, and every operation on it carries its own proof.** It is built
 * complete under a private name — a directory holding one file named after an unguessable token — and
 * published by renaming it onto the lock's name. Renaming onto an occupied name is refused, so an
 * existing claim is never replaced and a claim is never observed half-written. An *empty* directory on
 * the name is residue from an interrupted release rather than a claim, and is cleared explicitly with
 * `rmdir` — atomic, and unable to touch a real claim, which is never empty.
 *
 * The shape is chosen for the *release*. A lock that is one file can only be released by reading it,
 * deciding it is ours, and deleting it — and that decision is stale the instant it is made, so a claim
 * cleared by a person and re-taken by a successor in the gap gets deleted by the holder that was
 * superseded. A directory releases with no such decision: unlink the token file, whose name only this
 * holder knows, then `rmdir`, which the kernel refuses unless the directory is empty.
 *
 * **Nothing is ever taken over automatically, and that is deliberate.** Reclaiming an abandoned claim
 * needs an atomic compare-and-replace a filesystem does not offer: a reaper that reads a dead claim
 * and then renames it can move a live successor's claim instead. So a crashed lifecycle command leaves
 * its claim behind, the refusal names the claim, the verb that was running, its owner and whether that
 * owner is still alive, and a person removes it. That is a worse failure to recover from and a much
 * better one to have — and it costs nothing a person cannot see, because `status` and `logs` are not
 * serialized and keep working throughout.
 *
 * Modelled on `FleetApplyLock` in `@ferretry/fleet`, whose docblock argues the same design at length.
 * It is not reused: that lock guards a fleet directory, derives its path from the fleet manifest and
 * refuses in the vocabulary of `fy fleet apply`, so borrowing it would tell an operator waiting on a
 * daemon restart to re-run an apply they never started.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type {
  DaemonLifecycleClaimRequest,
  IClockPort,
  IDaemonLifecycleClaim,
  IDaemonLifecycleLockPort,
  IDaemonProcessPort,
} from '../../lib/daemon/ports.ts';

/** Basename prefix of the token file that is a holder's sole proof of owning a claim. */
const CLAIM_PREFIX = 'claim-';
/** Basename prefix of a claim being built, before it is published under the lock's name. */
const STAGED_PREFIX = '.fy-daemon-lifecycle.';
const DEFAULT_POLL_MS = 50;

const ClaimSchema = z.strictObject({
  /** The invocation holding it, reported so a person can see whether it is still running. */
  owner: z.number().int().positive(),
  /** Unguessable per-claim value: a holder's only proof that the claim is still the one it took. */
  token: z.string().min(1),
  /** Which lifecycle verb is running, so a refusal names what is being waited for. */
  verb: z.string().min(1),
  /** Epoch milliseconds the claim was made. */
  at: z.number().int().nonnegative(),
});

type Claim = z.output<typeof ClaimSchema>;

export class DaemonLifecycleBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonLifecycleBusyError';
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/**
 * Whether a publication failed because the name is already occupied.
 *
 * Renaming a directory onto a non-empty one is refused, and which code says so is the platform's
 * choice: Linux reports `ENOTEMPTY`, others `EEXIST`. `ENOTDIR` is the same answer in a different
 * shape — a regular file is sitting there — and it is contention too: something holds the name and
 * this attempt must not remove it.
 */
function isNameTaken(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOTDIR';
}

export interface DaemonLifecycleLockOptions {
  /** How often to re-attempt while a peer holds the claim. */
  readonly pollMs?: number;
}

export class FileDaemonLifecycleLock implements IDaemonLifecycleLockPort {
  private readonly pollMs: number;

  constructor(
    private readonly processes: IDaemonProcessPort,
    private readonly clock: IClockPort,
    options: DaemonLifecycleLockOptions = {},
  ) {
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  }

  async acquire(request: DaemonLifecycleClaimRequest): Promise<IDaemonLifecycleClaim> {
    const deadline = this.clock.now() + request.waitMs;
    let announced = false;
    for (;;) {
      const token = randomUUID();
      // Only an occupied name is contention. Anything else — a permission problem, a read-only
      // filesystem — is an operational failure, and looping on it until the deadline would report
      // "another lifecycle command holds this" about a claim nobody holds.
      if (await this.#claim(request, token)) return { release: () => this.#release(request.lockPath, token) };
      if (this.clock.now() >= deadline) throw new DaemonLifecycleBusyError(await this.#refusal(request));
      if (!announced) {
        announced = true;
        request.waiting(await this.#holder(request.lockPath));
      }
      await this.clock.sleep(this.pollMs);
    }
  }

  /** True once the claim is held. False means the name is taken; anything else throws. */
  async #claim(request: DaemonLifecycleClaimRequest, token: string): Promise<boolean> {
    const directory = dirname(request.lockPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const staged = join(directory, `${STAGED_PREFIX}${randomUUID()}`);
    const claim: Claim = {
      owner: globalThis.process.pid,
      token,
      verb: request.verb,
      at: this.clock.now(),
    };
    // Built complete under a private name, then published in one move. A failure to stage is never
    // contention for the claim, and reporting it as contention would also make the cleanup below
    // remove something this attempt did not create.
    await mkdir(staged, { mode: 0o700 });
    try {
      await writeFile(join(staged, `${CLAIM_PREFIX}${token}.json`), `${JSON.stringify(claim)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      // Residue is cleared explicitly rather than by relying on POSIX rename-over-an-empty-directory,
      // which Windows lacks, so publication means the same thing everywhere. `rmdir` removes only an
      // empty directory, so a real claim survives it and a successor who publishes in the gap wins.
      await rmdir(request.lockPath).catch(() => undefined);
      await rename(staged, request.lockPath);
      return true;
    } catch (error) {
      // Only an occupied name is contention; a permission problem or a read-only filesystem is an
      // operational failure, and reporting it as contention would wait out the deadline and then
      // blame a claim nobody holds.
      if (!isNameTaken(error)) throw error;
      return false;
    } finally {
      // A successful publication moved this name away, so this removes nothing. It can never reach a
      // claim: the staged name is private to this attempt.
      await rm(staged, { recursive: true, force: true });
    }
  }

  /**
   * Give up this claim, and report what is left behind when the release cannot be verified.
   *
   * **Nothing here reads the claim and then acts on what it read.** That shape cannot be made safe:
   * between deciding "this claim is mine" and removing it, a person can clear it and a successor can
   * take the name, and the removal then deletes theirs — the interleaving the claim exists to prevent,
   * produced by the code releasing it. So the release is two primitives that each carry their own
   * proof: `unlink` of a file only this holder can name, and `rmdir`, which the kernel refuses unless
   * the directory is empty, and a published claim never is.
   *
   * It never throws, because it runs after the work it protected: a daemon that started perfectly,
   * reported as a filesystem error, is worse than a claim left on disk.
   */
  async #release(lockPath: string, token: string): Promise<string | undefined> {
    const mine = `${CLAIM_PREFIX}${token}.json`;
    await unlink(join(lockPath, mine)).catch(() => undefined);
    // An already-absent claim is released: a person clearing it while the work ran is exactly what the
    // refusal invites them to do, and calling that residue would send them back to look at nothing.
    const removed = await rmdir(lockPath).then(
      () => true,
      error => errorCode(error) === 'ENOENT',
    );
    if (removed) return undefined;
    // Something still occupies the name. A successor's claim is not this holder's business; this
    // holder's own leftover proof, or anything else, will block the next lifecycle command and has to
    // be named. That read describes; it never authorises a removal.
    const names = await readdir(lockPath).catch(() => undefined);
    if (names === undefined) return lockPath;
    return names.some(name => name !== mine && name.startsWith(CLAIM_PREFIX)) ? undefined : lockPath;
  }

  async #refusal(request: DaemonLifecycleClaimRequest): Promise<string> {
    const seconds = String(Math.round(request.waitMs / 1_000));
    return (
      `another daemon lifecycle command still holds ${request.lockPath} after ${seconds}s, so ${request.verb} ` +
      `was refused rather than run beside it — ${await this.#holder(request.lockPath)}`
    );
  }

  /**
   * How to describe whatever holds the name, for a wait notice and a refusal alike.
   *
   * An unreadable claim and a claim that has just been released are reported as one thing on purpose.
   * Telling them apart needs an observation a filesystem cannot give atomically — the name can change
   * between the failed publication and this read — and both answers lead a person to the same two
   * actions: try again, and clear the directory if it is still there with nothing running.
   */
  async #holder(lockPath: string): Promise<string> {
    const claim = await this.#readClaim(lockPath);
    if (claim === undefined) {
      return `its claim could not be read, so it may have been released in the meantime; run the command again, and remove ${lockPath} once no lifecycle command is running`;
    }
    return `held by ${claim.verb} (owner ${String(claim.owner)}, since ${new Date(claim.at).toISOString()}): ${this.#liveness(claim.owner)}`;
  }

  /**
   * Whether the holder is still working.
   *
   * A claim naming *this* invocation is a leak, not a live peer: this invocation is the one waiting, so
   * it is demonstrably not the one holding. Reporting it as live would advise a person against clearing
   * the only thing blocking every lifecycle command on the host.
   */
  #liveness(owner: number): string {
    if (owner === globalThis.process.pid) {
      return 'that is this very invocation, so an earlier command left the claim behind and it can be removed';
    }
    return this.processes.alive(owner)
      ? 'that owner is still running'
      : 'that owner is no longer running, so the claim was abandoned and it can be removed';
  }

  /**
   * The claim on the name, or `undefined` when there is nothing this code could have published.
   *
   * Only the exact shape published above counts. The filename is the holder's proof and the document
   * is what gets reported, so a pair that disagrees was not published here and is not described as if
   * it were.
   */
  async #readClaim(lockPath: string): Promise<Claim | undefined> {
    const names = await readdir(lockPath).catch(() => [] as string[]);
    const name = names.find(candidate => candidate.startsWith(CLAIM_PREFIX));
    if (name === undefined) return undefined;
    const document = await readFile(join(lockPath, name), 'utf8')
      .then(contents => JSON.parse(contents) as unknown)
      .catch(() => undefined);
    const parsed = ClaimSchema.safeParse(document);
    if (!parsed.success) return undefined;
    return name === `${CLAIM_PREFIX}${parsed.data.token}.json` ? parsed.data : undefined;
  }
}
