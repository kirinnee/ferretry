import { LAYOUT_VERSION_FILENAME, type LayoutDecision } from '@ferretry/protocol';
import type { FoundationPaths } from './paths.ts';

/**
 * The layout decision is NOT defined here.
 *
 * It moved to `@ferretry/protocol` because the command-line client has to apply the identical rule:
 * it creates state inside a home before this daemon has ever run, so a home it created and did not
 * claim arrives here as a non-empty directory with no marker — indistinguishable from a stranger's
 * data, and refused forever. See `packages/protocol/src/lib/state-home-layout.ts` for the full
 * argument. These names are re-exported so every call site in this package is unchanged and there is
 * exactly one definition to read.
 */
export {
  CURRENT_LAYOUT_VERSION,
  type LayoutDecision,
  LAYOUT_VERSION_FILENAME,
  LAYOUT_VERSION_MODE,
  type LayoutRefusalReason,
  decideLayout,
  layoutVersionContent,
} from '@ferretry/protocol';

/**
 * Version 2 creates `events.jsonl`, empty, as part of creating the session directory, before the
 * marker is written. The marker is therefore durable, non-disposable proof that a journal exists,
 * which the SQLite index — dropped and rebuilt by design — can never be.
 *
 * A SESSION's marker, not the home's: it is owned here because only this package creates or reads a
 * session directory, so there is no second writer to agree with.
 */
export const CURRENT_SESSION_VERSION = 2 as const;

export type SessionMarkerDecision = 'proceed' | 'refuse';

const LEGACY_SESSION_VERSION = '1' as const;
const SUPPORTED_SESSION_VERSIONS: ReadonlySet<string> = new Set([
  LEGACY_SESSION_VERSION,
  String(CURRENT_SESSION_VERSION),
]);

/**
 * Whether a session directory may be read at all.
 *
 * Deliberately still two-valued: every call site compares against `'proceed'` or `'refuse'`, and a
 * third arm for "legacy" would silently read every version-1 session as refused and drop it from the
 * index. The version-specific questions are separate predicates below.
 */
export function decideSessionMarker(marker: string | undefined): SessionMarkerDecision {
  return marker !== undefined && SUPPORTED_SESSION_VERSIONS.has(marker.trim()) ? 'proceed' : 'refuse';
}

/** Under version 2 a missing journal is lost history, never emptiness. */
export function sessionJournalRequired(marker: string | undefined): boolean {
  return marker?.trim() === String(CURRENT_SESSION_VERSION);
}

/** A version-1 directory predates the journal contract and is upgraded in place. */
export function sessionMarkerNeedsUpgrade(marker: string | undefined): boolean {
  return marker?.trim() === LEGACY_SESSION_VERSION;
}

/**
 * The command that repairs an unmarked home this daemon will not adopt on its own.
 *
 * NAMED HERE, in the refusal, because the refusal is permanent without it: every release before the
 * claim landed left provisioned homes with no marker, so an owner who ran the client first meets this
 * message on a home they populated correctly and has no way to learn that the fix is one command
 * rather than `rm -rf`. Precedent for this package naming a client command is `authFailureRemedy` in
 * `./usage/quota.ts`; the client name is written out for the same reason it is there — this package
 * cannot read the client package's `bin` key without depending on it.
 */
const ADOPT_COMMAND = 'fy daemon adopt';

export class StateHomeLayoutError extends Error {
  constructor(
    readonly paths: FoundationPaths,
    readonly decision: Extract<LayoutDecision, { kind: 'refuse' }>,
  ) {
    super(
      decision.reason === 'missing-marker'
        ? `state home ${paths.home} is non-empty but has no ${LAYOUT_VERSION_FILENAME} marker; ` +
            `if this home was created by Ferretry, run \`${ADOPT_COMMAND}\` to inspect it and claim it`
        : `state home ${paths.home} has layout version ${JSON.stringify(decision.found)}; expected ${decision.expected}`,
    );
    this.name = 'StateHomeLayoutError';
  }
}
