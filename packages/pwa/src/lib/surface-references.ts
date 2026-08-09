/**
 * Live proof for `%terminal:…` / `%browser:…` references.
 *
 * The grammar, the envelope and the tombstone live in `references.ts`; this module
 * owns the one index that turns a surface key into a surface the daemon is
 * actually holding. Syntax is never existence proof — without an answer from
 * here, `%terminal:abc123abc123` stays plain prose.
 *
 * ONE (DAEMON, SESSION) PER RESOLVER, and unlike the agent resolver that is not
 * merely a collision guard: it is what the reference MEANS. A daemon mints
 * terminal ids per box, and the twelve hex characters that name a shell in
 * session A name nothing at all in session B. A resolver is therefore built for
 * exactly one `(daemonId, sessionId)` pair, stamps every answer with both, and
 * can only be built from that pair's own terminal listing.
 *
 * THREE ANSWERS, NOT TWO. `SurfaceProof` distinguishes "the daemon is holding it"
 * from "the daemon's own complete list does not contain it" from "we have no
 * evidence". The middle one is what makes a dangling reference say so instead of
 * quietly reprinting as prose; the last one is why a listing for the wrong
 * session, or no listing at all, proves nothing in either direction.
 *
 * WHY THE LISTING IS AUTHORITATIVE ENOUGH TO PROVE ABSENCE. `GET
 * /v1/sessions/:id/terminals` answers with every terminal the daemon holds for
 * that session, bounded by `limits.perSession`, and the protocol's own schema
 * refuses a listing whose rows belong to another session. It is a complete
 * enumeration, not a page of one — so an id that is missing from it is missing,
 * full stop.
 *
 * BROWSER PAGES ARE DELIBERATELY UNPROVABLE HERE. The daemon serves
 * `/v1/sessions/:id/browser` for real now and its status carries a page list, but
 * nothing hands that list to this module. So a `%browser:…` token resolves to
 * NOTHING — not to a link, and not to a tombstone either, because this module has
 * no authoritative page list and must not report a page as closed on no evidence.
 * Teaching this resolver to read that status is the whole remaining change: the
 * token, the envelope, the identity, the picker row and the tombstone are all
 * key-agnostic already.
 */

import type { SurfaceOpener, TerminalListView, TerminalView } from '@ferretry/protocol';
import type { DaemonSessionScope } from './daemon-scope.ts';
import { daemonSessionKey } from './daemon-scope.ts';
import { formatReference, type SurfaceKind, type SurfaceProof, type SurfaceReferenceResolver } from './references.ts';

/**
 * Who opened a surface, as far as the owner can attest it.
 *
 * The three attested classes are the daemon's own (`SurfaceOpener`): a paired
 * device is a human, `local` is the box's own credential with no agent named, and
 * `agent` names the session driving it. The daemon derives all three from the
 * credential that authenticated the request, so a remote device cannot label its
 * own shell as an agent's.
 *
 * `unrecorded` is the FOURTH answer and is a first-class one: it is the only
 * honest reading for a terminal this daemon cannot speak for — one opened before
 * provenance was recorded, or by a build that never recorded it. It is NOT
 * rendered as "the human": a guess that happens to be right most of the time is
 * still a claim made without evidence, and ownership is exactly the fact a reader
 * consults before typing into a shell an agent is driving.
 */
export type SurfaceOwnership = SurfaceOpener | { readonly by: 'unrecorded' };

/**
 * How a row states ownership, and the tone it deserves.
 *
 * `agent` is the one that carries a warning tone: it is the case where typing
 * lands in a shell something else is already driving. `unrecorded` is neutral —
 * it is an absence of evidence, not a hazard, and colouring it like one would
 * teach a reader to ignore the colour that matters.
 */
export interface SurfaceOwnershipLabel {
  readonly text: string;
  /** A ROLE, not a colour — the shell's badge maps it to one. */
  readonly tone: 'warn' | 'pend' | 'accent';
  /** The identity behind the class, for a title attribute. Never invented. */
  readonly detail?: string;
}

export const describeSurfaceOwnership = (ownership: SurfaceOwnership): SurfaceOwnershipLabel => {
  if (ownership.by === 'agent')
    return { text: 'Opened by an agent', tone: 'warn', detail: `agent session ${ownership.sessionId}` };
  if (ownership.by === 'human')
    return { text: 'Opened from a paired device', tone: 'accent', detail: `device ${ownership.deviceId}` };
  if (ownership.by === 'local') return { text: 'Opened on the daemon host', tone: 'accent' };
  return { text: 'Owner unrecorded', tone: 'pend' };
};

