/**
 * An exclusive claim over the fleet folder, held across separate invocations, over the kernel's `fleet` root.
 *
 * Two applies that overlap capture each other's writes as "the state before", so their rollbacks undo one another and
 * neither report is true. An in-memory queue orders the applies made through one object; the claim orders this daemon
 * against anything else that applies (a second daemon on the same state home), so it lives in the folder it protects.
 *
 * **A claim is a small directory, and it is published whole.** It is built under a private name (a directory holding
 * one file named after an unguessable token) and moved onto the lock's name with `rename`, which the root refuses when
 * anything is already at the name: an existing claim is never replaced, and a claim is never seen half-written.
 *
 * **Release takes the claim aside before it decides anything.** The directory is renamed to a private name in one
 * step, and only then is it looked at: if it holds exactly this holder's token file it is removed; if it holds anything
 * else (a person cleared our claim and a successor took the name) it is put back untouched and the path is reported.
 * Nothing is ever removed at the lock's name on a decision about what was there a moment ago.
 *
 * **Nothing is taken over automatically, on purpose.** Reclaiming a dead holder's claim needs an atomic
 * compare-and-replace that a file system does not offer, and a reaper that gets it wrong lets two applies run, which is
 * the one thing the claim exists to prevent. A holder that dies leaves its claim; the refusal then names it, when it was
 * made and who made it, and a person removes it. That is a worse failure to recover from and a much better one to have.
 *
 * The honest limits: a plugin cannot signal a process, so the refusal says when the claim was made, not whether its
 * holder is still alive; an EMPTY directory at the lock name (residue of a release that was interrupted) is not taken
 * over either, and is reported as a claim that cannot be read.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FleetDisk } from './fleet-disk.ts';
import type { ApplyLock } from './ports.ts';

/** The lock's name beside the manifest. */
const LOCK_NAME = '.fy-fleet-apply.lock';
/** The token file inside a claim, named after the token only its holder knows. */
const CLAIM_PREFIX = 'claim-';
/** A claim being built, before it is published under the lock's name. */
const STAGED_CLAIM_PREFIX = '.fy-fleet-apply.';
/** A claim taken aside by its release, to be looked at before it is removed. */
const RELEASING_PREFIX = '.fy-fleet-apply-releasing.';

const DEFAULT_WAIT_MS = 60 * 1000;
const DEFAULT_POLL_MS = 25;
const MAX_CLAIM_BYTES = 4096;

const ClaimSchema = z.strictObject({
  /** Unguessable per-claim value, so a holder can prove a lock is still the one it took. */
  token: z.string().min(1),
  /** Epoch milliseconds the claim was made. */
  at: z.number().int().nonnegative(),
});
type Claim = z.output<typeof ClaimSchema>;

type ClaimState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'held'; readonly claim: Claim };

const isoOf = (ms: number): string => new Date(ms).toISOString();

/** What a claim waits with: the kernel's clock (a plugin has no timer of its own) and how long it waits. */
export interface ApplyClaimOptions {
  /** Milliseconds since the epoch, from the kernel's clock. */
  readonly now: () => number;
  /** Resolves after `ms` milliseconds of the kernel's clock. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly waitMs?: number;
  readonly pollMs?: number;
}

/** The claim for the fleet whose manifest is at `manifestPath`: it sits in the manifest's folder. */
export function applyClaimFor(disk: FleetDisk, manifestPath: string, options: ApplyClaimOptions): ApplyLock {
  const folder = manifestPath.slice(0, manifestPath.lastIndexOf('/'));
  return new FleetApplyClaim(disk, `${folder}/${LOCK_NAME}`, folder, options);
}

class FleetApplyClaim implements ApplyLock {
  readonly #waitMs: number;
  readonly #pollMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly disk: FleetDisk,
    readonly path: string,
    private readonly folder: string,
    options: ApplyClaimOptions,
  ) {
    this.#waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    this.#pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.#now = options.now;
    this.#sleep = options.sleep;
  }

