import {
  CURRENT_LAYOUT_VERSION,
  decideLayout,
  LAYOUT_VERSION_FILENAME,
  LAYOUT_VERSION_MODE,
  type LayoutDecision,
  layoutVersionContent,
} from '@ferretry/protocol';
import type { IStateHomeFilePort, StateHomeEntry } from './ports.ts';

/**
 * Creating a Ferretry state home and claiming its layout are ONE operation.
 *
 * They were two, and that shipped a daemon that could never start. `fy fleet init` wrote
 * `<FY_HOME>/fleet/**` and claimed nothing, so the daemon's next boot met a non-empty home carrying
 * no marker — which is exactly the arrangement it must refuse, because it cannot tell that shape
 * apart from a directory belonging to somebody else. The refusal was permanent and correct, and the
 * damage it refused was ours. Reverse the order and everything worked, so whether a fresh install
 * came up at all depended on which command an owner happened to run first.
 *
 * The rule kept here is the strong one: NEVER ADOPT A DIRECTORY FERRETRY DID NOT CREATE. This is not
 * the guard relaxed on the client side — it is the same `decideLayout` from `@ferretry/protocol`,
 * applied at the one moment the client is about to create state. So a client meeting a stranger's
 * directory now refuses too, where before it would cheerfully provision a fleet into it.
 *
 * The mode is `0o700` on the home for the same reason the daemon uses it: the home holds an
 * owner-only API token and the daemon's private identity key.
 */

/** How a home the client is about to write into was left. */
export type StateHomeClaim =
  /** The home did not exist, or was empty; this client created and claimed it. */
  | { readonly kind: 'claimed'; readonly home: string }
  /** Already carried our marker; nothing was written. */
  | { readonly kind: 'already-claimed'; readonly home: string };

/**
 * Raised when the client will not write into a directory, naming why and what it found.
 *
 * The refusal has to carry the entries: "this is not a Ferretry home" is unfalsifiable to a person
 * looking at a path they believe is theirs, and the entries are what let them see in one line that
 * they pointed `FY_HOME` at their documents folder.
 *
 * `repairCommand` is `undefined` when the refusal came FROM that command. Advice a person has just
 * followed is worse than no advice — it reads as a loop, and it implies a second attempt would work
 * when the whole point of this refusal is that no attempt will.
 */
export class StateHomeClaimRefusedError extends Error {
  constructor(
    readonly home: string,
    readonly decision: Extract<LayoutDecision, { kind: 'refuse' }>,
    readonly unexpectedEntries: readonly string[],
    repairCommand: string | undefined,
  ) {
    super(
      decision.reason === 'missing-marker'
        ? `refusing to write into ${home}: it already holds ${describe(unexpectedEntries)} and carries no ` +
            `${LAYOUT_VERSION_FILENAME} marker, so this may not be a Ferretry state home. ` +
            (repairCommand === undefined
              ? 'Point FY_HOME at the state home you meant, or remove those entries if this really is one'
              : `If it is one, run \`${repairCommand}\` to inspect it and claim it; ` +
                'otherwise point FY_HOME somewhere else')
        : `refusing to write into ${home}: its ${LAYOUT_VERSION_FILENAME} says ` +
            `${JSON.stringify(decision.found)} but this release creates and serves layout ` +
            `${String(decision.expected)}`,
    );
    this.name = 'StateHomeClaimRefusedError';
  }
}

/** A short, readable account of what was found, so a refusal is checkable at a glance. */
function describe(entries: readonly string[]): string {
  const shown = entries.slice(0, MAX_NAMED_ENTRIES);
  const rest = entries.length - shown.length;
  const names = shown.join(', ');
  return rest === 0 ? names : `${names} and ${String(rest)} more`;
}

/** Enough to recognise a directory; not so many that the message scrolls away. */
const MAX_NAMED_ENTRIES = 8;

/**
 * The top-level entries Ferretry itself puts directly in a state home.
 *
 * Only names at the top level are listed, because that is all a claim needs to classify: the
 * question is "did we make this directory", and a directory we made has no top-level entry we do not
 * recognise. What lives INSIDE `fleet/` or `state/` is not enumerated here on purpose — those are
 * the daemon's and the provisioner's business, and a client that policed their contents would be
 * reading the state it is not allowed to read.
 */
const FERRETRY_HOME_ENTRIES: ReadonlySet<string> = new Set([
  LAYOUT_VERSION_FILENAME,
  'config',
  'fleet',
  'logs',
  'state',
  'daemon.lock',
  // Minted by the daemon on first boot, at the top level rather than under `state/`.
  'api-token',
]);

/** Atomic writes name their scratch file `<target>.<id>.tmp`; only the marker's is ours to expect. */
function isMarkerScratchFile(name: string): boolean {
  const prefix = `${LAYOUT_VERSION_FILENAME}.`;
  const suffix = '.tmp';
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return false;
  return /^[a-zA-Z0-9-]+$/.test(name.slice(prefix.length, name.length - suffix.length));
}

/** Every entry that is not something Ferretry writes at the top level of a home. */
export function unexpectedHomeEntries(entries: readonly StateHomeEntry[]): readonly string[] {
  return entries
    .filter(entry => !FERRETRY_HOME_ENTRIES.has(entry.name) && !isMarkerScratchFile(entry.name))
    .map(entry => entry.name)
    .sort();
}

/** The mode a state home is created with: the owner's, and nobody else's. */
export const STATE_HOME_MODE = 0o700;

