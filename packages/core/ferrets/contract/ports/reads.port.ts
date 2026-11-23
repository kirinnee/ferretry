import type { FerretId } from '@ferretry/kernel/contract';
import type { Result } from '@ferretry/std';
import type { FerretState, FerretSummary, HarnessKey, PackId } from '../ids.ts';
import type { ConversationImport, HarnessFacts, SitrepLine } from '../kinds.ts';
import type { HarnessHistorySource } from '../history.ts';

/**
 * One checkout in the managed worktree registry (`<home>-worktrees`, `state/ferrets/worktrees.json`): the durable
 * facts of today's `ManagedWorktreeView` (`protocol/src/lib/worktrees.ts`), copied. Live Git state, the removal
 * verdict and who stands in it are left out — reading them runs Git. `projectId` is not here: Ferrets is core and
 * cannot read Projects (§2.1), so a reader joins `commonDirectory` to a project's own (today's `projectForWorktree`).
 */
export interface ManagedWorktreeSummary {
  readonly path: string;
  readonly branch: string;
  readonly repositoryRoot: string;
  /** The repository's common directory: what joins a checkout to its project. */
  readonly commonDirectory: string;
  /** Where inside the source checkout the fork was taken from; the empty string is its root. */
  readonly relativeCwd: string;
  readonly createdAt: string;
  readonly initialHead: string;
  readonly branchPreexisted: boolean;
  readonly removedAt?: string;
  /** Why this row is not a finished checkout: a creation declared and never finished (today's `unresolved`). */
  readonly unresolved?: string;
}

/** A ferret's whole status: its state, its turn, what plugins add, and its blockers from the Asks port. */
export interface Sitrep {
  readonly ferret: FerretSummary;
  readonly lines: readonly SitrepLine[];
  /** Open asks about this ferret (ids, `!A3`). */
  readonly blockers: readonly string[];
}

/**
 * One name in a ferret's folder as {@link FerretsApi.listFolder} lists it. A name flagged `denied`, `ignored` or `escapes`
 * is LISTED but never served (the file browser's own badges): a reader that offers it says so and offers nothing more.
 * Never a size, a time, a link target or a path outside the ferret's folder.
 */
export interface FerretFolderEntry {
  readonly name: string;
  readonly type: 'file' | 'dir' | 'symlink';
  /** On the unconditional denylist (secrets, `.git/`, `node_modules/`), or fenced from this reader. */
  readonly denied?: boolean;
  /** Gitignored. */
  readonly ignored?: boolean;
  /** A symlink resolving outside the ferret's folder, or broken. */
  readonly escapes?: boolean;
}

/** One level of a ferret's folder: directories first, then files. */
export interface FerretFolderListing {
  /** The listed folder relative to the ferret's root; `''` is the root itself. */
  readonly path: string;
  readonly entries: readonly FerretFolderEntry[];
  /** The folder held more names than one listing reports. */
  readonly truncated?: boolean;
}

/** What an id-or-callsign reference addresses (see {@link FerretsApi.resolve}). */
export type FerretAddress =
  | { readonly kind: 'ferret'; readonly id: FerretId }
  /** Two ferrets hold the name on one footing: refused with this sentence, never guessed between. */
  | { readonly kind: 'ambiguous'; readonly message: string }
  | { readonly kind: 'unknown' };

