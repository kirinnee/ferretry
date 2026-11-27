/**
 * The provisioning boundary: what an apply of the account model decides, and what it asks an adapter to do.
 *
 * A plan is a complete, inspectable description of every write. Deciding and writing are separate
 * so the decision half stays pure — the plan for a configuration is a value a test can assert on,
 * with no filesystem in sight — and so a preview is the same code path minus the last step.
 */
import type { RuntimeIds } from './account/ids.ts';
import type { FleetManifest, HarnessKind } from './manifest.ts';
import type { SettingsFormat, SettingsObject } from './settings.ts';
import type { SharedHistoryPreview, SharedHistoryRequest } from './shared-history.ts';

/** Every directory the fleet owns. Supplied by the composition root, never discovered. */
export interface FleetLayout {
  /** Root of the Ferretry state home (`FY_HOME`). */
  readonly stateHome: string;
  /** The user's home directory, used to expand `~/` in configured paths. */
  readonly userHome: string;
  readonly fleetDirectory: string;
  /** Generated wrappers land here; this directory goes on `PATH`. */
  readonly binDirectory: string;
  /** Default parent for account homes declared as a relative path. */
  readonly homesDirectory: string;
  /** Default parent for profile assets referenced by a relative path. */
  readonly assetsDirectory: string;
  readonly manifestPath: string;
  /** Where the bare upstream CLI of each harness reads its configuration from. */
  readonly defaultHomeDirectories: Readonly<Record<HarnessKind, string>>;
}

/**
 * One write. `settings` carries unresolved layers because reading a referenced file is IO; the
 * adapter resolves them and merges with the rules in `settings.ts`. Two operations remove things
 * rather than write them — `prune` and `prune-directory` — and each states its own bound where it is
 * declared, because they sweep destinations the fleet owns to different degrees.
 */