  async acquire(): Promise<string> {
    const deadline = this.#now() + this.#waitMs;
    for (;;) {
      const token = randomUUID();
      if (await this.#claim(token)) return token;
      if (this.#now() >= deadline) throw new Error(await this.#refusal());
      await this.#sleep(this.#pollMs);
    }
  }

  #tokenFile(directory: string, token: string): string {
    return `${directory}/${CLAIM_PREFIX}${token}.json`;
  }

  /** One attempt: build the claim whole under a private name, then move it onto the lock's name. */
  async #claim(token: string): Promise<boolean> {
    await this.disk.makeFolder(this.folder, 0o700);
    // Something is at the name already: held (or residue), whatever it is. Looked at first so a plain refusal of the
    // move below is only ever the race of two claimers, never a reason to build a claim for nothing.
    if ((await this.disk.lstat(this.path)) !== undefined) return false;
    const staged = `${this.folder}/${STAGED_CLAIM_PREFIX}${randomUUID()}`;
    const claim: Claim = { token, at: this.#now() };
    await this.disk.makeFolder(staged, 0o700);
    try {
      await this.disk.create(
        this.#tokenFile(staged, token),
        new TextEncoder().encode(`${JSON.stringify(claim)}\n`),
        0o600,
      );
      try {
        await this.disk.rename(staged, this.path);
        return true;
      } catch (error) {
        // The root refuses a name that is taken; anything else about the move is the same refusal (no copy fallback).
        if ((await this.disk.lstat(this.path)) !== undefined) return false;
        throw error;
      }
    } finally {
      await this.disk.remove(staged).catch(() => undefined);
    }
  }

  async #refusal(): Promise<string> {
    const state = await this.#read(this.path);
    if (state.kind === 'absent') {
      return `could not take ${this.path} before the deadline, and the claim is now gone; run the apply again`;
    }
    if (state.kind === 'unreadable') {
      return `another fleet apply holds ${this.path} and its claim could not be read; remove that folder once no apply is running`;
    }
    return `another fleet apply holds ${this.path}, claimed at ${isoOf(state.claim.at)}; if no fleet change is running it was left behind by an interrupted apply, and it can be removed`;
  }

  /** Releases the claim; answers the path of a claim that could not be cleared. */
  async release(token: string): Promise<string | undefined> {
    const aside = `${this.folder}/${RELEASING_PREFIX}${randomUUID()}`;
    try {
      try {
        await this.disk.rename(this.path, aside);
      } catch {
        // Nothing at the name (already cleared) is released; anything else there could not be taken aside.
        return (await this.disk.lstat(this.path)) === undefined ? undefined : this.path;
      }
      const state = await this.#read(aside);
      if (state.kind === 'held' && state.claim.token === token) {
        await this.disk.remove(aside);
        return undefined;
      }
      // Not ours: put it back exactly as it was, and say where it is.
      try {
        await this.disk.rename(aside, this.path);
        return this.path;
      } catch {
        return aside;
      }
    } catch {
      return this.path;
    }
  }

  /** What is at `directory`: no claim, a claim a reader cannot trust, or a well-formed one. */
  async #read(directory: string): Promise<ClaimState> {
    let names: readonly string[];
    try {
      const found = await this.disk.lstat(directory);
      if (found === undefined) return { kind: 'absent' };
      if (found.kind !== 'directory') return { kind: 'unreadable' };
      names = (await this.disk.entries(directory)).map(entry => entry.name);
    } catch {
      return { kind: 'unreadable' };
    }
    const [name] = names;
    if (names.length !== 1 || name === undefined || !name.startsWith(CLAIM_PREFIX)) return { kind: 'unreadable' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.disk.readText(`${directory}/${name}`, MAX_CLAIM_BYTES));
    } catch {
      return { kind: 'unreadable' };
    }
    const claim = ClaimSchema.safeParse(parsed);
    if (!claim.success || name !== `${CLAIM_PREFIX}${claim.data.token}.json`) return { kind: 'unreadable' };
    return { kind: 'held', claim: claim.data };
  }
}