/** Who each ferret is and what it holds, read only: identity, lineage, the folder and worktree it works in, its sitrep and summary. */
export interface ReadsApi {
  get(ferret: FerretId): Promise<FerretSummary | undefined>;
  /**
   * The ferret an id or a callsign (`:name`, case-insensitive) addresses: the ONE rule every surface that takes a ferret in a
   * path applies. An exact id wins; a live holder of a name wins over a dormant one; two on one footing are `ambiguous`.
   */
  resolve(reference: string): Promise<FerretAddress>;
  list(filter?: {
    readonly state?: FerretState;
    readonly parent?: FerretId;
    readonly pack?: PackId;
  }): Promise<readonly FerretSummary[]>;
  /** Synchronous, memory-only: whether `caller` may act on `target` (itself, or a helper of its own lineage). */
  mayTouch(caller: FerretId, target: FerretId): boolean;
  children(ferret: FerretId): readonly FerretId[];
  /** The harness keys currently provided under `harnesses` (a plugin off is absent). */
  harnesses(): readonly HarnessKey[];
  /**
   * What the harness `key` says about itself as data (`Harness.facts`): the ONE place a caller learns a harness's
   * instruction file, skills folder, MCP format, display name, transcript parser id and catalog half. `undefined` when no
   * installed harness has that key: a caller refuses by name and never falls back to another harness.
   */
  harnessFacts(key: HarnessKey): HarnessFacts | undefined;
  /**
   * Additive (shared history): asks the harness `harness` to copy one conversation of the owner's own history into its
   * shared pool (`Harness.importConversation`). Conversation's alone (it writes no other plugin's state: the harness does);
   * any other plugin is refused 403 `forbidden`. A harness that is off, or offers none, answers a refusal sentence.
   */
  importConversation?(
    harness: HarnessKey,
    input: ConversationImport,
  ): Promise<Result<void, { readonly reason: string }>>;
  /**
   * Additive (Conversation's name refresh): whether {@link list} answers the WHOLE roster, as one that may CLEAR something
   * for a ferret missing from it needs to know. It never waits: it answers `false` while the records are still loading, when the load failed or
   * left a record unread (a ferret that exists would then be missing). `list` itself never waits and is unchanged.
   */
  rosterComplete?(): Promise<boolean>;
  /**
   * The past conversations each provided harness holds, as read-only trees (additive, the conversation index): one entry per
   * harness that answered (its `sources` empty when it holds none now), in no particular order. A harness that fails is left
   * out. Reads nothing itself.
   */
  historySources?(): Promise<
    readonly { readonly harness: HarnessKey; readonly sources: readonly HarnessHistorySource[] }[]
  >;
  /**
   * The folder a ferret was started in (its work folder), for Accounts' sign-in ordering, as its REAL path resolved
   * through Ferrets' fenced `work` root. The recorded folder must still be its own real path (today's
   * `sign-in-context.ts` `folderOf`): a folder swapped for a symlink elsewhere, a failed resolve or an unknown ferret
   * answers `undefined`. Accounts compares the folder under the owner's home (kernel `paths.home()`). The PROJECT is
   * not Ferrets': today it came from the Board (`projectOf(session)`), and core cannot import Board or Projects, so
   * Accounts gets it from the Board.
   */
  workFolder(ferret: FerretId): Promise<{ readonly folder: string } | undefined>;
  /**
   * One folder of a ferret's work tree, listed the way the file browser lists it (`GET /v1/ferrets/:ferretId/fs`), so
   * the composer's `@` menu offers exactly what the browser would. Additive, read only, names only.
   *
   * ALWAYS FENCED as an agent's read is: nothing inside the daemon's state home, no hard link, and `path` is resolved
   * UNDER the ferret's root (a `..` segment, an absolute path or a link out of it is refused `403 escapes_root`; a
   * gitignored or denylisted folder is refused `403 ignored` / `403 denied`; a missing one `404 not_found`, a file
   * `400 not_a_directory`). With `caller` (a ferret acting), only itself and its helpers are reachable, by the same
   * `mayTouch` rule as `harness`: anyone else is refused `403 forbidden`, before the folder is touched. `undefined` for
   * a ferret this daemon does not know. A grant (`filesystem.use`) is the CALLER'S to ask: this member does not.
   */
  listFolder?(ferret: FerretId, path: string | undefined, caller?: FerretId): Promise<FerretFolderListing | undefined>;
  sitrep(ferret: FerretId): Promise<Sitrep | undefined>;
  /**
   * What a finished ferret handed back with `signal done`: its `summary.md` as it wrote it (today's session
   * `summary.md`), or `undefined` when there is no such ferret, it has not finished (is not `stopped`), or it wrote
   * none. NOT masked: a reader that shows it
   * masks it inside one `Redaction.read`. Read only.
   */
  summary(ferret: FerretId): Promise<string | undefined>;
  /**
   * The managed worktree registry as it is now (today's `ManagedWorktreeService.list()` rows, durable facts only):
   * every recorded checkout, removed ones included with `removedAt`, then every interrupted creation with
   * `unresolved`. MCP reads it to map a managed worktree to its project, as today's `mcpInventoryFolders`. Read only;
   * no Git inspection (only the registry's own settling, as `list()`). Optional, so it is additive: absent reads as no
   * managed worktree.
   */
  managedWorktrees?(): Promise<readonly ManagedWorktreeSummary[]>;
  /**
   * The next free callsign of a session Ferretry starts ITSELF (additive; today's `SystemCallsignIssuer`): the
   * Learning miner and Pack clean-up take `learning-000001` / `pack-00002A`, never a pool name. The counter is
   * persisted (`system-callsigns.json`) and skips every id the running fleet still holds.
   */
  systemCallsign?(prefix: 'warden' | 'learning' | 'pack'): Promise<string>;
}