export type FleetWriteOperation =
  | {
      readonly kind: 'directory';
      readonly path: string;
      readonly mode?: number;
    }
  | {
      readonly kind: 'file';
      readonly path: string;
      readonly content: string;
      readonly mode: number;
      /**
       * This file IS the {@link MaterialisedRecord}. Written last, it drops what this apply declined to write (an entry
       * left as the person had it), and fingerprints what it did write (a file's hash, a link's stamp, a folder), so a
       * later apply never mistakes an entry that is not the plan's for the plan's own. It replaces only a record.
       */
      readonly recordsMaterialised?: true;
      /** Replace nothing the plan did not put there: see {@link UnlessUnrecorded}. */
      readonly unlessUnrecorded?: UnlessUnrecorded;
    }
  | {
      readonly kind: 'copy';
      readonly source: string;
      readonly path: string;
      readonly mode?: number;
      /** Replace nothing the plan did not put there: see {@link UnlessUnrecorded}. */
      readonly unlessUnrecorded?: UnlessUnrecorded;
    }
  | {
      readonly kind: 'symlink';
      readonly source: string;
      readonly path: string;
      /**
       * The source may not exist yet, so its absence is not a refusal. Only for a runtime's link to
       * the ONE file its credential lives in (Codex `auth.json`, account model §8.2.1): an empty slot
       * has no login until somebody signs in, and the harness then writes the login THROUGH the link.
       * Every other link must resolve, because a dangling one is a harness quietly finding nothing.
       */
      readonly dangling?: true;
      /** Replace nothing the plan did not put there: see {@link UnlessUnrecorded}. */
      readonly unlessUnrecorded?: UnlessUnrecorded;
    }
  | {
      readonly kind: 'settings';
      readonly path: string;
      readonly format: SettingsFormat;
      readonly layers: readonly SettingsLayerSource[];
      readonly mode: number;
      /**
       * Fold the file already at `path` in as the base layer. The harness writes its own keys there
       * at runtime (`/effort`), and a re-apply that clobbered them would silently reset the user.
       */
      readonly preserveExisting: boolean;
      /**
       * Top-level keys that are a MAP the plan fills member by member (Claude's `.claude.json` `mcpServers`). The
       * person's own members are kept: the plan's are merged in, and a member the plan wrote earlier — named, with the
       * hash of what it wrote, in `record` — is dropped when the plan no longer has it, but only while it still holds
       * exactly that value. A member the person made, or edited, is kept and named as skipped. Without `record` nothing
       * is ever dropped. Every other key is folded in as `preserveExisting` says.
       */
      readonly replaceKeys?: readonly string[];
      /** The {@link MaterialisedRecord} that remembers which `replaceKeys` members the plan wrote. */
      readonly record?: string;
      /**
       * With {@link replaceKeys} and a record from before members were recorded (it has no `members`): the members an
       * earlier plan could have written under each key that this plan no longer has, as they would be written. A member
       * that is equal to one of these is provably Ferretry's and goes; any other member stays and is named.
       */
      readonly priorMembers?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    }
  | {
      readonly kind: 'prune';
      /** Directory to sweep. Only its direct children are considered. */
      readonly path: string;
      /** Marker a file must contain before it may be removed. */
      readonly marker: string;
      /** Names to keep, whether or not they carry the marker. */
      readonly keep: readonly string[];
    }
  | {
      /**
       * Remove every direct child of a directory this plan materialized entry by entry.
       *
       * The second destructive operation, and bounded differently from `prune` because what it sweeps
       * is different. `prune` sweeps a directory Ferretry shares with the user's own `PATH` files, so
       * it may only remove files carrying the managed marker. This sweeps a destination the fleet owns
       * outright: an account's skills directory was REPLACED wholesale on every apply before the field
       * became per-item, so every direct child of it is this plan's own work from an earlier run. The
       * keep list is the bound, and it is exactly the selection.
       *
       * Without it, per-item selection would be write-only: deselecting a skill would leave the
       * account still holding — and still able to run — the item it was just told to give up.
       */
      readonly kind: 'prune-directory';
      /** Directory to sweep. Only its direct children are considered. */
      readonly path: string;
      /** Names this plan materialized. Every other direct child is removed, file or directory. */
      readonly keep: readonly string[];
      /**
       * Narrow the sweep to these direct children, for a directory the plan does NOT own outright — a
       * runtime's config directory, which the harness and the person write into too (Claude's
       * `/memory` makes `CLAUDE.md` there). Each named child is removed only when it is provably the plan's (see
       * {@link UnlessUnrecorded}): {@link record} names it and it still matches. A symbolic link is no exception. Anything
       * else stays, and is named as skipped.
       */
      readonly only?: readonly string[];
      /**
       * With {@link only}: the previous apply's {@link MaterialisedRecord} of what it put in this
       * directory. Absent or unreadable means no record, and so nothing is removed.
       */
      readonly record?: string;
      /**
       * Without {@link only}, with {@link record}: sweep ONLY the children the record names as `<recordedAs>/<child>` and
       * that are not in the keep list, each on the same proof. An entry the person or the harness added to a shared
       * directory (a skill by hand, a note in the state folder) is left and named as skipped instead of removed. Absent,
       * the directory is the plan's own outright.
       */
      readonly recordedAs?: string;
      /**
       * With {@link recordedAs} or {@link only}: a folder Ferretry itself fills (its assets). With a record from before links
       * were fingerprinted, a link in this directory is still removed when it leads into this folder — only Ferretry makes
       * such a link, and an upgrade must not leave its old ones behind. Any other unrecorded link stays.
       */
      readonly ownLinksUnder?: string;
    };

/**
 * A write that replaces nothing the plan did not put there. THE ONE RULE for every removal or replacement in a runtime
 * home: Ferretry takes an entry away only when the entry captured at that moment is provably the one it wrote — the
 * record of THIS runtime names the exact path, and the entry still matches what was recorded (a file: the same hash; a
 * link: the same stamp; a folder: recorded as written). Anything else is left exactly as it is and named as skipped. A
 * header, or text equal to what would be written, proves nothing.
 */
