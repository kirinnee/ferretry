/**
 * Fleet-backed proof for `:callsign` references.
 *
 * The grammar and the remark transform live in `references.ts`; this module owns
 * only the live index that turns a callsign into a real session. Syntax is never
 * existence proof — without an answer from here, `:zelda` stays plain prose.
 *
 * ONE DAEMON PER RESOLVER, and it is not a detail. kteam indexed its single
 * fleet by session id and by callsign, and answered with a bare session id
 * (`src/lib/agent-mentions.ts`). Session ids are minted per daemon and collide
 * freely across two of them, and callsigns collide even more readily — a reader
 * paired to a laptop and a workstation can easily have a `:zelda` on each. A
 * resolver is therefore built for exactly one `DaemonId`, stamps every answer
 * with it, and can only be built from that daemon's own fleet slice. A transcript
 * rendered for daemon A cannot resolve a reference into daemon B's session,
 * because it never holds a resolver that could answer with B.
 *
 * WHAT IS DELIBERATELY NOT PORTED. kteam's legacy `#…-agent-mention` href
 * family (`agentMentionHref`, `parseAgentMentionHref`, `agentSessionHref`) existed
 * to keep already-persisted Markdown clickable across its own rename. Ferretry
 * has no such history: a proved reference is encoded by `referenceHref` and
 * navigated with `daemonSessionPath`, which is daemon-aware. Reviving those
 * helpers would reintroduce the single-daemon `/session/:id` destination the
 * survey flagged (`pwa-shape.md:115`).
 */

import type { SessionView } from '@ferretry/protocol';
import type { DaemonId } from './daemon-connection.ts';
import type { AgentReferenceResolver, ResolvedAgent } from './references.ts';

/**
 * How long a bare callsign keeps resolving to its newest holder. Mirrors the
 * daemon's own callsign semantics rather than inventing a UI rule: a name is
 * reusable, so an old session must not keep claiming it forever.
 */
const NAME_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
const TEAMMATE_NAME = /^[a-z][a-z0-9-]{0,31}$/iu;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const normalizedName = (raw: string | undefined): string | null => {
  const name = raw?.trim().toLowerCase() ?? '';
  return TEAMMATE_NAME.test(name) ? name : null;
};

const safeSessionId = (raw: string): boolean => SESSION_ID.test(raw) && raw !== '.' && raw !== '..';

const createdAt = (view: SessionView): number => {
  const value = Date.parse(view.config.createdAt);
  return Number.isFinite(value) ? value : 0;
};

/**
 * Builds one immutable resolver from an already-live fleet snapshot.
 *
 * Exact ids resolve for the whole retained fleet, which is why an old finished
 * transcript remains referenceable. Bare names mirror the daemon's callsign
 * semantics: case-insensitive, sessions created inside the name window, newest
 * holder wins.
 */
export const createAgentReferenceResolver = (
  daemonId: DaemonId,
  sessions: readonly SessionView[],
  now: number = Date.now(),
): AgentReferenceResolver => {
  const byId = new Map<string, ResolvedAgent>();
  const byName = new Map<string, { readonly target: ResolvedAgent; readonly createdAt: number }>();
  const cutoff = now - NAME_WINDOW_MS;

  for (const view of sessions) {
    const name = normalizedName(view.config.teammate);
    if (!name || !safeSessionId(view.config.id)) continue;
    const target: ResolvedAgent = { daemonId, sessionId: view.config.id, name };
    byId.set(view.config.id, target);

    const created = createdAt(view);
    if (created < cutoff) continue;
    const current = byName.get(name);
    if (!current || created > current.createdAt) byName.set(name, { target, createdAt: created });
  }

  return lookup => {
    if (lookup.sessionId !== undefined) return byId.get(lookup.sessionId) ?? null;
    const name = normalizedName(lookup.name);
    return name ? (byName.get(name)?.target ?? null) : null;
  };
};

/**
 * A key over the ONLY fields the resolver copies, so status and activity churn
 * does not make every already-rendered Markdown block parse again. A newly
 * hydrated or renamed callsign changes it and becomes referenceable at once.
 *
 * The daemon is part of the key: two daemons' fleets can carry identical session
 * ids and callsigns, and reusing one's resolver for the other is the exact bug
 * this module exists to prevent.
 */
export const agentReferenceIdentityKey = (daemonId: DaemonId, sessions: readonly SessionView[]): string =>
  [
    daemonId,
    ...sessions.flatMap(view =>
      normalizedName(view.config.teammate)
        ? [`${view.config.id}\u0000${view.config.teammate}\u0000${view.config.createdAt}`]
        : [],
    ),
  ].join('\u0001');
