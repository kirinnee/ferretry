/**
 * EVERYTHING A SURFACE NEEDS TO DO THINGS TO ONE FERRET — shared by the header's Actions ▾ and a list row's menu, so the
 * two cannot disagree about what a ferret offers.
 *
 * It builds the {@link CoreActionContext} (every Ferrets act, each through the half's own client by route key), holds the
 * alert line and the toast notice a settled act leaves, holds a paused restart ({@link useRestartRefusal}), collects the
 * rows other plugins offer through `ferrets.actions-row` ({@link useOfferedRows}) and answers the registry's sections for
 * that ferret. A surface draws what it is handed; WHO MAY DO an act is the daemon's, and a 403 or a step-up reaches the
 * surface as {@link FerretActions.alert}.
 */

import { useOptionalRouter } from '@ferretry/app';
import type { ActionsRowOffer } from '@ferretry/core-ferrets/contract';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import type { FerretSummary } from '../../../contract/index.ts';
import { displayCallsign } from '../../lib/callsign.ts';
import type { LiveFerretsClient } from '../../lib/client.ts';
import { browserClipboardWriter } from '../../ui.ts';
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
import {
  type FerretActionContribution,
  type FerretActionFormHost,
  type FerretActionSection,
  ferretActionSections,
} from './registry.ts';
import { useRestartRefusal } from './restart-refusal.tsx';

/** The one line a failed act leaves on a surface: a sentence, and the daemon's detail when it gave one. */
interface FerretActionAlert {
  readonly sentence: string;
  readonly detail?: string;
}

export interface FerretActionsOptions {
  /** What this connection may change. Always yes today, as in today's PWA, which never computed it: the daemon refuses an act this device may not do. */
  readonly canControl?: boolean;
  /** More actions, from features that add them (same shape as the core ones). */
  readonly contributions?: readonly FerretActionContribution<CoreActionContext>[];
  /** Extra entries that belong to one surface only (a list row's Open and Copy name), built with the same context. */
  readonly extra?: (
    fail: (sentence: string, detail?: string) => void,
  ) => readonly FerretActionContribution<CoreActionContext>[];
}

export interface FerretActions {
  /** The ferret's display name, for the words. */
  readonly name: string;
  /** The daemon the page is under, or `undefined` when the route has none. */
  readonly daemon: string | undefined;
  readonly canControl: boolean;
  readonly context: CoreActionContext;
  readonly sections: readonly FerretActionSection[];
  /** The rows other plugins have offered so far, and the `offer` a mounted `ferrets.actions-row` panel is handed. */
  readonly offer: (id: string, row: ActionsRowOffer | null) => void;
  readonly alert: FerretActionAlert | null;
  readonly fail: (sentence: string, detail?: string) => void;
  /** What a settled form said, for the surface's toast. */
  readonly notice: string | null;
  readonly setNotice: (sentence: string | null) => void;
  /** The panel a paused restart leaves; draw it wherever the surface keeps its alerts. */
  readonly panel: ReactNode;
  /**
   * Hands an act's failure to the right place: a paused restart is held by {@link panel}; anything else is the alert
   * line.
   */
  readonly report: (sentence: string, detail?: string, reason?: unknown) => void;
}

export function useFerretActions(
  client: LiveFerretsClient,
  ferret: FerretSummary,
  reload: () => Promise<unknown>,
  { canControl = true, contributions = [], extra }: FerretActionsOptions = {},
): FerretActions {
  const router = useOptionalRouter();
  const daemon = router === null ? undefined : daemonOfRoute(router.route);
  const [notice, setNotice] = useState<string | null>(null);
  const [alert, setAlert] = useState<FerretActionAlert | null>(null);
  const refusal = useRestartRefusal(() => void reload(), ferret.id);
  const clipboard = useMemo(() => browserClipboardWriter(), []);
  const offered = useOfferedRows();

  const fail = useCallback((sentence: string, detail?: string): void => {
    setAlert({ sentence, ...(detail === undefined ? {} : { detail }) });
  }, []);

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
  const sections = ferretActionSections(
    [...CORE_FERRET_ACTIONS, ...(extra?.(fail) ?? []), ...contributions, ...offered.contributions],
    context,
  );
  const report = (sentence: string, detail?: string, reason?: unknown): void => {
    if (!refusal.capture(reason)) fail(sentence, detail);
  };

  return {
    name,
    daemon,
    canControl,
    context,
    sections,
    offer: offered.offer,
    alert,
    fail,
    notice,
    setNotice,
    panel: refusal.panel,
    report,
  };
}