/**
 * The one shape a CLAIM may adopt without a person looking at it: a lone, unclaimed `logs/`.
 *
 * DELIBERATELY NARROWER than what `adopt` accepts, and it mirrors the daemon's `preBootstrapShape`
 * exactly rather than inventing a second opinion. An older `fy` on this same host creates the log
 * directory before launching the daemon and claims nothing, so upgrading to this release meets a
 * home holding exactly that and nothing else — and refusing those hosts would turn a bug fix into a
 * fresh breakage for every existing installation, which is the same failure this change exists to
 * remove. The daemon already treats this shape as legitimate pre-bootstrap state, so treating it as
 * foreign here would also mean the two writers disagreed again, in the opposite direction.
 *
 * Anything else — a `fleet/`, a `config/`, a `daemon.lock` — is NOT auto-adopted. Those say a real
 * installation was provisioned here, and taking one over silently is exactly the judgement `adopt`
 * exists to put in front of a person.
 */
function isLoneUnclaimedLogDirectory(entries: readonly StateHomeEntry[]): boolean {
  return entries.length > 0 && entries.every(entry => entry.directory && entry.name === 'logs');
}

/**
 * Claims a state home before this client writes anything inside it.
 *
 * Every client path that CREATES state under `<FY_HOME>` goes through here first, and paths that
 * only read must not: making a read claim a home would mean `fy --help` against a stranger's
 * `FY_HOME` creates a directory, and every read on a foreign home would refuse rather than answer.
 */
export class StateHomeClaimService {
  constructor(
    private readonly files: IStateHomeFilePort,
    /** Named in a refusal so the message carries the fix; the composition root spells the binary. */
    private readonly repairCommand: string,
  ) {}

  /** Where the marker lives, derived from the shared name rather than spelled a second time. */
  #markerPath(home: string): string {
    return home.endsWith('/') ? `${home}${LAYOUT_VERSION_FILENAME}` : `${home}/${LAYOUT_VERSION_FILENAME}`;
  }

  /**
   * Ensure the home exists and is ours, or refuse to touch it.
   *
   * Idempotent and cheap: an already-claimed home costs one directory listing and one small read, so
   * every write path can call this unconditionally rather than each deciding when it applies.
   */
  async claim(home: string): Promise<StateHomeClaim> {
    const marker = await this.files.readMarker(this.#markerPath(home));
    const entries = (await this.files.listHome(home)) ?? [];
    const decision = decideLayout(
      marker,
      entries.map(entry => entry.name),
      isLoneUnclaimedLogDirectory(entries),
    );
    if (decision.kind === 'refuse') {
      throw new StateHomeClaimRefusedError(home, decision, unexpectedHomeEntries(entries), this.repairCommand);
    }
    // Created even when the decision is `proceed`: `ensureDirectory` is how the mode is asserted, and
    // a home that exists with the wrong mode is one an earlier release or an operator's `mkdir` left.
    await this.files.ensureDirectory(home, STATE_HOME_MODE);
    if (decision.kind === 'proceed') return { kind: 'already-claimed', home };
    await this.files.writeMarkerAtomic(this.#markerPath(home), layoutVersionContent(), LAYOUT_VERSION_MODE);
    return { kind: 'claimed', home };
  }

  /**
   * Adopt a home that Ferretry recognisably created but never claimed — the upgrade path.
   *
   * DELIBERATELY BROADER than the daemon's automatic recovery shape, and the asymmetry is the point.
   * The daemon adopts SILENTLY, on boot, with nobody watching, so it may only adopt evidence of its
   * own interrupted bootstrap — an empty `fleet/`, never a provisioned one. This runs because a
   * person typed it, and it shows them what it found before it writes, so it can accept a home
   * carrying a real fleet, real logs and real config. That is a human claiming a directory after
   * being told what is in it, which is a different act from a service claiming one unattended.
   *
   * The rule survives intact: this still only ever adopts a shape Ferretry does create. A single
   * entry we do not write refuses the whole home and names it.
   */
  async adopt(home: string): Promise<StateHomeAdoption> {
    const marker = await this.files.readMarker(this.#markerPath(home));
    const entries = await this.files.listHome(home);
    if (entries === undefined) return { kind: 'absent', home };
    if (marker !== undefined) {
      const decision = decideLayout(marker, []);
      // An unreadable or future version is NOT repairable by claiming it again — writing our marker
      // over a version we do not understand is how a newer release's home gets silently downgraded.
      if (decision.kind === 'refuse') {
        throw new StateHomeClaimRefusedError(home, decision, [], this.repairCommand);
      }
      return { kind: 'already-claimed', home, entries: entries.map(entry => entry.name).sort() };
    }
    const unexpected = unexpectedHomeEntries(entries);
    if (unexpected.length > 0) {
      // No repair named: this IS the repair, and telling somebody to run the command they just ran
      // would read as a loop and imply a second attempt might work.
      throw new StateHomeClaimRefusedError(
        home,
        { kind: 'refuse', reason: 'missing-marker', found: undefined, expected: CURRENT_LAYOUT_VERSION },
        unexpected,
        undefined,
      );
    }
    await this.files.ensureDirectory(home, STATE_HOME_MODE);
    await this.files.writeMarkerAtomic(this.#markerPath(home), layoutVersionContent(), LAYOUT_VERSION_MODE);
    return { kind: 'adopted', home, entries: entries.map(entry => entry.name).sort() };
  }
}

/** What an adopt did, and what it saw while doing it. */
export type StateHomeAdoption =
  /** Nothing there: an adopt does not create a home, because there is nothing to recognise. */
  | { readonly kind: 'absent'; readonly home: string }
  | { readonly kind: 'already-claimed'; readonly home: string; readonly entries: readonly string[] }
  | { readonly kind: 'adopted'; readonly home: string; readonly entries: readonly string[] };
