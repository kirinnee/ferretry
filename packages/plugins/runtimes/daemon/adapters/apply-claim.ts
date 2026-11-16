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
 * **Release never moves the lock's name.** It removes THIS holder's own token file, whose name only this holder can
 * know, and then the folder it emptied. A holder that was superseded (a person cleared its claim, as the refusal
 * invites, and a successor took the name) finds no token file of its own and touches nothing, so a lock name that a
 * successor holds is never free, not for one step: today's release protocol, which rejected "aside, then judge" because
 * it frees the name under a live successor and a third contender takes it. The folder is removed only if it is empty and
 * still the very folder this holder published (identity), and what is left in it is never removed. [kernel] GAP: the
 * root has no remove-if-empty, so the last step is a look (empty, same folder) and then a remove; the window between
 * them is the instant after this holder's own token went, and it is named in `ports-pending.json`.
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
import { isOriginalsName } from './mutation-journal.ts';
import type { ApplyLock } from './ports.ts';

/** The lock's name beside the manifest. */
const LOCK_NAME = '.fy-fleet-apply.lock';
/** The token file inside a claim, named after the token only its holder knows. */
const CLAIM_PREFIX = 'claim-';
/** A claim being built, before it is published under the lock's name. */
const STAGED_CLAIM_PREFIX = '.fy-fleet-apply.';
/** The most entries the refusal looks through for originals an interrupted apply left moved aside. */
const MAX_LEFTOVER_SCAN = 5000;

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
  /** The folder each claim this object published was moved onto the lock's name as, by its token. */
  readonly #published = new Map<string, string | undefined>();

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
      // The folder as built: a rename keeps it, so the release can tell the folder it published from any other.
      const identity = await this.disk.identity(staged);
      try {
        await this.disk.rename(staged, this.path);
        this.#published.set(token, identity);
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
    const left = await this.#leftovers();
    if (state.kind === 'unreadable') {
      return `another fleet apply holds ${this.path} and its claim could not be read; remove that folder once no apply is running${left}`;
    }
    return `another fleet apply holds ${this.path}, claimed at ${isoOf(state.claim.at)}; if no fleet change is running it was left behind by an interrupted apply, and it can be removed${left}`;
  }

  /**
   * What an apply that was killed leaves beside its claim: the originals it moved aside (`.fy-fleet-backup-*`, `.fy-fleet-
   * displaced-*`), each the ONLY copy of a file or folder it replaced. Nothing recovers them on boot, so the sentence
   * that tells a person to remove the claim names them too, or removing the claim looks like the whole cleanup. Bounded:
   * past the bound it says so rather than walking a whole home.
   */
  async #leftovers(): Promise<string> {
    const found: string[] = [];
    let seen = 0;
    let complete = true;
    const walk = async (folder: string, shown: string): Promise<void> => {
      let entries: Awaited<ReturnType<FleetDisk['entries']>>;
      try {
        entries = await this.disk.entries(folder);
      } catch {
        return;
      }
      for (const entry of entries) {
        seen += 1;
        if (seen > MAX_LEFTOVER_SCAN) {
          complete = false;
          return;
        }
        const name = shown === '' ? entry.name : `${shown}/${entry.name}`;
        if (isOriginalsName(entry.name)) found.push(name);
        else if (entry.kind === 'directory' && !entry.name.startsWith(STAGED_CLAIM_PREFIX))
          await walk(`${folder}/${entry.name}`, name);
      }
    };
    await walk(this.folder, '');
    if (found.length === 0) return '';
    return `. That apply also left ${found.length === 1 ? 'an original' : `${found.length} originals`} of what it replaced moved aside beside the ${found.length === 1 ? 'file' : 'files'} it replaced, and each is the only copy, so keep them: ${found.toSorted().join(', ')}${complete ? '' : ' (and more: the folder was only searched in part)'}`;
  }

  /**
   * Releases the claim; answers the path of a claim that could not be cleared.
   *
   * The order is today's: this holder's OWN token file goes first (its name carries a token only this holder knows, so the
   * call can never reach a successor's claim), then the folder it emptied, only if it is still empty and still the folder
   * this holder published. The lock's name is never moved, so it is never free under somebody else's claim.
   */
  async release(token: string): Promise<string | undefined> {
    try {
      const tokenFile = this.#tokenFile(this.path, token);
      if ((await this.#exists(tokenFile)) === false) {
        // This holder's proof is not there, so it holds nothing and has nothing to remove: whatever occupies the name now
        // (a successor's claim, or nothing) is not its business, and is said only if something is there to be told.
        return (await this.#exists(this.path)) === false ? undefined : this.path;
      }
      try {
        await this.disk.remove(tokenFile);
      } catch {
        if ((await this.#exists(tokenFile)) !== false) return this.path;
        return (await this.#exists(this.path)) === false ? undefined : this.path;
      }
      return await this.#removeEmptied(token);
    } catch {
      return this.path;
    } finally {
      this.#published.delete(token);
    }
  }

  /**
   * The folder this holder emptied: removed only while it is empty and still the folder this holder published. Anything
   * left in it is somebody else's (a successor's claim, or what no claim reader can trust) and stays; only something
   * unreadable will block the next apply, so only that is named.
   */
  async #removeEmptied(token: string): Promise<string | undefined> {
    const names = (await this.disk.entries(this.path)).map(entry => entry.name);
    // A claim published by ANOTHER object (a release from a fresh handle) has no recorded folder to compare with: the
    // token file this holder just removed from it is the proof the folder was this holder's.
    const mine = !this.#published.has(token) || (await this.disk.identity(this.path)) === this.#published.get(token);
    if (names.length === 0 && mine) {
      await this.disk.remove(this.path);
      return undefined;
    }
    return (await this.#read(this.path)).kind === 'unreadable' ? this.path : undefined;
  }

  /** Whether anything is at `path`; `undefined` when it could not be looked at (which is never "nothing"). */
  async #exists(path: string): Promise<boolean | undefined> {
    try {
      return (await this.disk.lstat(path)) !== undefined;
    } catch {
      return undefined;
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
