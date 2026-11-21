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

interface StepPageProps {
  readonly exportName: string;
  readonly client: ClaudeCodeClient;
  readonly step: StepHost | undefined;
}

/**
 * Every first-run page's module, loaded ONCE for the whole segment. A load per page made each page suspend on its first
 * draw even though the module was already in memory, and React holds a freshly shown Suspense fallback for at least
 * 300 ms (its fallback throttle), so every Claude page took ~370 ms from Next to ready and showed the shell's top bar
 * with every answer at 1 ms. With one load, only the segment's first drawn page waits for the module; every later page
 * reads the settled load at once and draws without suspending.
 */
const onboardingPages = (): AppComponent<StepPageProps> =>
  lazyComponent<StepPageProps>(async () => {
    const pages = await loadView('onboarding-pages');
    return ({ exportName, client, step }: StepPageProps) =>
      createElement(pages[exportName] as never, { client, step } as never);
  });

/**
 * One first-run step's body: draws ONLY for its own step (`claude-code.<step>`), and hands the page the plugin's client
 * and the host the shell gives a step (`props.step`, O1's contract).
 */
const stepPage = (
  pages: AppComponent<StepPageProps>,
  client: ClaudeCodeClient,
  step: string,
  exportName: string,
): AppComponent<PanelProps> =>
  forSubject(`claude-code.${step}`, (props: PanelProps) =>
    pages({ exportName, client, step: (props as { step?: StepHost }).step }),
  );

/**
 * Claude Code's app half: its Settings tab (where claude is, its version, the update), the two cards that draw
 * above the composer when the ferret is stopped on a permission prompt or one of Claude's own dialogs, and its first-run
 * segment's pages (install, sign in, the import pre-screen, permission mode).
 */
export default implementApp(manifest, {
  build: ({ client }) => {
    const pages = onboardingPages();
    return {
      settings: {
        'claude-code': lazyComponent<SettingsProps>(async () => {
          const view = await loadView('claude-code-settings');
          return (view.createSettings as (client: unknown) => AppComponent<SettingsProps>)(client);
        }),
      },
      panels: {
        'onboarding-installed': stepPage(pages, client, 'installed', 'InstalledPage'),
        'onboarding-sign-in': stepPage(pages, client, 'sign-in', 'SignInPage'),
        'onboarding-import-choice': stepPage(pages, client, 'import-choice', 'ImportChoicePage'),
        'onboarding-import-settings': stepPage(pages, client, 'import-settings', 'SettingsPage'),
        'onboarding-import-model-set': stepPage(pages, client, 'import-model-set', 'ModelSetPage'),
        'onboarding-import-instructions': stepPage(pages, client, 'import-instructions', 'InstructionsPage'),
        'onboarding-import-skills': stepPage(pages, client, 'import-skills', 'SkillsPage'),
        'onboarding-import-mcp': stepPage(pages, client, 'import-mcp', 'McpPage'),
        'onboarding-conversations': stepPage(pages, client, 'conversations', 'ConversationsPage'),
        'onboarding-import-run': stepPage(pages, client, 'import-run', 'ImportRunPage'),
        'onboarding-permission': stepPage(pages, client, 'permission', 'PermissionPage'),
        'permission-request': lazyComponent<PanelProps>(async () => {
          const view = await loadView('permission-panel');
          return (view.createPanel as (client: unknown) => AppComponent<PanelProps>)(client);
        }),
        'harness-dialog': lazyComponent<PanelProps>(async () => {
          const view = await loadView('dialog-panel');
          return (view.createPanel as (client: unknown) => AppComponent<PanelProps>)(client);
        }),
      },
    };
  },
});
