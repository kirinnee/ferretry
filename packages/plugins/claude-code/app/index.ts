import type { AppComponent, PanelProps, SettingsProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { lazyComponent } from './lazy.ts';
import { forSubject } from '@ferretry/app';
import { createElement } from 'react';
import type { ClaudeCodeClient } from './lib/client.ts';
import type { StepHost } from '@ferretry/kernel/contract';

type ViewName = 'claude-code-settings' | 'permission-panel' | 'dialog-panel' | 'onboarding-pages';

/**
 * A view module (React), loaded on first use. The specifier is a Vite dynamic-import variable (`./views/*.tsx`), which
 * is also why the type-checker, which has no React in this workspace yet, does not follow it into the views.
 */
const loadView = (name: ViewName): Promise<Record<string, unknown>> => import(`./views/${name}.tsx`);

/**
 * One first-run step's body: draws ONLY for its own step (`claude-code.<step>`), loads nothing for any other, and hands
 * the page the plugin's client and the host the shell gives a step (`props.step`, O1's contract).
 */
const stepPage = (client: ClaudeCodeClient, step: string, exportName: string): AppComponent<PanelProps> =>
  forSubject(
    `claude-code.${step}`,
    lazyComponent<PanelProps>(async () => {
      const Page = (await loadView('onboarding-pages'))[exportName] as (props: {
        client: ClaudeCodeClient;
        step?: StepHost | undefined;
      }) => unknown;
      return (props: PanelProps) =>
        createElement(Page as never, { client, step: (props as { step?: StepHost }).step } as never);
    }),
  );

/**
 * Claude Code's app half: its Settings tab (where claude is, its version, the update), the two cards that draw
 * above the composer when the ferret is stopped on a permission prompt or one of Claude's own dialogs, and its first-run
 * segment's pages (install, sign in, the import pre-screen, permission mode).
 */
export default implementApp(manifest, {
  build: ({ client }) => ({
    settings: {
      'claude-code': lazyComponent<SettingsProps>(async () => {
        const view = await loadView('claude-code-settings');
        return (view.createSettings as (client: unknown) => AppComponent<SettingsProps>)(client);
      }),
    },
    panels: {
      'onboarding-installed': stepPage(client, 'installed', 'InstalledPage'),
      'onboarding-sign-in': stepPage(client, 'sign-in', 'SignInPage'),
      'onboarding-import-choice': stepPage(client, 'import-choice', 'ImportChoicePage'),
      'onboarding-permission': stepPage(client, 'permission', 'PermissionPage'),
      'permission-request': lazyComponent<PanelProps>(async () => {
        const view = await loadView('permission-panel');
        return (view.createPanel as (client: unknown) => AppComponent<PanelProps>)(client);
      }),
      'harness-dialog': lazyComponent<PanelProps>(async () => {
        const view = await loadView('dialog-panel');
        return (view.createPanel as (client: unknown) => AppComponent<PanelProps>)(client);
      }),
    },
  }),
});
