/**
 * WHAT AGENDA PROVES IN AN ASK'S WORDS, beyond Board's `&F12` (`agenda-board-hooks.tsx`): `!A3` from a ferret's own
 * ledger, `:agent` from this daemon's fleet, and `@file` through Ferrets' file proof. Proof-before-link
 * (docs/reference-standard.md): each is supplied only when its evidence is in hand, and the text of an unproved
 * reference stays text.
 *
 *   - `!A3` ........ only on a ferret's own page, from THAT ferret's ledger (open and resolved items). Item ids are a
 *     ferret's own, so the machine-wide Inbox, which mixes ferrets, proves none.
 *   - `:agent` ..... Ferrets' addressing rule (`provedAgentReference`) over the fleet this half already reads; an
 *     unread fleet proves nothing. Every answer carries THIS daemon.
 *   - `@file` ...... Ferrets' folder-listing proof (`resolveFilePaths`) through this daemon's client, so the
 *     `filesystem` grant and the agent fence decide; and only with a ferret to ask about AND Ferrets' `ferrets.file-open`
 *     as the opener. No hook, a refused listing, or a denied, ignored or escaping entry leaves the path as prose.
 *
 * A kind the surface the ask sits in already proves (a chat that built its own) is left as it is.
 */

import { type FerretsFileOpen, provedAgentReference, resolveFilePaths } from '@ferretry/core-ferrets/contract';
import type { AgendaCall } from './agenda-call.ts';
import type { FerretView } from './ferret-view.ts';
import type { DaemonId } from './machine.ts';
import type { ReferenceSurface } from '../shell.ts';

/** What one ferret's own page knows that the machine-wide Inbox does not. */
export interface AgendaFerretReferences {
  readonly id: string;
  /** Every item id on the ferret's agenda, open and resolved: an answered item is still on the record. */
  readonly ledger: readonly string[];
  /** Opens one proved item. */
  readonly openAsk: (id: string) => void;
  /** Brings Files on screen after the opener asked for a path. */
  readonly showFiles: () => void;
}

export interface AgendaReferenceFacts {
  readonly daemonId: DaemonId;
  /** This daemon's ferrets; `null` is not read yet. */
  readonly fleet: readonly FerretView[] | null;
  readonly client: AgendaCall;
  /** Ferrets' `ferrets.file-open` (narrowed), when exactly one provider gives it. */
  readonly fileOpen: FerretsFileOpen | undefined;
  readonly ferret?: AgendaFerretReferences;
  /** In-app navigation, which is how a proved agent opens. */
  readonly onNavigate: (to: string) => void;
}

/** `outer` plus every kind the facts prove that `outer` does not already. */
export const agendaReferenceSurface = (outer: ReferenceSurface, facts: AgendaReferenceFacts): ReferenceSurface => {
  const { daemonId, fleet, client, fileOpen, ferret, onNavigate } = facts;
  const cwd = fleet?.find(view => view.config.id === ferret?.id)?.config.cwd;
  const ledger = ferret === undefined ? undefined : new Set(ferret.ledger);
  return {
    ...outer,
    ...(outer.agentReferenceResolver !== undefined || fleet === null
      ? {}
      : {
          agentReferenceResolver: lookup => {
            const proved = provedAgentReference(
              lookup,
              fleet.map(view => ({ id: view.config.id, name: view.config.teammate, status: view.state.status })),
            );
            return proved === null ? null : { daemonId, sessionId: proved.id, name: proved.name };
          },
        }),
    ...(outer.onNavigate === undefined ? { onNavigate } : {}),
    ...(outer.agendaReferenceResolver !== undefined || ledger === undefined || ferret === undefined
      ? {}
      : { agendaReferenceResolver: id => ledger.has(id), onAgendaOpen: id => ferret.openAsk(id) }),
    ...(outer.resolveFilePaths !== undefined || ferret === undefined || fileOpen === undefined
      ? {}
      : {
          resolveFilePaths: async (candidates, signal) =>
            new Map(await resolveFilePaths(client, ferret.id, candidates, cwd, signal)),
          onCodeReferenceOpen: reference => {
            if (fileOpen.open(ferret.id, reference.path)) ferret.showFiles();
          },
        }),
  };
};
