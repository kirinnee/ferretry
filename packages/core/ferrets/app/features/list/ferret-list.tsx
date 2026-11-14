/**
 * THE FERRET LIST — this daemon's ferrets, live, grouped by folder (today's left sessions bar, as the `ferrets` screen).
 *
 * Top to bottom: Interactive · All · Agents, each with the count choosing it would show; "Show stopped (n)"; the
 * "Pinned" group; then one group per folder. The open ferret (the route's `:ferret`) is always listed and marked
 * `aria-current="page"`. A row is one link to the ferret's chat.
 *
 * The kind is kept for this device in the app's controls (`sessionsMode`); "Show stopped" lasts while the list does.
 */

import { useDeviceControls, useOptionalRouter } from '@ferretry/app';
import { type ReactNode, useState } from 'react';
import type { LiveFerretsClient } from '../../lib/client.ts';
import { daemonOfRoute, ferretOfRoute } from '../header/header-paths.ts';
import { newFerretHref } from '../new-ferret/hrefs.ts';
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
} from './list-model.ts';
import { STALE_LIST, useFerretList } from './use-ferret-list.ts';

export function FerretList({ client }: { readonly client: LiveFerretsClient }): ReactNode {
  const router = useOptionalRouter();
  const daemon = router === null ? undefined : daemonOfRoute(router.route);
  const openFerret = router === null ? undefined : ferretOfRoute(router.route);
  const { read, retry } = useFerretList(client);
  const { device, set } = useDeviceControls();
  const [showStopped, setShowStopped] = useState(DEFAULT_LIST_FILTER.showStopped);
  const restart = useRestartOutdated(read.kind === 'ready' ? read.ferrets : null, request =>
    restartFerrets(client, request),
  );
  const filter: FerretListFilter = { mode: device.sessionsMode ?? DEFAULT_LIST_FILTER.mode, showStopped };
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

  const view = ferretListView(read.ferrets, filter, ferret => ferret.id === openFerret);
  const row = (ferret: (typeof read.ferrets)[number]): ReactNode => (
    <FerretRow active={ferret.id === openFerret} daemon={daemon} ferret={ferret} key={ferret.id} {...navigation} />
  );
  const empty = view.pinned.length === 0 && view.groups.length === 0;
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
      <div className="fy-sbar__list scroll-thin">
        {empty ? (
          <div className="fy-sbar__empty">
            <p className="m-0">{emptyMessage(filter, view.hiddenStopped)}</p>
            {filter.mode === 'all' && view.hiddenStopped === 0 ? (
              <a className="kt-btn mt-2" data-ferret-new="" href={newFerretHref(daemon)}>
                + New ferret
              </a>
            ) : null}
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
            {view.groups.map(group => (
              <section aria-label={group.name} className="fy-sbar__group" key={group.path || group.name}>
                <h2 className="fy-sbar__project">
                  <span className="truncate">{group.name}</span>
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
    </div>
  );
}
