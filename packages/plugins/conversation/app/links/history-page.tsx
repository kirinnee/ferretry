/**
 * THE HARNESSES' OWN HISTORY, READ-ONLY (today's `imported-history-page.tsx`, the Imported history route): the
 * conversations found in the owner's Claude Code and Codex homes, as records. They are evidence, not ferrets: the page
 * says so before a person reaches for a control that cannot truthfully exist. `GET /v1/links/history` lists them and
 * `GET /v1/links/history/:entryId` reads one, through the half's client.
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { ForeignHistoryListSchema, ForeignHistorySchema } from '../../contract/index.ts';

export type HistoryList = z.infer<typeof ForeignHistoryListSchema>;
export type HistoryEntry = z.infer<typeof ForeignHistorySchema>;

export const readHistory = async (client: Pick<PluginClient, 'call'>): Promise<HistoryList> =>
  ForeignHistoryListSchema.parse(await client.call('GET /v1/links/history'));

export const readHistoryEntry = async (client: Pick<PluginClient, 'call'>, entryId: string): Promise<HistoryEntry> =>
  ForeignHistorySchema.parse(await client.call('GET /v1/links/history/:entryId', { params: { entryId } }));

/** The harness as a reader calls it. */
export const harnessName = (harness: string): string =>
  harness === 'claude-code' ? 'Claude Code' : harness === 'codex' ? 'Codex' : harness;

export interface HistoryPageProps {
  /** The daemon the history is on, for the eyebrow. */
  readonly daemon: string;
  readonly readHistory: () => Promise<HistoryList>;
  readonly readEntry: (entryId: string) => Promise<HistoryEntry>;
}

export function HistoryPage({ daemon, readHistory: read, readEntry }: HistoryPageProps) {
  const [history, setHistory] = useState<HistoryList>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<HistoryEntry>();

  useEffect(() => {
    let active = true;
    void read().then(
      next => {
        if (active) setHistory(next);
      },
      cause => {
        if (active) setError(cause instanceof Error ? cause.message : 'The harness history could not be read.');
      },
    );
    return () => {
      active = false;
    };
  }, [read]);

  return (
    <section aria-labelledby="link-history-heading" className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-8">
      <p className="fy-eyebrow [overflow-wrap:anywhere]">Archive · {daemon}</p>
      <div className="mt-2">
        <h2 id="link-history-heading" className="font-display text-2xl font-bold tracking-display">
          Harness history
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Conversations found in your Claude Code and Codex homes. They are read-only records, not ferrets, so they
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
          {history.entries.length === 0 ? (
            <p className="mt-8 rounded border border-border bg-surface p-5 text-sm text-muted">
              No readable harness conversations were found on this daemon.
            </p>
          ) : (
            <ul className="mt-8 grid gap-3" aria-label="Harness conversations">
              {history.entries.map(entry => (
                <li className="rounded border border-border bg-surface p-4" key={`${entry.harness}:${entry.id}`}>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-medium text-fg">{entry.title ?? entry.id}</p>
                      <p className="mt-1 text-xs text-muted">
                        {harnessName(entry.harness)} · {entry.turnsAtLeast === true ? 'at least ' : ''}
                        {entry.turns} recorded {entry.turns === 1 && entry.turnsAtLeast !== true ? 'turn' : 'turns'}
                      </p>
                    </div>
                    <span className="shrink-0 rounded border border-border px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-muted">
                      Read-only
                    </span>
                  </div>
                  <button
                    className="mt-3 text-sm font-medium text-accent underline decoration-accent/40 underline-offset-4"
                    onClick={() => {
                      void readEntry(entry.id).then(
                        next => setSelected(next),
                        cause =>
                          setError(cause instanceof Error ? cause.message : 'This conversation could not be read.'),
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
              className="mt-8 border-t-heavy border-accent pt-6"
              aria-label={`Harness conversation: ${selected.entry.title ?? selected.entry.id}`}
            >
              <p className="fy-eyebrow">Read-only transcript</p>
              <h3 className="mt-1 font-display text-xl font-semibold">{selected.entry.title ?? selected.entry.id}</h3>
              <div className="mt-5 grid gap-3">
                {selected.messages.map((message, index) => (
                  <article
                    className={
                      message.role === 'user'
                        ? 'ml-auto max-w-[90%] rounded bg-accent-soft p-4'
                        : 'max-w-[90%] rounded border border-border p-4'
                    }
                    // The transcript is a fixed record: its order is its identity.
                    // biome-ignore lint/suspicious/noArrayIndexKey: see above.
                    key={index}
                  >
                    <p className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">{message.role}</p>
                    <p className="whitespace-pre-wrap text-sm leading-6">{message.text}</p>
                  </article>
                ))}
              </div>
            </section>
          )}
          {history.skipped > 0 && (
            <aside className="mt-8 border-t border-border pt-5" aria-label="Skipped harness transcripts">
              <h2 className="font-display text-lg font-semibold">
                {history.skipped} transcript{history.skipped === 1 ? '' : 's'} not read
              </h2>
              <p className="mt-1 text-sm text-muted">
                Ferretry did not replace unreadable history with an empty conversation.
              </p>
            </aside>
          )}
        </>
      )}
    </section>
  );
}
