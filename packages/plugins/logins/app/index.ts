import { implementApp } from '@ferretry/kernel/manifest';
import { createElement } from 'react';
import manifest from '../manifest.ts';
import { harnessOfSubject } from './features/add-login-panel.tsx';
import { harnessSignIn } from './features/harness-sign-in-embed.tsx';
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
      // The subject `harness:codex` / `harness:claude` locks the panel to that tool: Codex's own page never offers Claude Code.
      'add-login': ({ subject }) => {
        const harness = harnessOfSubject(subject);
        return createElement(AddLoginPanel, { client, ...(harness === undefined ? {} : { harness }) });
      },
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
      // A harness's first-run "Sign in" page offers a slot each; the sign-in drawn there is this one.
      'claude-code-sign-in': props => harnessSignIn(client, 'claude-code', { ...props }),
      'codex-sign-in': props => harnessSignIn(client, 'codex', { ...props }),
    },
  }),
});
