/**
 * THE FERRET LIST — this daemon's ferrets, live, grouped by folder (today's left sessions bar, as the `ferrets` screen).
 *
 * Top to bottom: Interactive · All · Agents, each with the count choosing it would show; "Show stopped (n)"; the
 * "Pinned" group; then one group per folder. The open ferret (the route's `:ferret`) is always listed and marked
 * `aria-current="page"`. A row is one link to the ferret's chat.
 *
 * The kind is kept for this device in the app's controls (`sessionsMode`); "Show stopped" lasts while the list does.
 *
 * NEEDS YOU. Under Pinned, a "Needs you" group gathers the ferrets with open items waiting on the owner (the Agenda says
 * which, through `ferrets.needs-you`) while the device's "Group Needs you at the top" is on; with it off they stay in
 * their folders, still bold and badged. Without a provider the list draws none of it.
 */

import { useAppHook, useDeviceControls, useOptionalRouter } from '@ferretry/app';
import { type ReactNode, useEffect, useState } from 'react';
import {
  FERRETS_LIST_SCOPE_HOOK,
  FERRETS_NEEDS_YOU_HOOK,
  type FerretListScopeSnapshot,
  type FerretNeedsYou,
  type FerretsListScope,
  isFerretsListScope,
  isFerretsNeedsYou,
} from '../../../contract/index.ts';
import type { LiveFerretsClient } from '../../lib/client.ts';
import { folderBaseName } from '../new-ferret/recent-folders.ts';
import { useListScope } from './use-list-scope.ts';
import { useNeedsYou } from './use-needs-you.ts';
import { daemonOfRoute, ferretOfRoute } from '../header/header-paths.ts';
import { NewFerretButton } from '../new-ferret/new-machine-menu.tsx';
import { ListOptions } from '../restart-outdated/restart-outdated-menu.tsx';
import { restartFerrets } from '../restart-outdated/restart-outdated-api.ts';
import { RestartOutdatedResult, useRestartOutdated } from '../restart-outdated/restart-outdated.tsx';
import { FerretRow } from './ferret-row.tsx';
import {
  DEFAULT_LIST_FILTER,
  emptyMessage,
  type FerretListFilter,
  ferretListView,
  MODE_SEGMENTS,
  type NeedingYou,
  scopeIsStale,
} from './list-model.ts';
import { STALE_LIST, useFerretList } from './use-ferret-list.ts';

export function FerretList({ client }: { readonly client: LiveFerretsClient }): ReactNode {
  const router = useOptionalRouter();
  const daemon = router === null ? undefined : daemonOfRoute(router.route);
  const provided = useAppHook(daemon, FERRETS_NEEDS_YOU_HOOK);
  const needing = useNeedsYou(isFerretsNeedsYou(provided) ? provided : undefined);
  const scopeHook = useAppHook(daemon, FERRETS_LIST_SCOPE_HOOK);
  const listScope = isFerretsListScope(scopeHook) ? scopeHook : undefined;
  const snapshot = useListScope(listScope);
  return (
    <FerretListBody
      client={client}
      needing={needing}
      {...(listScope === undefined ? {} : { scope: { hook: listScope, snapshot } })}
    />
  );
}

/** The provider of the list's focus and the answer it gave: what `FerretList` hands the body once the hook is read. */
export interface ListScopeRead {
  readonly hook: FerretsListScope;
  readonly snapshot: FerretListScopeSnapshot;
}

