/**
 * The deep link the daemon's waiting page opens: `<app>/?connector=<daemonId>`.
 *
 * The app has no general "machine" query convention (an Agenda link is `/inbox?session=…&agenda=…`, a share link
 * is `/join#…`), so this one is the query word `connector` on any path. It names a MACHINE by its daemon id — the
 * waiting page knows that and nothing else — and the app turns it into the address of that machine's Connectors
 * panel, `…/d/<id>/settings#machines/<name>/machine/connector`.
 *
 * A machine this browser is not paired with yields `null`: the link then does nothing, and says nothing about
 * whether such a machine exists.
 */

import { useEffect, useRef } from 'react';
import type { DaemonConnectionRecord } from '../../lib/connections.ts';
import { daemonSettingsPath } from '../../lib/pages/routes.ts';
import { itemHref } from '../fleet/components/machine-links.ts';
import { connectorTargetFromSearch, CONNECTOR_PANEL } from './connector-model.ts';

/** Where the link goes, or `null` when it names nothing this browser is paired with. */
export const connectorLinkPath = (
  search: string,
  connections: readonly DaemonConnectionRecord[],
  nameOf: (record: DaemonConnectionRecord) => string,
): string | null => {
  const target = connectorTargetFromSearch(search);
  if (target === null) return null;
  const record = connections.find(candidate => candidate.daemonId === target);
  if (record === undefined) return null;
  return `${daemonSettingsPath(record.daemonId)}${itemHref(nameOf(record), 'machine', CONNECTOR_PANEL)}`;
};

/**
 * Follows the link once, as soon as the pairings are known, replacing the address so Back does not return to a
 * page that would redirect again.
 */
export function useConnectorDeepLink(
  connections: readonly DaemonConnectionRecord[],
  nameOf: (record: DaemonConnectionRecord) => string,
  navigate: (to: string, options?: { readonly replace?: boolean }) => void,
): void {
  const followed = useRef(false);
  useEffect(() => {
    if (followed.current) return;
    const path = connectorLinkPath(window.location.search, connections, nameOf);
    if (path === null) return;
    followed.current = true;
    navigate(path, { replace: true });
  }, [connections, nameOf, navigate]);
}
