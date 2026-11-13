import { implementApp } from '@ferretry/kernel/manifest';
import { createElement } from 'react';
import manifest from '../manifest.ts';
import { BrowserPanel } from './features/browser/browser-panel.tsx';
import { BrowserTab } from './features/settings/browser-tab.tsx';
import type { BrowserDaemon } from './lib/scope.ts';
import { daemonOfClient } from '@ferretry/app';

/**
 * The Browsers app half (§2.3): the browser panel in a ferret's side pane (`ferret.side`, today's browser tab of the
 * session workspace), Settings › Browser (today's machine Browser tab) and the `%browser:` reference chip. The shell
 * builds one half per daemon and hands it that daemon's own client, which every view rides: the page list, the
 * actions and the guarded display socket, the control reads, and the tab's state, proxy test and configuration.
 */
export default implementApp(manifest, {
  build: ({ client }) => {
    const daemon: BrowserDaemon = { daemonId: daemonOfClient(client) ?? 'this-daemon', client };
    return {
      panels: {
        browser: ({ subject, intent }) =>
          subject === undefined
            ? null
            : createElement(BrowserPanel, { daemon, sessionId: subject, ...(intent === undefined ? {} : { intent }) }),
      },
      settings: {
        browser: () => createElement(BrowserTab, { client }),
      },
      renderers: {
        'reference:%browser': ({ value }) =>
          createElement(
            'code',
            { className: 'kt-reference kt-reference--browser' },
            `%browser:${typeof value === 'string' ? value : ''}`,
          ),
      },
    };
  },
});
