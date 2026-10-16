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

import {
  type AgentAddressCandidate,
  isLiveAgentCandidate,
  resolveAgentAddress,
  type SessionView,
} from '@ferretry/protocol';
import type { DaemonId } from './daemon-connection.ts';
import type { AgentReferenceResolver, ResolvedAgent } from './references.ts';

const TEAMMATE_NAME = /^[a-z][a-z0-9-]{0,31}$/iu;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const normalizedName = (raw: string | undefined): string | null => {
  const name = raw?.trim().toLowerCase() ?? '';
  return TEAMMATE_NAME.test(name) ? name : null;
};

const safeSessionId = (raw: string): boolean => SESSION_ID.test(raw) && raw !== '.' && raw !== '..';

/** A session as name resolution reads it. The view's state may be absent in a partial snapshot. */
const candidateOf = (view: SessionView, name: string): AgentAddressCandidate => ({
  id: view.config.id,
  name,
  status: (view as { readonly state?: { readonly status?: string } }).state?.status,
});

/**
 * Builds one immutable resolver from an already-live fleet snapshot.
 *
 * Exact ids resolve for the whole retained fleet, which is why an old finished
 * transcript remains referenceable. Bare names follow the protocol's addressing
 * rule (`resolveAgentAddress`) — the very one the daemon applies when an agent
 * runs `fy send <name>` — case-insensitive, the live holder preferred, and a
 * name two sessions hold on the same footing proves nothing and stays prose.
 */
export const createAgentReferenceResolver = (
  daemonId: DaemonId,
  sessions: readonly SessionView[],
): AgentReferenceResolver => {
  const byId = new Map<string, ResolvedAgent>();
  const candidates: AgentAddressCandidate[] = [];

  for (const view of sessions) {
    const name = normalizedName(view.config.teammate);
    if (!name || !safeSessionId(view.config.id)) continue;
    byId.set(view.config.id, { daemonId, sessionId: view.config.id, name });
    candidates.push(candidateOf(view, name));
  }

  return lookup => {
    if (lookup.sessionId !== undefined) return byId.get(lookup.sessionId) ?? null;
    const name = normalizedName(lookup.name);
    if (!name) return null;
    const resolution = resolveAgentAddress(name, candidates);
    return resolution.kind === 'session' ? (byId.get(resolution.id) ?? null) : null;
  };
};

/**
 * A key over the ONLY facts the resolver reads, so status and activity churn
 * does not make every already-rendered Markdown block parse again. A newly
 * hydrated or renamed callsign — or a holder going live or dormant, which can
 * move a name to another session — changes it and re-proves at once.
 *
 * The daemon is part of the key: two daemons' fleets can carry identical session
 * ids and callsigns, and reusing one's resolver for the other is the exact bug
 * this module exists to prevent.
 */
export const agentReferenceIdentityKey = (daemonId: DaemonId, sessions: readonly SessionView[]): string =>
  [
    daemonId,
    ...sessions.flatMap(view => {
      const name = normalizedName(view.config.teammate);
      if (!name) return [];
      const live = isLiveAgentCandidate(candidateOf(view, name)) ? 'live' : 'dormant';
      return [`${view.config.id}\u0000${view.config.teammate}\u0000${live}`];
    }),
  ].join('\u0001');
