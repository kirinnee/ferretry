/**
 * HYPERMEDIA IN THE FERRET TOOLBAR (`panels.hypermedia`, slot `ferret.toolbar`; lead decision Q2): one "Hypermedia"
 * switch for the ferret the toolbar is for, and the polite status line that says what the switch did
 * (docs/hypermedia.md). Today it was a menuitemcheckbox in the ferret's Actions menu, which is Ferrets'.
 *
 * The switch decides only what the ferret is TOLD — that it may explain with diagrams, drawings, interactive pages and
 * media. Its instructions were fixed when it started, so a change takes effect at its next launch and nothing is sent
 * to it; the daemon's own `note` says so, and the panel shows it.
 *
 * The state is the ferret's own `config.hypermedia` (absent means the mode default: on for interactive, off for auto).
 * Once the daemon answered a switch, that answer is what the toggle shows, so it never flips back under the reader.
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import { Shapes, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useConversationClient } from '../client.ts';
import '../compact-at/compact-at.css';
import { hypermediaOn, patchFerretHypermedia, readFerretHypermedia } from './hypermedia-api.ts';

/**
 * The panel for one ferret; nothing without one, and nothing for a connection that cannot control it (today's
 * `if (!context.canControl) return null`). GAP(app-shell): the kernel's `PanelProps` carries only `subject`, so the shell
 * passes no `canControl` and it stays true; the daemon still refuses at `operator`.
 */
export function HypermediaPanel({
  subject,
  canControl = true,
}: {
  readonly subject?: string;
  readonly canControl?: boolean;
}) {
  const client = useConversationClient();
  return subject === undefined || !canControl ? null : <HypermediaSwitch client={client} ferretId={subject} />;
}

function HypermediaSwitch({
  client,
  ferretId,
}: {
  readonly client: Pick<PluginClient, 'call'>;
  readonly ferretId: string;
}) {
  const [on, setOn] = useState<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    readFerretHypermedia(client, ferretId).then(
      value => {
        if (live) setOn(current => current ?? value);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, ferretId]);

  /** Switches it. A refusal is said in the same status line as the answer: a toolbar has no menu to report it in. */
  const tap = useCallback(
    async (next: boolean) => {
      setNote(null);
      setBusy(true);
      try {
        const result = await patchFerretHypermedia(client, ferretId, next);
        setOn(result.view === undefined ? next : hypermediaOn(result.view.config));
        setNote(result.note);
      } catch (reason) {
        setNote(`Hypermedia could not be switched: ${reason instanceof Error ? reason.message : String(reason)}`);
      } finally {
        setBusy(false);
      }
    },
    [client, ferretId],
  );

  return (
    <div className="fy-toolbar-panel" data-hypermedia-panel="">
      <button
        aria-pressed={on === true}
        className="kt-btn kt-btn--sm"
        data-hypermedia-switch={on === undefined ? 'unknown' : on ? 'on' : 'off'}
        disabled={on === undefined || busy}
        onClick={() => on !== undefined && void tap(!on)}
        type="button"
      >
        <Shapes aria-hidden="true" size={14} />
        <span>Hypermedia</span>
        <span className="text-muted">{on === undefined ? '…' : on ? 'On' : 'Off'}</span>
      </button>
      {note === null ? null : (
        <div
          aria-live="polite"
          className="fixed inset-x-4 top-[calc(env(safe-area-inset-top,0px)+3.5rem)] z-[55] mx-auto flex max-w-[480px] items-center gap-2 rounded-control border border-accent-border bg-surface px-3 py-1 text-ui text-fg shadow-popover"
          data-hypermedia-action-note=""
          role="status"
        >
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
