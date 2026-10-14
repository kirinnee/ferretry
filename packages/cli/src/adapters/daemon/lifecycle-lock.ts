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
 * **A claim is taken over automatically only when its holder has PROVABLY exited, and the proof is
 * the hard part, not the primitives.** The two primitives below reclaim safely: `unlink` of a claim
 * file by exact name followed by `rmdir` can only ever fail against a successor, never destroy one.
 * What cannot be trusted is `alive(owner)` on its own. A pid is meaningful only inside its own boot
 * and PID namespace, and it is reused once its process exits, so an owner in a container sharing this
 * filesystem can be reported dead while it is very much alive — and a reaper acting on that verdict
 * would unlink a LIVE holder's proof and let a second invocation in, which is the interleaving this
 * whole file exists to prevent, produced by the code meant to recover from it. A false "still
 * running" only delays somebody; a false "no longer running" corrupts a lifecycle.
 *
 * So a claim records WHICH process its owner is — the boot and PID namespace the number was issued
 * in, and that process's start time (`process-incarnation.ts`). An observer in the same scope can
 * then prove the holder exited: no such process, or one that started at a different moment and merely
 * inherited the number. A claim from an earlier boot is abandoned wherever it is read. That is the
 * case that used to cost every operator a 140-second wait and a refusal that blamed "another PID
 * namespace" for a `fy daemon start` that had simply been killed: it is now removed at once, and said
 * so. Everything else — a holder in another namespace, a claim an older release wrote, a host that
 * cannot tell — keeps the conservative answer below.
 *
 * **The cost of that conservative answer is real and is not argued away.** The caller supplies a
 * wait budget for EACH claim and may acquire an ordered set of them. A holder this invocation cannot
 * prove dead can leave one or more claim directories that block every mutating verb for that daemon
 * until a person independently rules out a live holder and removes EACH one. The controller and
 * layout own the exact budget and claim count; the durable handover records their current
 * 140-second/four-claim policy. What keeps it a recoverable failure rather than a silent one: each
 * refusal names one claim, the verb that was running, its owner, what can and cannot be said about
 * that owner from here, and the exact directory involved. A retry may expose the next residue, while
 * `status`, `logs` and `snapshot list` stay unserialized so everything needed to diagnose it keeps
 * working.
 *
 * Modelled on `FleetApplyLock` in `@ferretry/fleet`, whose docblock argues the same design at length.
 * It is not reused: that lock guards a fleet directory, derives its path from the fleet manifest and
 * refuses in the vocabulary of a fleet apply, so borrowing it would tell an operator waiting on a
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
import type { IProcessIncarnationPort } from './process-incarnation.ts';

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
  /**
   * WHICH PROCESS `owner` IS: the scope its number was issued in, and when that process started.
   *
   * Optional, because a host that offers neither source writes none and an older release wrote none,
   * and either claim is still a claim. Without it a holder that died can only ever be reported, never
   * recognised; with it, an observer in the same scope can prove the holder exited.
   */
  holder: z
    .strictObject({ boot: z.string().min(1), namespace: z.string().min(1), start: z.string().min(1) })
    .optional(),
});

type Claim = z.output<typeof ClaimSchema>;

/**
 * What can be said about a claim's holder from here.
 *
 * `gone` is the only verdict that authorises anything, and it is reached only inside a scope where the
 * observation is authoritative — the holder's own boot and PID namespace — or from a different boot,
 * which no process survives.
 */
