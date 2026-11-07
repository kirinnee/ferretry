/**
 * COMPACT MEMORY AT IN THE FERRET TOOLBAR (`panels.compact-at`, slot `ferret.toolbar`): one "Compact memory at" button
 * that opens {@link CompactAtForm} for the ferret the toolbar is for (docs/compact-at.md). Today this was a row of the
 * ferret's Actions menu; the menu is Ferrets', so the row is this panel now, with the same form and words.
 *
 * The value is a launch setting, so a change reaches a running ferret at its next launch; the daemon's own `note`
 * says so and is shown in a status line. The form opens on what a launch would use now (the daemon's answer), so a
 * ferret that follows its login's default shows that default rather than a guess.
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import { Gauge, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { type CompactAt, describeCompactAt, type FerretCompactAt } from '../../contract/index.ts';
import { useConversationClient } from '../client.ts';
import { getFerretCompactAt, patchFerretCompactAt } from './compact-at-api.ts';
import { CompactAtForm, type CompactAtFormHost } from './compact-at-form.tsx';

/**
 * The panel for one ferret; nothing without one (a toolbar drawn with no subject), and nothing for a connection that
 * cannot control it (today's `if (!context.canControl) return null`). GAP(app-shell): the kernel's `PanelProps` carries
 * only `subject`, so the shell passes no `canControl` and it stays true; the daemon still refuses at `operator`.
 */
export function CompactAtPanel({
  subject,
  canControl = true,
}: {
  readonly subject?: string;
  readonly canControl?: boolean;
}) {
  const client = useConversationClient();
  return subject === undefined || !canControl ? null : <CompactAtControl client={client} ferretId={subject} />;
}

export function CompactAtControl({
  client,
  ferretId,
}: {
  readonly client: Pick<PluginClient, 'call'>;
  readonly ferretId: string;
}) {
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // The ferret's own value as last answered or saved; `undefined` while unread or when it follows the default.
  const [own, setOwn] = useState<CompactAt | undefined>(undefined);
  useEffect(() => {
    let live = true;
    getFerretCompactAt(client, ferretId).then(
      read => {
        if (live) setOwn(read.own);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, ferretId]);

  const host: CompactAtFormHost = { close: () => setOpen(false), notify: setNote };
  return (
    <div className="fy-toolbar-panel" data-compact-at-panel="">
      <button
        aria-controls={formId}
        aria-expanded={open}
        className="kt-btn kt-btn--sm"
        onClick={() => setOpen(current => !current)}
        type="button"
      >
        <Gauge aria-hidden="true" size={14} />
        <span>Compact memory at…</span>
        <span className="text-muted">{own === undefined ? 'Default' : describeCompactAt(own)}</span>
      </button>
      {open ? (
        <fieldset className="kt-panel fy-action-form m-0 min-w-0" id={formId} aria-label="Compact memory at">
          <CompactAtLoader client={client} host={host} own={own} onSaved={setOwn} ferretId={ferretId} />
        </fieldset>
      ) : null}
      {note === null ? null : (
        <div aria-live="polite" className="fy-toolbar-note" data-compact-at-note="" role="status">
          <span className="min-w-0 flex-1">{note}</span>
          <button
            aria-label="Dismiss"
            className="kt-btn h-11 w-11 shrink-0 p-0"
            onClick={() => setNote(null)}
            type="button"
          >
            <X aria-hidden="true" size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

/** Reads what a launch would use now, then draws the form on it; if the read fails the form still works. */
export function CompactAtLoader({
  client,
  host,
  own,
  onSaved,
  ferretId,
}: {
  readonly client: Pick<PluginClient, 'call'>;
  readonly host: CompactAtFormHost;
  readonly own: CompactAt | undefined;
  readonly onSaved: (value: CompactAt) => void;
  readonly ferretId: string;
}) {
  const [reading, setReading] = useState<FerretCompactAt | 'pending' | 'unavailable'>('pending');
  useEffect(() => {
    let live = true;
    getFerretCompactAt(client, ferretId).then(
      read => live && setReading(read),
      () => live && setReading('unavailable'),
    );
    return () => {
      live = false;
    };
  }, [client, ferretId]);

  if (reading === 'pending')
    return (
      <p className="fy-action-form__note" role="status">
        Reading the current setting…
      </p>
    );
  return (
    <CompactAtForm
      current={reading === 'unavailable' ? own : reading.own}
      following={reading === 'unavailable' ? 'auto' : reading.effective}
      host={host}
      save={async wanted => {
        const result = await patchFerretCompactAt(client, ferretId, wanted);
        onSaved(wanted);
        return { note: result.note };
      }}
      window={reading === 'unavailable' ? undefined : reading.window}
    />
  );
}
