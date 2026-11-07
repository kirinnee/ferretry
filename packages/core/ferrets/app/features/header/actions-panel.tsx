/**
 * `ferret.toolbar` › `actions` — the header's one place for doing things to a ferret: the Actions ▾ menu, a Resume
 * button for a ferret that can come back, the toast a settled form leaves, and the paused-restart panel.
 *
 * It owns every Ferrets act on the header (stop, resume, rename, restart, pin, move), each through the half's own client
 * by route key. WHO MAY DO THEM is the daemon's: an owner act, or a governed device's, and a 403 or a step-up reaches
 * the screen as the alert line below.
 */

import { PanelSlot, useOptionalRouter } from '@ferretry/app';
import { ACTIONS_ROW_SLOT, type ActionsRowSlotProps } from '@ferretry/core-ferrets/contract';
import { Play } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { displayCallsign } from '../../lib/callsign.ts';
import type { LiveFerretsClient } from '../../lib/client.ts';
import { useFerret } from '../../lib/ferret-read.ts';
import { browserClipboardWriter, cn, useLayoutMode } from '../../ui.ts';
import { ActionToast } from './action-toast.tsx';
import { ActionsMenu } from './actions-menu.tsx';
import { CORE_FERRET_ACTIONS, type CoreActionContext } from './core-actions.ts';
import {
  newRestartRequestId,
  renameFerret,
  restartOnEarlierConversation,
  restartWithResume,
  resumeFerret,
  setFerretPinned,
  stopFerret,
} from './ferret-operations.ts';
import { daemonOfRoute, movePath } from './header-paths.ts';
import { useOfferedRows } from './offered-rows.ts';
import { RenameForm } from './rename-form.tsx';
import { type FerretActionContribution, type FerretActionFormHost, ferretActionSections } from './registry.ts';
import { reviveOffer } from './revive-offer.ts';
import { useRestartRefusal } from './restart-refusal.tsx';

export interface ActionsPanelProps {
  readonly client: LiveFerretsClient;
  /** The ferret the panel sits beside. */
  readonly subject: string | undefined;
  /** What this connection may change. Always yes today, as in today's PWA, which never computed it: the daemon refuses an act this device may not do. */
  readonly canControl?: boolean;
  /** More actions, from features that add them (same shape as the core ones). */
  readonly contributions?: readonly FerretActionContribution<CoreActionContext>[];
}

interface Alert {
  readonly sentence: string;
  readonly detail?: string;
}

export function ActionsPanel({ client, subject, canControl = true, contributions = [] }: ActionsPanelProps) {
  const { read, reload } = useFerret(client, subject);
  const compact = useLayoutMode() === 'drawer';
  const router = useOptionalRouter();
  const daemon = router === null ? undefined : daemonOfRoute(router.route);
  const [form, setForm] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [alert, setAlert] = useState<Alert | null>(null);
  const ferret = read.kind === 'ready' ? read.ferret : null;
  const refusal = useRestartRefusal(() => void reload(), subject ?? '');
  const clipboard = useMemo(() => browserClipboardWriter(), []);
  const offered = useOfferedRows();

  const fail = useCallback((sentence: string, detail?: string): void => {
    setAlert({ sentence, ...(detail === undefined ? {} : { detail }) });
  }, []);

  if (ferret === null || subject === undefined) return null;
  const name = displayCallsign(ferret.name) || ferret.id;

  const act = async (work: () => Promise<unknown>): Promise<void> => {
    setAlert(null);
    await work();
    await reload();
  };
  const restart = async (run: () => Promise<unknown>): Promise<void> => {
    setAlert(null);
    try {
      await run();
      await reload();
    } catch (reason) {
      // A restart the daemon paused is held by the panel below; anything else is the caller's to report.
      if (!refusal.capture(reason)) throw reason;
    }
  };

  const context: CoreActionContext = {
    ferret,
    name,
    canControl,
    copyId: () => {
      void clipboard(ferret.id).catch(() => fail('Copying the id was blocked — select it instead.'));
    },
    openMove: () => {
      if (router === null || daemon === undefined) fail('This page has no daemon to move the ferret on.');
      else router.navigate(movePath(daemon, ferret.id));
    },
    // "Move to Codex… / Move to Claude…" is the move page opened on its CLI switch. It is offered for every ferret: the
    // page says in its own words when the machine has no account of the other CLI to carry the conversation to.
    openConvert: () => {
      if (router === null || daemon === undefined) fail('This page has no daemon to move the ferret on.');
      else router.navigate(movePath(daemon, ferret.id, true));
    },
    restart: async () => await restart(async () => await restartWithResume(client, ferret, newRestartRequestId())),
    restartOnEarlierConversation: async () =>
      await restart(async () => await restartOnEarlierConversation(client, ferret, newRestartRequestId())),
    setPinned: async pinned => await act(async () => await setFerretPinned(client, ferret.id, pinned)),
    stop: async () => await act(async () => await stopFerret(client, ferret.id)),
    resume: async () => await act(async () => await resumeFerret(client, ferret.id)),
    renderRename: (host: FerretActionFormHost) => (
      <RenameForm
        ferret={ferret}
        host={host}
        rename={async patch => {
          const renamed = await renameFerret(client, ferret.id, patch);
          await reload();
          return renamed;
        }}
      />
    ),
  };
  const sections = ferretActionSections([...CORE_FERRET_ACTIONS, ...contributions, ...offered.contributions], context);
  const resumable = reviveOffer(ferret, canControl).offered;

  const onFailure = (sentence: string, detail?: string): void => fail(sentence, detail);

  return (
    <div
      className={cn('fy-ferret-actions fy-ferret-bar')}
      data-compact={compact ? '' : undefined}
      data-ferret-actions=""
    >
      {resumable ? (
        <button
          aria-label={compact ? 'Resume' : undefined}
          className={cn(compact ? 'fy-ferret-bar__icon' : 'kt-btn kt-btn--sm')}
          data-ferret-resume=""
          onClick={() => {
            void context
              .resume()
              .catch((reason: unknown) =>
                fail(`Resume failed: ${reason instanceof Error ? reason.message : String(reason)}`),
              );
          }}
          title={reviveOffer(ferret, canControl).reason}
          type="button"
        >
          <Play aria-hidden="true" size={compact ? 18 : 14} />
          {compact ? null : <span>Resume</span>}
        </button>
      ) : null}
      {daemon === undefined ? null : (
        <PanelSlot
          daemon={daemon}
          props={{ ferret: ferret.id, name, canControl, offer: offered.offer } satisfies ActionsRowSlotProps}
          slot={ACTIONS_ROW_SLOT}
        />
      )}
      <ActionsMenu
        compact={compact}
        form={form}
        name={name}
        onFailure={onFailure}
        onFormChange={setForm}
        onNotice={setNotice}
        sections={sections}
      />
      {alert === null ? null : (
        <p className="fy-action-form__failure" data-ferret-alert="" role="alert">
          {alert.sentence}
          {alert.detail === undefined ? null : (
            <details>
              <summary>Details</summary>
              <pre>{alert.detail}</pre>
            </details>
          )}
        </p>
      )}
      {refusal.panel}
      <ActionToast notice={notice} onDismiss={() => setNotice(null)} />
    </div>
  );
}