export interface UnlessUnrecorded {
  readonly record: string;
  readonly key: string;
  /**
   * One of Ferretry's own FIXED names (its record, its `--settings` overlay, its model catalog): a regular file at the
   * name is Ferretry's whatever its bytes — nobody edits what Ferretry's own corner holds, and a frozen one would keep a
   * stale permission default in force. A link or a folder at the name is not, and stays.
   */
  readonly byName?: true;
  /**
   * A record from before links were fingerprinted (it has no `links`) cannot vouch for a link. A link that leads into
   * this folder — the one only Ferretry fills — is still provably its own and is claimed once, then stamped.
   */
  readonly ownLinksUnder?: string;
  /**
   * With a record from before links were fingerprinted: a link at this name that record NAMES is Ferretry's. For the
   * credential link, whose target the fleet root cannot read; replacing it costs a link, never the file it leads to.
   */
  readonly namedLinkIsOurs?: true;
}

/** What a record holds for the entries one apply materialised, relative to their runtime home. */
export interface MaterialisedRecord {
  readonly version: 1;
  readonly entries: readonly string[];
  /** sha256 of the bytes written at each file entry, so a later apply can tell an edit from its own file. */
  readonly hashes?: Readonly<Record<string, string>>;
  /** What each link entry looked like when written (its identity, size and time), so a swapped link is not taken for it. */
  readonly links?: Readonly<Record<string, string>>;
  /** The entries written as a folder. */
  readonly dirs?: readonly string[];
  /** A fingerprint of what is INSIDE each folder entry, so a folder the person added to is not taken for Ferretry's own. */
  readonly trees?: Readonly<Record<string, string>>;
  /** The hash of each `replaceKeys` member the plan wrote, as `<key>.<member>`. */
  readonly members?: Readonly<Record<string, string>>;
}

/** A settings layer as the plan sees it: a file still to be read, or an object already known. */
export type SettingsLayerSource =
  | { readonly from: 'file'; readonly path: string }
  | { readonly from: 'inline'; readonly settings: SettingsObject };

export interface FleetApplyPlan {
  readonly manifest: FleetManifest;
  readonly manifestPath: string;
  readonly operations: readonly FleetWriteOperation[];
  /** Filesystem-observed separately so dry-run can report exact moves and collision winners. */
  readonly sharedHistoryRequests?: readonly SharedHistoryRequest[];
}

/** A plan plus the exact read-only history migration evidence observed for this invocation. */
export interface FleetApplyPreview extends FleetApplyPlan {
  readonly sharedHistory: readonly SharedHistoryPreview[];
}

/**
 * The plan a format-1 configuration produces, plus the `ids.json` it was planned against.
 *
 * The ids travel with the plan because the plan already WRITES them — `ids.json` is one of its file
 * operations, inside the same rollback boundary — and a caller reporting what it applied names
 * runtimes by those ids.
 */
export interface FleetModelApplyPlan extends FleetApplyPlan {
  readonly ids: RuntimeIds;
}

/**
 * A text document written inside the same rollback boundary as the plan's own operations.
 *
 * A configuration edit and the assets it references are only meaningfully atomic *together* with
 * the fleet they describe: a host left declaring an account whose home was never materialized is
 * exactly the half-state an all-or-nothing apply exists to prevent.
 */