/** One addressable surface, as the picker, the pane header and Add to chat need
 *  it: the canonical token, plus the live facts that help a reader choose. */
export interface SessionSurface {
  readonly surface: SurfaceKind;
  /** The owner's identity for it — a daemon terminal id today. */
  readonly key: string;
  /** The canonical authored token, e.g. `%terminal:ab12cd34ef56`. */
  readonly token: string;
  readonly title: string;
  readonly ownership: SurfaceOwnership;
  /** Live viewers attached to the surface right now. */
  readonly viewers: number;
  readonly lastActivityAt: string;
}

const surfaceToken = (surface: SurfaceKind, key: string): string => formatReference({ kind: 'surface', surface, key });

/**
 * The listing, but only when it may be read as evidence about THIS scope.
 *
 * A listing whose `sessionId` is not the scope's session is not an empty answer
 * about this session — it is an answer about a different one, and reading it as
 * "no terminals here" would report every live terminal as closed.
 */
const evidenceFor = (
  scope: DaemonSessionScope,
  terminals: TerminalListView | null | undefined,
): TerminalListView | null =>
  terminals !== null && terminals !== undefined && terminals.sessionId === scope.sessionId ? terminals : null;

/** Projects a daemon listing into picker rows, in the daemon's own creation order
 *  — the order the reader built them in. Sorting by activity instead would move
 *  the row out from under their finger while they reached for it. */
export const sessionSurfaces = (
  scope: DaemonSessionScope,
  terminals: TerminalListView | null | undefined,
): readonly SessionSurface[] =>
  (evidenceFor(scope, terminals)?.terminals ?? []).map(
    (terminal: TerminalView): SessionSurface => ({
      surface: 'terminal',
      key: terminal.id,
      token: surfaceToken('terminal', terminal.id),
      title: terminal.title,
      // An absent opener is the daemon saying it cannot speak for this pane, and
      // it stays absent here rather than becoming a default.
      ownership: terminal.openedBy ?? { by: 'unrecorded' },
      viewers: terminal.viewers,
      lastActivityAt: terminal.lastActivityAt,
    }),
  );

/**
 * Builds one immutable resolver from an already-fetched terminal listing.
 *
 * A null listing (never fetched, or a failed request) resolves NOTHING: the
 * caller has no evidence, and inventing either answer from that is the failure
 * mode this migration has hit three times.
 */
export const createSurfaceReferenceResolver = (
  scope: DaemonSessionScope,
  terminals: TerminalListView | null | undefined,
): SurfaceReferenceResolver => {
  const evidence = evidenceFor(scope, terminals);
  const open = new Set(evidence?.terminals.map(terminal => terminal.id) ?? []);

  return lookup => {
    // No authoritative listing means no answer, in either direction.
    if (evidence === null) return undefined;
    // Pages have no evidence source on this daemon, so they are unproved rather
    // than closed. See the module comment.
    if (lookup.surface !== 'terminal') return undefined;
    if (!open.has(lookup.key)) return { state: 'closed' } satisfies SurfaceProof;
    return {
      state: 'open',
      daemonId: scope.daemonId,
      sessionId: scope.sessionId,
      surface: 'terminal',
      key: lookup.key,
    } satisfies SurfaceProof;
  };
};

/**
 * A key over the ONLY facts the resolver reads, so terminal activity churn does
 * not reparse every rendered Markdown block. Opening or closing a terminal
 * changes it, which is exactly when a reference's proof changes.
 *
 * The scope is part of the key for the same reason it is part of the resolver:
 * two sessions routinely carry different terminals, and reusing one's resolver
 * for the other is the bug this module exists to prevent. An absent listing has
 * its own key — it is a different state from an empty one.
 */
export const surfaceReferenceIdentityKey = (
  scope: DaemonSessionScope,
  terminals: TerminalListView | null | undefined,
): string => {
  const evidence = evidenceFor(scope, terminals);
  return [
    daemonSessionKey(scope),
    evidence === null ? 'unlisted' : 'listed',
    ...(evidence?.terminals.map(terminal => terminal.id) ?? []),
  ].join('\u0001');
};