type HolderVerdict = 'running' | 'gone' | 'elsewhere' | 'unknown';

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
    private readonly incarnations: IProcessIncarnationPort,
    private readonly clock: IClockPort,
    options: DaemonLifecycleLockOptions = {},
  ) {
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  }

  async acquire(request: DaemonLifecycleClaimRequest): Promise<IDaemonLifecycleClaim> {
    const deadline = this.clock.now() + request.waitMs;
    let announced = false;
    // Each abandoned claim is removed at most once. One that is still there afterwards could not be
    // removed, and trying again every poll would only repeat the notice until the deadline.
    const reclaimed = new Set<string>();
    for (;;) {
      const token = randomUUID();
      // Only an occupied name is contention. Anything else — a permission problem, a read-only
      // filesystem — is an operational failure, and looping on it until the deadline would report
      // "another lifecycle command holds this" about a claim nobody holds.
      if (await this.#claim(request, token)) return { release: () => this.#release(request.lockPath, token) };
      const holder = await this.#holder(request.lockPath);
      if (holder.abandoned !== undefined && !reclaimed.has(holder.abandoned.token)) {
        reclaimed.add(holder.abandoned.token);
        await this.#reclaim(request.lockPath, holder.abandoned);
        request.reclaimed(`${describeClaim(holder.abandoned)}, which is no longer running`);
        continue;
      }
      if (this.clock.now() >= deadline) throw new DaemonLifecycleBusyError(this.#refusal(request, holder.text));
      if (!announced) {
        announced = true;
        request.waiting(holder.text);
      }
      await this.clock.sleep(this.pollMs);
    }
  }

  /** True once the claim is held. False means the name is taken; anything else throws. */
  async #claim(request: DaemonLifecycleClaimRequest, token: string): Promise<boolean> {
    const directory = dirname(request.lockPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const staged = join(directory, `${STAGED_PREFIX}${randomUUID()}`);
    const holder = await this.#self();
    const claim: Claim = {
      owner: globalThis.process.pid,
      token,
      verb: request.verb,
      at: this.clock.now(),
      ...(holder === undefined ? {} : { holder }),
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

  /** Which process this invocation is, for a later observer to check. Absent when the host cannot say. */
  async #self(): Promise<Claim['holder']> {
    const scope = await this.incarnations.scope();
    if (scope === undefined) return undefined;
    const self = await this.incarnations.observe(globalThis.process.pid);
    return self.kind === 'running' ? { ...scope, start: self.start } : undefined;
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

  /**
   * Remove a claim whose holder has provably exited, with the same two primitives a release uses.
   *
   * The verdict was reached on a read, and a read is stale the moment it is made — but nothing here
   * depends on it staying true. `unlink` names the dead holder's token file exactly, so it can never
   * touch a successor's claim, and `rmdir` refuses a directory that is not empty, so a successor that
   * published in the gap keeps its claim and this invocation simply goes back to waiting for it.
   */
  async #reclaim(lockPath: string, claim: Claim): Promise<void> {
    await unlink(join(lockPath, `${CLAIM_PREFIX}${claim.token}.json`)).catch(() => undefined);
    await rmdir(lockPath).catch(() => undefined);
  }

  #refusal(request: DaemonLifecycleClaimRequest, holder: string): string {
    const seconds = String(Math.round(request.waitMs / 1_000));
    return `another daemon lifecycle command still holds ${request.lockPath} after ${seconds}s, so ${request.verb} was refused rather than run beside it — ${holder}`;
  }

  /**
   * How to describe whatever holds the name, for a wait notice and a refusal alike — and, when its
   * holder has provably exited, the claim to remove.
   *
   * An unreadable claim and a claim that has just been released are reported as one thing on purpose.
   * Telling them apart needs an observation a filesystem cannot give atomically — the name can change
   * between the failed publication and this read — and both answers lead a person to the same two
   * actions: try again, and clear the directory if it is still there with nothing running.
   */
  async #holder(lockPath: string): Promise<{ readonly text: string; readonly abandoned?: Claim }> {
    const claim = await this.#readClaim(lockPath);
    if (claim === undefined) {
      return {
        text: `its claim could not be read, so it may have been released in the meantime; run the command again, and remove ${lockPath} once no lifecycle command is running`,
      };
    }
    const verdict = await this.#verdict(claim);
    const text = `held by ${describeClaim(claim)}: ${liveness(verdict, lockPath)}`;
    return verdict === 'gone' ? { text, abandoned: claim } : { text };
  }

  /**
   * Whether the holder is still running, decided only where the answer can be trusted.
   *
   * A pid is meaningful only inside one boot and one PID namespace, so a verdict of `gone` needs the
   * claim to say which scope it came from and this invocation to be in it: then a missing process has
   * exited, and a process with a different start time is a stranger that inherited the number. A claim
   * from an earlier boot is gone wherever it is read, because nothing survives a reboot. Every other
   * case — another namespace, a claim that recorded no scope, a host that cannot tell — delays in the
   * safe direction, because a false "no longer running" lets a second command run beside a live one.
   */
  async #verdict(claim: Claim): Promise<HolderVerdict> {
    const here = claim.holder === undefined ? undefined : await this.incarnations.scope();
    if (claim.holder !== undefined && here !== undefined) {
      if (claim.holder.boot !== here.boot) return 'gone';
      if (claim.holder.namespace !== here.namespace) return 'elsewhere';
      const now = await this.incarnations.observe(claim.owner);
      if (now.kind === 'gone') return 'gone';
      if (now.kind === 'running') return now.start === claim.holder.start ? 'running' : 'gone';
    }
    return this.processes.alive(claim.owner) ? 'running' : 'unknown';
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

/** `start (owner 4242, since …)` — the verb that took a claim, and the invocation that took it. */
function describeClaim(claim: Claim): string {
  return `${claim.verb} (owner ${String(claim.owner)}, since ${new Date(claim.at).toISOString()})`;
}

/**
 * What a person should conclude about the holder, in the words each verdict actually supports.
 *
 * The old single answer for every invisible owner blamed "another PID namespace" for a process that had
 * simply been killed. A namespace is now named only when the claim proves the holder was in a different
 * one; a claim that cannot prove anything says so instead.
 */
function liveness(verdict: HolderVerdict, lockPath: string): string {
  switch (verdict) {
    case 'running':
      return 'that owner is still running';
    case 'gone':
      return `that owner is no longer running, but its claim could not be removed; remove ${lockPath}`;
    case 'elsewhere':
      return 'that owner runs in another PID namespace, such as a container sharing this filesystem, so whether it is still running cannot be seen from here; verify independently that no lifecycle command is running before removing the claim';
    case 'unknown':
      return 'that owner cannot be seen from here, and its claim does not record enough to prove it has exited — it may be running as another user or in another PID namespace — so verify independently that no lifecycle command is running before removing the claim';
  }
}