export interface FleetDocumentWrite {
  readonly path: string;
  readonly content: string;
  readonly mode: number;
  /**
   * The digest this write expects to find already at `path`, or `ABSENT_DOCUMENT_REVISION` when it
   * expects nothing there.
   *
   * Checked *after* the existing entry has been captured, which is the only point at which the
   * answer cannot go stale: capture renames the entry away atomically, so nothing else can reach
   * the path afterwards and what was moved aside is exactly what the check is about. A check made
   * before the capture leaves a window in which the host is edited and the edit is then silently
   * overwritten by text composed against the older version.
   */
  readonly expect?: string;
  /**
   * A configuration document written as a PATCH of top-level keys (`undefined` removes one) that the kernel's config
   * writer applies to the file it holds, so only the keys that changed are touched; `content` is then ignored.
   */
  readonly patch?: Readonly<Record<string, unknown>>;
  /**
   * Remove the document instead of writing it (`content` is then ignored): a configuration file for a
   * login, component, profile or runtime the change deletes. Removed inside the same boundary, so a
   * failed apply puts it back with everything else.
   */
  readonly remove?: true;
}

/** The expected-digest value meaning "nothing should be here yet". */
export const ABSENT_DOCUMENT_REVISION = 'absent';

export interface FleetProvisioner {
  preview(plan: FleetApplyPlan): Promise<FleetApplyPreview>;
  apply(plan: FleetApplyPlan, documents?: readonly FleetDocumentWrite[]): Promise<FleetApplyResult>;
}

/**
 * State a rollback moved out of the way rather than deleting.
 *
 * A rollback only ever renames; it never deletes anything it cannot prove it wrote. When what sat
 * at a destination turned out not to be this apply's own work, it is kept under a reserved name and
 * reported here, because it is somebody's data and only they can decide what it is worth.
 */
export interface DisplacedState {
  /** Where it was. */
  readonly path: string;
  /** Where it is now. */
  readonly movedTo: string;
}

/** A path whose prior state could not be put back, and the reason it could not. */
export interface UnrestoredPath {
  readonly path: string;
  readonly reason: string;
  /**
   * Where the original still is, when it was moved aside and could not be moved back. Reported
   * because it is the only remaining copy: a caller that cleaned it up would destroy the evidence
   * a person needs to finish the restoration by hand.
   */
  readonly backup?: string;
}

/** What a host actually carries once ordinary provisioning has committed its manifest. */
export interface FleetApplyCommittedState {
  readonly accountCount: number;
  readonly operationCount: number;
  readonly manifestPath: string;
  readonly manifest: FleetManifest;
  readonly prunedWrappers: readonly string[];
  /** Migrations that completed before the failure. */
  readonly sharedHistory: readonly SharedHistoryPreview[];
  /** Moved-aside evidence left on disk by the committed apply. */
  readonly backupResidue?: readonly string[];
  /** Operations left as the disk has them (see {@link SkippedDestination}). The rest of the apply landed. */
  readonly skipped?: readonly SkippedDestination[];
  /**
   * The exclusive claim this apply could not verify releasing. Residue, never a failure — but it
   * blocks the next apply until it is cleared, so it is named rather than swallowed.
   */
  readonly lockResidue?: string;
}

/**
 * Why an apply did not succeed, in the only three shapes that differ for the person reading it.
 *
 * The distinction that matters is not which write threw but **what the host is now**: back where it
 * started, somewhere that could not be verified, or genuinely changed with a later step failing.
 * Collapsing these into one "apply failed" is how a fleet that did land gets re-applied blindly.
 */
export type FleetApplyFailure =
  | {
      /**
       * Nothing was committed and the host is exactly as it was: every captured entry verified
       * back, and nothing of anyone else's moved. Both conditions, because a rollback that had to
       * set somebody's file aside left the host with a path renamed and a reserved file present —
       * true of the fleet, but not true of the host, and this is the state a reader acts on.
       */
      readonly kind: 'rolled-back';
      readonly failedOperation: string;
      readonly reason: string;
    }
  | {
      /** Restoration could not be verified, or something not ours had to be moved out of the way. */
      readonly kind: 'rollback-incomplete';
      readonly failedOperation: string;
      readonly reason: string;
      readonly unrestored: readonly UnrestoredPath[];
      readonly displaced?: readonly DisplacedState[];
    }
  | {
      /**
       * Ordinary provisioning committed, including the manifest. History migration has its own
       * boundary and did not roll the fleet back — so the committed state is reported exactly.
       */
      readonly kind: 'history-failed-after-commit';
      readonly failedHarness: HarnessKind;
      readonly reason: string;
      readonly committed: FleetApplyCommittedState;
    };

