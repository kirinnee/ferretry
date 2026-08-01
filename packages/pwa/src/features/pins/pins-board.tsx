/**
 * Daemon-scoped pins surface. Pins are deliberately passed with their complete
 * scope: a session id alone is not a cache key when one browser is paired to
 * more than one daemon.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Bot, LoaderCircle, MessageSquareText, Pencil, Pin as PinIcon, Plus, Trash2 } from 'lucide-react';
import { MAX_PIN_NOTE_LENGTH, type Pin, type PinSnapshot } from '@ferretry/protocol';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { daemonSessionKey, type DaemonSessionScope } from '../../lib/daemon-scope.ts';
import type { DaemonPinClient } from '../../lib/pin-client.ts';
import type { PinLoadStatus } from '../../lib/pin-store.ts';
import { Button, Textarea } from '../../shell/primitives.tsx';

export const pinProvenanceLabel = (pin: Pick<Pin, 'by' | 'createdByName'>): string | null =>
  pin.by === 'agent' ? (pin.createdByName ? `Pinned by ${pin.createdByName}` : 'Pinned by an agent') : null;

export const pinMessageLabel = (pin: Extract<Pin, { kind: 'message' }>): string =>
  `${pin.blockKind === 'assistant' ? 'Assistant' : 'Transcript'} message`;

export interface PinsBoardProps {
  readonly snapshot: PinSnapshot | null;
  readonly status: PinLoadStatus;
  readonly error?: string | null;
  readonly busyId?: string | null;
  readonly onAddNote: (text: string) => void;
  readonly onEditNote: (id: string, text: string) => void;
  readonly onRemove: (id: string) => void;
  /** Exact block id only: callers must never jump to an approximate transcript row. */
  readonly onOpenMessage?: (blockId: string) => void;
}

