import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';
import type { StepHost } from '@ferretry/kernel/contract';
import { forSubject } from '@ferretry/app';
import { createElement } from 'react';
import type { ClaudeCodeClient } from './lib/client.ts';
import { lazyComponent } from './lazy.ts';

interface StepPageProps {
  readonly exportName: string;
  readonly client: ClaudeCodeClient;
  readonly step: StepHost | undefined;
}

/**
 * A component whose module loads once and is SHARED once it has loaded, but whose FAILURE is never kept: a load that
 * fails starts a fresh component, so the next draw (the next page, or the same page again) tries the load again.
 * `lazyComponent` caches its one load for good, rejection included, so one dropped chunk request would otherwise turn
 * every page that shares it into an error for the rest of the app half's life.
 */
function sharedLoad<Props>(load: () => Promise<AppComponent<Props>>): AppComponent<Props> {
  let current: AppComponent<Props>;
  const fresh = (): AppComponent<Props> =>
    lazyComponent<Props>(() =>
      load().catch((reason: unknown) => {
        // Runs before the failed load becomes visible to React, so every later draw already sees a fresh attempt.
        current = fresh();
        throw reason;
      }),
    );
  current = fresh();
  return props => current(props);
}

/**
 * Every first-run page's module, loaded ONCE for the whole segment. A load per page made each page suspend on its first
 * draw even though the module was already in memory, and React holds a freshly shown Suspense fallback for at least
 * 300 ms (its fallback throttle), so every Claude page took ~370 ms from Next to ready and showed the shell's top bar
 * with every answer at 1 ms. With one load, only the segment's first drawn page waits for the module; every later page
 * reads the settled load at once and draws without suspending.
 */
const onboardingPages = (load: () => Promise<Record<string, unknown>>): AppComponent<StepPageProps> =>
  sharedLoad<StepPageProps>(async () => {
    const pages = await load();
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

/** The segment's step pages, keyed by their panel id, all reading the one shared load of `load`. */
export function onboardingPanels(load: () => Promise<Record<string, unknown>>, client: ClaudeCodeClient) {
  const pages = onboardingPages(load);
  return {
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
    'onboarding-ready': stepPage(pages, client, 'ready', 'ReadyPage'),
  };
}
