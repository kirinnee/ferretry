import { implementApp } from '@ferretry/kernel/manifest';
import { createElement } from 'react';
import manifest from '../manifest.ts';
import { AddLoginPanel, LocalModelsSurface, LoginSignInPanel, QuotaReadout, SignInsTab } from './views.tsx';

/**
 * Logins' app half: the Sign-ins tab (Settings › Logins) and, mounted on their own, its sign-in, add-login,
 * Claude Code and Codex sign-in and local-models panels, plus the status-area readout. The harness's own sign-in is
 * driven from here and the daemon holds no token while it runs; a code or address a person pastes goes to the daemon
 * and is kept nowhere. Every call goes through the half's own client by route key.
 */
export default implementApp(manifest, {
  build: ({ client }) => ({
    settings: { logins: () => createElement(SignInsTab, { client }) },
    panels: {
      'sign-ins': () => createElement(SignInsTab, { client }),
      'add-login': () => createElement(AddLoginPanel, { client }),
      'claude-code-login': ({ subject }) =>
        createElement(LoginSignInPanel, {
          client,
          harness: 'claude-code',
          ...(subject === undefined ? {} : { subject }),
        }),
      'codex-login': ({ subject }) =>
        createElement(LoginSignInPanel, { client, harness: 'codex', ...(subject === undefined ? {} : { subject }) }),
      'local-models': () => createElement(LocalModelsSurface, { client }),
      'quota-readout': () => createElement(QuotaReadout, { client }),
    },
  }),
});