/** Renderable pins ledger for either a desktop side pane or mobile bottom sheet. */
export function PinsBoard({
  snapshot,
  status,
  error = null,
  busyId = null,
  onAddNote,
  onEditNote,
  onRemove,
  onOpenMessage,
}: PinsBoardProps) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const pins = snapshot?.pins ?? [];
  const submit = () => {
    const text = draft.trim();
    if (!text || text.length > MAX_PIN_NOTE_LENGTH) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onAddNote(text);
    setDraft('');
  };
  const save = (id: string) => {
    const text = editText.trim();
    if (!text || text.length > MAX_PIN_NOTE_LENGTH) return;
    onEditNote(id, text);
    setEditing(null);
  };

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col" aria-label="Pins ledger">
      <header className="shrink-0 border-b border-border-soft px-panel pb-row-y">
        <div className="mx-auto flex w-full max-w-2xl items-center gap-sm">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-accent-border bg-accent-soft text-accent">
            <PinIcon size={16} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="m-0 font-display text-title font-semibold tracking-display text-fg">Pins</h1>
            <p className="m-0 text-meta text-faint">{pins.length} saved for this session</p>
          </div>
        </div>
      </header>
      {error || status === 'error' ? (
        <p role="alert" className="m-0 border-b border-err/30 bg-err/5 px-panel py-row-y text-meta text-err">
          {error ?? "Can't reach the daemon — these pins may be out of date."}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin" data-pins-scroller>
        <div className="mx-auto flex w-full max-w-2xl flex-col px-panel">
          <form
            className="flex gap-xs border-b border-border-soft py-md"
            onSubmit={event => {
              event.preventDefault();
              submit();
            }}
          >
            <Textarea
              aria-label="New pin note"
              value={draft}
              onChange={event => {
                setDraft(event.target.value);
                setInvalid(false);
              }}
              placeholder="Add a note to this session…"
              rows={2}
              className="min-h-[44px] flex-1"
            />
            <Button type="submit" size="sm" className="min-h-[44px] shrink-0" disabled={busyId === 'new'}>
              {busyId === 'new' ? (
                <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" />
              ) : (
                <Plus size={14} />
              )}
              Add
            </Button>
          </form>
          {invalid ? (
            <p role="alert" className="m-0 pb-xs text-meta text-err">
              Enter a note up to {MAX_PIN_NOTE_LENGTH} characters.
            </p>
          ) : null}
          {status === 'loading' && !snapshot ? (
            <p role="status" className="flex items-center justify-center gap-xs py-8 text-cell text-muted">
              <LoaderCircle size={15} className="animate-spin motion-reduce:animate-none" />
              Loading pins…
            </p>
          ) : pins.length === 0 ? (
            <div className="py-10 text-center">
              <PinIcon size={18} className="mx-auto mb-sm text-muted" aria-hidden="true" />
              <p className="m-0 text-cell font-medium text-fg">No pins yet.</p>
              <p className="m-0 mt-xs text-meta text-faint">
                Keep a note or message close while this session is active.
              </p>
            </div>
          ) : (
            <ol className="m-0 flex list-none flex-col divide-y divide-border-soft p-0">
              {pins.map(pin => {
                const provenance = pinProvenanceLabel(pin);
                const busy = busyId === pin.id;
                return (
                  <li key={pin.id} data-pin-id={pin.id} className="min-w-0 py-md">
                    <div className="flex items-center gap-xs text-meta text-faint">
                      {pin.kind === 'note' ? (
                        <PinIcon size={13} aria-hidden="true" />
                      ) : (
                        <MessageSquareText size={13} aria-hidden="true" />
                      )}
                      <span>{pin.kind === 'note' ? 'Note' : pinMessageLabel(pin)}</span>
                      {provenance ? (
                        <span className="inline-flex items-center gap-1">
                          <Bot size={12} aria-hidden="true" />
                          {provenance}
                        </span>
                      ) : null}
                    </div>
                    {pin.kind === 'note' && editing === pin.id ? (
                      <div className="mt-xs flex flex-col gap-xs">
                        <Textarea
                          aria-label="Edit pin note"
                          value={editText}
                          onChange={event => setEditText(event.target.value)}
                          rows={3}
                        />
                        <div className="flex justify-end gap-xs">
                          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                            Cancel
                          </Button>
                          <Button type="button" size="sm" disabled={busy} onClick={() => save(pin.id)}>
                            Save
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <p className="m-0 mt-xs whitespace-pre-wrap break-words text-cell leading-base text-fg">
                        {pin.kind === 'note' ? pin.text : pin.preview}
                      </p>
                    )}
                    <div className="mt-sm flex justify-end gap-xs">
                      {pin.kind === 'message' && onOpenMessage ? (
                        <Button type="button" size="sm" variant="ghost" onClick={() => onOpenMessage(pin.blockId)}>
                          Open message
                        </Button>
                      ) : null}
                      {pin.kind === 'note' && editing !== pin.id ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditing(pin.id);
                            setEditText(pin.text);
                          }}
                        >
                          <Pencil size={13} />
                          Edit
                        </Button>
                      ) : null}
                      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => onRemove(pin.id)}>
                        {busy ? (
                          <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" />
                        ) : (
                          <Trash2 size={13} />
                        )}
                        Remove
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}

/** Binds the pure surface to a daemon-only client without leaking another daemon's cached board. */
export function DaemonPinsBoard({
  connection,
  scope,
  client,
  onOpenMessage,
}: {
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  readonly client: DaemonPinClient;
  readonly onOpenMessage?: (blockId: string) => void;
}) {
  if (connection.daemonId !== scope.daemonId) throw new Error('pin board scope must belong to its daemon connection');
  const store = useSyncExternalStore(
    client.store.subscribe.bind(client.store),
    () => client.store.getSnapshot(),
    () => client.store.getSnapshot(),
  );
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  useEffect(() => {
    void client
      .hydrate(connection, scope)
      .catch(value => setError(value instanceof Error ? value.message : 'Could not load pins.'));
  }, [client, connection, scope]);
  const mutate = (id: string, action: () => Promise<void>) => {
    setBusyId(id);
    setError(null);
    void action()
      .catch(value => setError(value instanceof Error ? value.message : 'Could not update pins.'))
      .finally(() => setBusyId(null));
  };
  return (
    <PinsBoard
      snapshot={store.snapshots.get(daemonSessionKey(scope)) ?? null}
      status={client.store.status(scope)}
      error={error}
      busyId={busyId}
      onAddNote={text => mutate('new', () => client.add(connection, scope, { action: 'add', kind: 'note', text }))}
      onEditNote={(id, text) => mutate(id, () => client.editNote(connection, scope, id, text))}
      onRemove={id => mutate(id, () => client.remove(connection, scope, id))}
      onOpenMessage={onOpenMessage}
    />
  );
}