function describeFailure(failure: FleetApplyFailure): string {
  if (failure.kind === 'rolled-back') {
    return `apply failed at ${failure.failedOperation}: ${failure.reason} — the host was restored to its previous state and nothing was committed`;
  }
  if (failure.kind === 'rollback-incomplete') {
    const parts: string[] = [];
    if (failure.unrestored.length > 0) {
      parts.push(
        `restoration could not be verified for: ${failure.unrestored.map(entry => `${entry.path} (${entry.reason})`).join('; ')}`,
      );
    }
    const displaced = failure.displaced ?? [];
    if (displaced.length > 0) {
      parts.push(
        `content that was not this apply's was moved aside: ${displaced.map(entry => `${entry.path} → ${entry.movedTo}`).join('; ')}`,
      );
    }
    return `apply failed at ${failure.failedOperation}: ${failure.reason} — ${parts.join('; and ')}`;
  }
  return `the fleet was applied and its manifest published at ${failure.committed.manifestPath}, but ${failure.failedHarness} shared history failed afterwards: ${failure.reason}`;
}

/**
 * A failed apply, carrying the exact post-state rather than only a message. The message repeats the
 * structured evidence so a caller that only logs it still says something true.
 */
export class FleetApplyFailureError extends Error {
  constructor(
    readonly failure: FleetApplyFailure,
    /** An exclusive claim whose release could not be verified. Never changes the classification. */
    readonly lockResidue?: string,
  ) {
    super(
      lockResidue === undefined
        ? describeFailure(failure)
        : `${describeFailure(failure)}; the exclusive apply claim at ${lockResidue} could not be cleared`,
    );
    this.name = 'FleetApplyFailureError';
  }
}

/**
 * An apply that failed AFTER the configuration files of its change had landed: the files are written first and are NOT
 * rolled back with the fleet, so a caller that tells a person what a failure left behind must know they are on disk.
 * It wraps whatever the apply threw (a rollback outcome, a refused source, a claim that could not be taken) and names
 * only paths, never content. A failure BEFORE any file landed is never wrapped.
 */
export class FleetApplyAfterConfigError extends Error {
  constructor(
    /** The configuration files written first, as the paths the change named. */
    readonly written: readonly string[],
    readonly failure: unknown,
  ) {
    super(failure instanceof Error ? failure.message : String(failure));
    this.name = 'FleetApplyAfterConfigError';
  }
}

/**
 * An operation an apply left as the disk has it, and why: on a platform where the destination side cannot reach a
 * folder through its descriptor (macOS), nothing below a runtime's top folder is moved aside or removed.
 */
export interface SkippedDestination {
  readonly path: string;
  readonly reason: string;
}

export interface FleetApplyResult {
  readonly accountCount: number;
  readonly operationCount: number;
  readonly manifestPath: string;
  /** Managed wrappers removed because no account or command claims them any more. */
  readonly prunedWrappers: readonly string[];
  /** Exact moves, links, merges and preserved collisions completed for each enabled harness. */
  readonly sharedHistory: readonly SharedHistoryPreview[];
  /**
   * Moved-aside evidence left on disk after a successful apply. Residue, never a failure: undoing a
   * committed apply to tidy up would delete the very state the manifest now describes.
   */
  readonly backupResidue?: readonly string[];
  /** Operations left as the disk has them (see {@link SkippedDestination}). The rest of the apply landed. */
  readonly skipped?: readonly SkippedDestination[];
  /**
   * The exclusive claim this apply could not verify releasing. Residue, never a failure — reporting
   * it as one would turn a fleet that fully landed into a fleet the caller believes was refused —
   * but it blocks the next apply until it is cleared, so it is named rather than swallowed.
   */
  readonly lockResidue?: string;
}
