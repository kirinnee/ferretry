/**
 * The addressing surface: every terminal this session owns, with its reference.
 *
 * This is where the human and the agent come to agree on WHICH shell they are
 * talking about. A row shows the terminal's own title, the canonical token that
 * names it, how many viewers are attached to it right now, and what is known
 * about who opened it — and Add to chat drops the token straight into this
 * session's message, so an id never has to be transcribed by hand. A
 * mistranscribed terminal id is not a typo: it addresses a different shell.
 *
 * THE DAEMON IS THE ONLY SOURCE. Rows come from `GET
 * /v1/sessions/:id/terminals`, so what is listed is what the daemon is holding —
 * not what this browser opened, not what a side-pane strip remembers. That is
 * also why a reference survives a phone sleeping and waking: the id was minted by
 * the daemon and outlives every reconnect.
 *
 * OWNERSHIP IS SHOWN AS UNRECORDED, WHICH IS THE HONEST READING. Handover #34
 * asks for durable, visible ownership of agent-launched surfaces. This daemon
 * records no provenance for a terminal, and no agent can open one through the
 * API today, so a row states that plainly instead of printing "you opened this" —
 * a guess that is usually right is still a claim made without evidence, and
 * ownership is exactly the fact a reader consults before typing into a shell an
 * agent may be driving.
 *
 * WHAT IS NOT HERE. There is no live terminal renderer in the PWA yet (see
 * `SessionTerminalSurface`), so this pane addresses and attributes terminals; it
 * does not stream one. Co-control — the agent driving while the human watches and
 * takes over — needs that renderer and is the next unit's work.
 */

import type { TerminalListView } from '@ferretry/protocol';
import { useCallback, useEffect, useId, useState } from 'react';
import { browserClipboardWriter, type ClipboardWriter, CopyButton } from '../features/onboarding/copy-button.tsx';
import { addReferenceMessage, addReferenceToComposer } from '../lib/composer-references.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../lib/daemon-scope.ts';
import type { DaemonFetch } from '../lib/runtime-models.ts';
import { type SessionSurface, sessionSurfaces } from '../lib/surface-references.ts';
import { listSessionTerminals } from '../lib/web-terminals.ts';
import { Badge, Button } from '../shell/primitives.tsx';

/** Injected so a test can drive every state without a live daemon. */
export type SurfaceTerminalLister = (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  fetcher?: DaemonFetch,
) => Promise<TerminalListView>;

export interface SessionSurfaceReferencesProps {
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  readonly listTerminals?: SurfaceTerminalLister;
  readonly write?: ClipboardWriter;
}

type Load =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly surfaces: readonly SessionSurface[] }
  | { readonly status: 'error'; readonly reason: string };

const failure = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

const viewerLabel = (viewers: number): string => {
  if (viewers === 0) return 'No viewer attached';
  return viewers === 1 ? '1 viewer attached' : `${viewers} viewers attached`;
};

export function SessionSurfaceReferences({
  connection,
  scope,
  listTerminals = listSessionTerminals,
  write = browserClipboardWriter(),
}: SessionSurfaceReferencesProps) {
  const headingId = useId();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [message, setMessage] = useState('');

  // `attempt` is in the dependency list although the body never reads it: it is
  // the retry trigger, and the whole point of Try again is to ask the daemon the
  // same question a second time. Dropping it would make the button inert.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the retry trigger
  useEffect(() => {
    const controller = new AbortController();
    setLoad({ status: 'loading' });
    // The listing is asked for once per mount and once per explicit retry. It is
    // not polled: a stale row is a stale OFFER, and the reference it carries is
    // proved again by whoever renders or redeems it.
    listTerminals(connection, scope)
      .then(listing => {
        if (controller.signal.aborted) return;
        // A listing about another session is damaged evidence, not an empty
        // session. Projecting it would print "no terminals" while the reader's
        // shells are running, and the reference of any row it did carry would
        // belong to a session this pane is not showing.
        if (listing.sessionId !== scope.sessionId) {
          setLoad({ status: 'error', reason: 'it answered about a different session' });
          return;
        }
        setLoad({ status: 'ready', surfaces: sessionSurfaces(scope, listing) });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        // A failed listing is NOT an empty session. Saying "no terminals" here
        // would tell the reader their shells are gone because a request failed.
        setLoad({ status: 'error', reason: failure(reason) });
      });
    return () => controller.abort();
  }, [attempt, connection, listTerminals, scope]);

  const add = useCallback(
    (surface: SessionSurface): void => {
      const outcome = addReferenceToComposer({ kind: 'surface', surface: surface.surface, key: surface.key }, scope);
      setMessage(addReferenceMessage(outcome, surface.token));
    },
    [scope],
  );

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2" data-surface-references="">
      <div className="min-w-0">
        <h3 className="m-0 font-display text-title font-semibold" id={headingId}>
          Addressable terminals
        </h3>
        <p className="mb-0 mt-1 text-ui text-muted">
          Each terminal carries a stable reference for this session. Add it to your message and the agent acts on that
          exact shell — never on whichever one happens to be in front of it. This daemon does not record who opened a
          terminal, so ownership below reads as unrecorded.
        </p>
      </div>

      {load.status === 'loading' ? (
        <p className="m-0 text-ui text-muted" role="status">
          Asking the daemon which terminals it holds for this session…
        </p>
      ) : null}

      {load.status === 'error' ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="m-0 text-ui text-err" role="alert">
            The daemon did not answer with its terminal list, so none can be addressed: {load.reason}
          </p>
          <Button onClick={() => setAttempt(count => count + 1)} size="sm" type="button">
            Try again
          </Button>
        </div>
      ) : null}

      {load.status === 'ready' && load.surfaces.length === 0 ? (
        <p className="m-0 text-ui text-muted" role="status">
          This session holds no terminal yet, so there is nothing to address.
        </p>
      ) : null}

      {load.status === 'ready' && load.surfaces.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {load.surfaces.map(surface => (
            <li
              className="flex min-w-0 flex-wrap items-center gap-2 rounded-control border border-border-soft px-2 py-1"
              data-surface-key={surface.key}
              key={surface.key}
            >
              <span className="min-w-0 truncate font-medium text-ui">{surface.title}</span>
              {/* Selectable by hand as well as copyable: the token is the fact
                  this row exists to hand over. */}
              <code className="mono min-w-0 truncate text-meta text-faint">{surface.token}</code>
              <Badge tone="pend">{viewerLabel(surface.viewers)}</Badge>
              <Badge tone="warn">Owner unrecorded</Badge>
              <Button onClick={() => add(surface)} size="sm" type="button" variant="primary">
                Add to chat
              </Button>
              <CopyButton label={`Copy the reference for ${surface.title}`} text={surface.token} write={write} />
            </li>
          ))}
        </ul>
      ) : null}

      {/* Present from first paint and empty until there is news: a live region
          added at the same moment it fills announces nothing at all. */}
      <p className={message === '' ? 'sr-only' : 'm-0 text-ui text-muted'} data-surface-add-status="" role="status">
        {message}
      </p>
    </section>
  );
}