/** The list over an answer to "who waits on the owner" and "which folder is focused": what `FerretList` draws. */
export function FerretListBody({
  client,
  needing,
  scope,
}: {
  readonly client: LiveFerretsClient;
  readonly needing: NeedingYou;
  readonly scope?: ListScopeRead;
}): ReactNode {
  const router = useOptionalRouter();
  const daemon = router === null ? undefined : daemonOfRoute(router.route);
  const openFerret = router === null ? undefined : ferretOfRoute(router.route);
  const { read, retry } = useFerretList(client);
  const { device, set } = useDeviceControls();
  const [showStopped, setShowStopped] = useState(DEFAULT_LIST_FILTER.showStopped);
  const restart = useRestartOutdated(client, read.kind === 'ready' ? read.ferrets : null, request =>
    restartFerrets(client, request),
  );
  const filter: FerretListFilter = { mode: device.sessionsMode ?? DEFAULT_LIST_FILTER.mode, showStopped };
  // A focus on a folder that is gone is dropped once the list is read, so the list never sits empty under a stale scope.
  const stale = read.kind === 'ready' && scope !== undefined && scopeIsStale(read.ferrets, scope.snapshot);
  useEffect(() => {
    if (stale) scope?.hook.recover();
  }, [stale, scope?.hook]);
  if (daemon === undefined) return null;
  const onNavigate = router === null ? undefined : (to: string) => router.navigate(to);
  const navigation = onNavigate === undefined ? {} : { onNavigate };

  if (read.kind === 'loading')
    return (
      <p className="fy-sbar__empty" role="status">
        Reading ferrets…
      </p>
    );
  if (read.kind === 'failed')
    return (
      <div className="fy-sbar__empty" role="alert">
        <p className="m-0">{read.sentence}</p>
        <button className="kt-btn mt-2" onClick={retry} type="button">
          Retry
        </button>
      </div>
    );

  const view = ferretListView(
    read.ferrets,
    filter,
    ferret => ferret.id === openFerret,
    { needing, group: device.groupNeedsYou },
    scope?.snapshot,
  );
  const focused = scope?.snapshot.scope ?? null;
  const row = (ferret: (typeof read.ferrets)[number]): ReactNode => {
    const waiting: FerretNeedsYou | undefined = needing.get(ferret.id);
    return (
      <FerretRow
        active={ferret.id === openFerret}
        daemon={daemon}
        ferret={ferret}
        key={ferret.id}
        overlayKey={client}
        {...(waiting === undefined ? {} : { needsYou: waiting })}
        {...navigation}
      />
    );
  };
  const empty = view.pinned.length === 0 && view.needsYou.length === 0 && view.groups.length === 0;
  return (
    <div className="fy-sbar__ferrets" data-ferret-list="">
      <div className="fy-sbar__filters">
        <fieldset aria-label="Show ferrets" className="fy-sbar__segment">
          {MODE_SEGMENTS.map(segment => (
            <button
              aria-pressed={filter.mode === segment.mode}
              className="fy-sbar__seg"
              data-sbar-filter={segment.mode}
              key={segment.mode}
              onClick={() => set({ sessionsMode: segment.mode })}
              title={`${segment.hint} (${view.counts[segment.mode]})`}
              type="button"
            >
              <span>{segment.label}</span>
              <span className="fy-sbar__count">{view.counts[segment.mode]}</span>
            </button>
          ))}
        </fieldset>
        <div className="fy-sbar__tools">
          <label className="fy-sbar__stopped" data-sbar-show-stopped="">
            <input
              checked={showStopped}
              onChange={event => setShowStopped(event.currentTarget.checked)}
              type="checkbox"
            />
            <span>Show stopped</span>
            {view.hiddenStopped > 0 ? <span className="fy-sbar__count">({view.hiddenStopped})</span> : null}
          </label>
          <ListOptions restart={restart} />
        </div>
      </div>
      <RestartOutdatedResult restart={restart} />
      {scope === undefined || focused === null ? null : (
        <div className="fy-sbar__scope" data-sbar-scope="">
          <span className="truncate">{scope.snapshot.groupOf(focused)?.name ?? folderBaseName(focused)}</span>
          <button className="kt-btn" data-sbar-scope-exit="" onClick={() => scope.hook.exit()} type="button">
            Show all folders
          </button>
        </div>
      )}
      <div className="fy-sbar__list scroll-thin">
        {empty ? (
          <div className="fy-sbar__empty">
            <p className="m-0">{emptyMessage(filter, view.hiddenStopped)}</p>
          </div>
        ) : (
          <>
            {view.pinned.length === 0 ? null : (
              <section aria-label="Pinned" className="fy-sbar__group fy-sbar__pinned" data-sbar-pinned-group="">
                <h2 className="fy-sbar__project">
                  <span className="truncate">Pinned</span>
                  <span className="fy-sbar__count">{view.pinned.length}</span>
                </h2>
                <ul>{view.pinned.map(row)}</ul>
              </section>
            )}
            {view.needsYou.length === 0 ? null : (
              <section
                aria-label="Needs you"
                className="fy-sbar__group fy-sbar__needs-you"
                data-sbar-needs-you-group=""
              >
                <h2 className="fy-sbar__project">
                  <span className="truncate">Needs you</span>
                  <span className="fy-sbar__count">{view.needsYou.length}</span>
                </h2>
                <ul>{view.needsYou.map(row)}</ul>
              </section>
            )}
            {view.groups.map(group => (
              <section aria-label={group.name} className="fy-sbar__group" key={group.path || group.name}>
                <h2 className="fy-sbar__project">
                  {scope === undefined || focused !== null ? (
                    <span className="truncate">{group.name}</span>
                  ) : (
                    <button
                      className="fy-sbar__focus truncate"
                      data-sbar-focus={group.path}
                      onClick={() => scope.hook.enter(group.path)}
                      title={`Show only ${group.name}`}
                      type="button"
                    >
                      {group.name}
                    </button>
                  )}
                  <span className="fy-sbar__count">{group.rows.length}</span>
                </h2>
                <ul>{group.rows.map(row)}</ul>
              </section>
            ))}
          </>
        )}
      </div>
      {read.stale ? (
        <p className="fy-sbar__empty" data-sbar-stale="" role="status">
          {STALE_LIST}
        </p>
      ) : null}
      {/* v4's sessions bar ended in a primary "New session" button whatever the list held: the door to start one is
          never only a command-bar entry or an empty-list message. */}
      <div className="fy-sbar__footer">
        <NewFerretButton daemon={daemon} onNavigate={onNavigate} />
      </div>
    </div>
  );
}
