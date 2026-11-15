import { implementApp } from '@ferretry/kernel/manifest';
import { forSubject } from '@ferretry/app';
import { createElement } from 'react';
import manifest from '../manifest.ts';
import { addRuntimeLoginPanel, addRuntimeSignInPanel } from './features/add-runtime-slots.tsx';
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
      // Runtimes' Add runtime page offers these two slots: a login is added and signed in right there.
      'add-runtime-login': props => addRuntimeLoginPanel(client, { ...props }),
      'add-runtime-sign-in': props => addRuntimeSignInPanel(client, { ...props }),
      'local-models': () => createElement(LocalModelsSurface, { client }),
      'quota-readout': () => createElement(QuotaReadout, { client }),
      // The first-run step's body: the sign-ins view, only for its own step.
      'onboarding-step': forSubject('logins.login', () => createElement(SignInsTab, { client })),
    },
  }),
});
