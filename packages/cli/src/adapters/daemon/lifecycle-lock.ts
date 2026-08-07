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
 * **Nothing is ever taken over automatically, and the honest reason is the liveness verdict, not the
 * primitives.** The two primitives below would reclaim safely: `unlink` of a claim file by exact name
 * followed by `rmdir` can only ever fail against a successor, never destroy one. What cannot be
 * trusted is `alive(owner)`. A pid is meaningful only inside its own namespace, so an owner running in
 * a container, a different namespace, or under another user can be reported dead while it is very much
 * alive — and a reaper acting on that verdict would unlink a LIVE holder's proof and let a second
 * invocation in, which is the interleaving this whole file exists to prevent, produced by the code
 * meant to recover from it. A false "still running" only delays somebody; a false "no longer running"
 * corrupts a lifecycle.
 *
 * **The cost of that choice is real and is not argued away.** The caller supplies a wait budget for
 * EACH claim and may acquire an ordered set of them. A crash, an OOM kill or a power loss can therefore
 * leave one or more claim directories that block every mutating verb for that daemon until a person
 * independently rules out a live holder and removes EACH one. The controller and layout own the exact
 * budget and claim count; the durable handover records their current 140-second/four-claim policy. On
 * an unattended host that is a daemon that cannot be restarted remotely. What keeps it a recoverable
 * failure rather than a silent one: each refusal names one claim, the verb that was running, its owner,
 * whether that owner is visible from this invocation's PID namespace, the limits of that observation
 * and the exact directory involved. A retry may expose the next residue, while `status`, `logs` and
 * `snapshot list` stay unserialized so everything needed to diagnose it keeps working.
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
   * Whether the holder is visible from this invocation's PID namespace.
   *
   * Even numeric equality with this invocation's pid is not identity proof: two PID namespaces can
   * assign the same number to different live processes sharing this filesystem. Every positive answer
   * therefore delays in the safe direction, while a negative answer is explicitly reported as
   * inconclusive and never authorises reclaim by itself.
   */
  #liveness(owner: number): string {
    return this.processes.alive(owner)
      ? 'that owner is still running'
      : "that owner is not visible from this invocation's PID namespace; it may still be running in another namespace or as another user, so verify independently that no lifecycle command is running before removing the claim";
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
