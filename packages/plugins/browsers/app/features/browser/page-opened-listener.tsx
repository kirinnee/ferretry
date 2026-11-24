/**
 * THE APP-WIDE LISTENER for a page the agent opens (`shell.background`, once per paired machine at the frame root, so it runs on
 * every page: the ferrets list as well as a ferret's own page). It hears `browsers.page-changed` and says the Browser panel
 * of that ferret wants to be shown. The ferret page's workspace, when that ferret is on screen, shows the panel; otherwise the
 * ferret's row gets its dot (`announcePanelReveal`, `panel-reveal.ts` in the app). It draws nothing.
 */

import { announcePanelReveal, type BackgroundViewProps } from '@ferretry/app';
import { useEffect } from 'react';
import { PageChanged } from '../../../contract/index.ts';

/** The Browser panel's key (`plugin.id`), as the ferret page's workspace names it. */
const BROWSER_PANEL = 'browsers.browser';

export function PageOpenedListener({ daemon, client }: BackgroundViewProps) {
  useEffect(
    () =>
      client.subscribe(PageChanged, event => {
        if (event.change !== 'opened') return;
        announcePanelReveal({ daemon, ferret: event.ferret, panel: BROWSER_PANEL, page: event.page });
      }),
    [daemon, client],
  );
  return null;
}
