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

import { controlState, useViewPlace } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { Shapes, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useConversationClient } from '../client.ts';
import '../compact-at/compact-at.css';
import { patchFerretHypermedia, readFerretHypermedia } from './hypermedia-api.ts';

/** The route a switch sends: what this device may do with it is the panel's whole authority. */
const HYPERMEDIA_ROUTE = 'PATCH /v1/ferrets/:ferretId/hypermedia';

/**
 * The panel for one ferret; nothing without one, and nothing for a connection that cannot control it (today's
 * `if (!context.canControl) return null`): the view's place (shell contract S1) says what this device may do with the
 * switch's route, and a control the daemon said it may not have is not drawn. Outside a per-daemon view (a suite)
 * there is no place, and the daemon's own refusal is the answer.
 */
export function HypermediaPanel({ subject }: { readonly subject?: string }) {
  const client = useConversationClient();
  const place = useViewPlace();
  const state = place === null ? undefined : controlState(place.authorityOf(HYPERMEDIA_ROUTE));
  if (subject === undefined || state?.shown === false) return null;
  return (
    <HypermediaSwitch
      client={client}
      ferretId={subject}
      enabled={state?.enabled ?? true}
      {...(state?.note === undefined ? {} : { blocked: state.note })}
      press={place?.press ?? (act => act())}
    />
  );
}

function HypermediaSwitch({
  client,
  ferretId,
  enabled,
  blocked,
  press,
}: {
  readonly client: Pick<PluginClient, 'call'>;
  readonly ferretId: string;
  readonly enabled: boolean;
  /** Why the switch is off for now (the first grants read, an unreadable answer); absent when it is on. */
  readonly blocked?: string;
  /** Runs the switch: on a locked machine the unlock is asked first. */
  readonly press: <T>(act: () => Promise<T>) => Promise<T | undefined>;
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
        const result = await press(() => patchFerretHypermedia(client, ferretId, next));
        if (result === undefined) {
          setNote('Hypermedia was not switched: this machine wants your passkey first.');
          return;
        }
        setOn(next);
        setNote(result.note);
      } catch (reason) {
        setNote(`Hypermedia could not be switched: ${reason instanceof Error ? reason.message : String(reason)}`);
      } finally {
        setBusy(false);
      }
    },
    [client, ferretId, press],
  );

  return (
    <div className="fy-toolbar-panel" data-hypermedia-panel="">
      <button
        aria-pressed={on === true}
        className="kt-btn kt-btn--sm"
        data-hypermedia-switch={on === undefined ? 'unknown' : on ? 'on' : 'off'}
        disabled={on === undefined || busy || !enabled}
        onClick={() => on !== undefined && void tap(!on)}
        title={blocked}
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
