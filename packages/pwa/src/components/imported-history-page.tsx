import type { ForeignHistoryListing, ImportedConversationDetail } from '@ferretry/protocol';
import { useEffect, useState } from 'react';
import type { DaemonConnection } from '../lib/daemon-connection.ts';

export interface ImportedHistoryPageProps {
  readonly connection: DaemonConnection;
  readonly readHistory: (connection: DaemonConnection) => Promise<ForeignHistoryListing>;
  readonly readConversation: (connection: DaemonConnection, id: string) => Promise<ImportedConversationDetail>;
}

/**
 * A deliberately quiet archival surface. Imported conversations are useful evidence, not live
 * sessions: the page says so before a person reaches for a control that cannot truthfully exist.
 */
export function ImportedHistoryPage({ connection, readHistory, readConversation }: ImportedHistoryPageProps) {
  const [history, setHistory] = useState<ForeignHistoryListing>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<ImportedConversationDetail>();

  useEffect(() => {
    let active = true;
    void readHistory(connection).then(
      next => {
        if (active) setHistory(next);
      },
      cause => {
        if (active) setError(cause instanceof Error ? cause.message : 'Imported history could not be read.');
      },
    );
    return () => {
      active = false;
    };
  }, [connection, readHistory]);

  return (
    <section aria-labelledby="imported-history-heading" className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-8">
      <p className="fy-eyebrow">Archive · {connection.daemonId}</p>
      <div className="mt-2 border-l-4 border-accent pl-5">
        <h1 id="imported-history-heading" className="font-display text-3xl font-bold tracking-display">
          Imported history
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Conversations found in your Claude and Codex homes. They are read-only records, not Ferretry sessions, so they
          cannot be resumed or sent messages.
        </p>
      </div>
      {error !== undefined ? (
        <p className="mt-8 rounded border border-danger/40 bg-danger/10 p-4 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : history === undefined ? (
        <p className="mt-8 text-sm text-muted" role="status">
          Reading local harness history…
        </p>
      ) : (
        <>
          {history.conversations.length === 0 ? (
            <p className="mt-8 rounded border border-border bg-surface p-5 text-sm text-muted">
              No readable imported conversations were found for this daemon.
            </p>
          ) : (
            <ul className="mt-8 grid gap-3" aria-label="Imported conversations">
              {history.conversations.map(conversation => (
                <li className="rounded border border-border bg-surface p-4" key={conversation.id}>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-medium text-fg">{conversation.title}</p>
                      <p className="mt-1 text-xs text-muted">
                        {conversation.harness === 'claude' ? 'Claude Code' : 'Codex'} · {conversation.eventCount}{' '}
                        recorded events
                      </p>
                    </div>
                    <span className="shrink-0 rounded border border-border px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-muted">
                      Read-only
                    </span>
                  </div>
                  <button
                    className="mt-3 text-sm font-medium text-accent underline decoration-accent/40 underline-offset-4"
                    onClick={() => {
                      void readConversation(connection, conversation.id).then(
                        next => setSelected(next),
                        cause =>
                          setError(
                            cause instanceof Error ? cause.message : 'This imported conversation could not be read.',
                          ),
                      );
                    }}
                    type="button"
                  >
                    Read conversation
                  </button>
                </li>
              ))}
            </ul>
          )}
          {selected !== undefined && (
            <section
              className="mt-8 border-t-2 border-accent pt-6"
              aria-label={`Imported conversation: ${selected.conversation.title}`}
            >
              <p className="fy-eyebrow">Read-only transcript</p>
              <h2 className="mt-1 font-display text-2xl font-semibold">{selected.conversation.title}</h2>
              <div className="mt-5 grid gap-3">
                {selected.messages.map(message => (
                  <article
                    className={
                      message.role === 'user'
                        ? 'ml-auto max-w-[90%] rounded bg-accent-soft p-4'
                        : 'max-w-[90%] rounded border border-border p-4'
                    }
                    key={message.id}
                  >
                    <p className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">{message.role}</p>
                    <p className="whitespace-pre-wrap text-sm leading-6">{message.text}</p>
                  </article>
                ))}
              </div>
            </section>
          )}
          {history.skipped.length > 0 && (
            <aside className="mt-8 border-t border-border pt-5" aria-label="Skipped imported transcripts">
              <h2 className="font-display text-lg font-semibold">
                {history.skipped.length} transcript(s) not imported
              </h2>
              <p className="mt-1 text-sm text-muted">
                Ferretry did not replace unreadable history with an empty conversation.
              </p>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">
                {history.skipped.map(skipped => (
                  <li key={`${skipped.harness}:${skipped.reason}`}>
                    {skipped.count} {skipped.harness === 'claude' ? 'Claude Code' : 'Codex'}: {skipped.reason}
                  </li>
                ))}
              </ul>
            </aside>
          )}
        </>
      )}
    </section>
  );
}
