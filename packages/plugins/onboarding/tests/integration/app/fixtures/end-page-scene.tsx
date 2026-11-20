/**
 * The browser entry for the LAST PAGE ("You're set up") over FAKE data: the real `EndPage` in the real `StepPageFrame`,
 * no daemon, no network. Every name below is made up. The two screens the start buttons go to are given by a fake
 * address table, so the "Start with" section is drawn as it is in the shell.
 *
 *   ?theme=<family>-<mode>
 *   ?case=later|clean|device|bare
 *            later = some of everything set up and three things left for later; clean = all set up, nothing skipped;
 *            device = only this device's own pages; bare = no start button (both screens' plugins paused)
 */
import { ScreenHrefProvider } from '@ferretry/app';
import { LivingBackground } from '@ferretry/app/ui';
import { createRoot } from 'react-dom/client';
import { EndPage } from '../../../../app/features/setup-flow/end-page.tsx';
import type { SummaryStep } from '../../../../app/views/steps-screen.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const scene = params.get('case') ?? 'later';

const machine = (plugin: string, group: string, state: SummaryStep['state']): SummaryStep => ({
  plugin,
  group,
  id: plugin,
  title: group,
  state,
});
const device = (id: string, title: string, state: SummaryStep['state']): SummaryStep => ({
  plugin: 'access',
  group: 'This device',
  id,
  title,
  state,
  phase: 'client',
});

const STEPS: Record<string, readonly SummaryStep[]> = {
  later: [
    machine('onboarding', 'Machine', 'done'),
    machine('runtimes', 'Runtimes', 'done'),
    machine('logins', 'Logins', 'found'),
    machine('claude-code', 'Claude Code', 'done'),
    machine('voice', 'Voice', 'later'),
    machine('warden', 'Warden', 'skipped'),
    machine('lessons', 'Lessons', 'later'),
    device('passkey', 'Passkey', 'done'),
  ],
  clean: [
    machine('onboarding', 'Machine', 'done'),
    machine('runtimes', 'Runtimes', 'done'),
    machine('logins', 'Logins', 'found'),
  ],
  device: [device('passkey', 'Passkey', 'done')],
  bare: [machine('runtimes', 'Runtimes', 'done'), machine('voice', 'Voice', 'later')],
};

const noop = (): void => undefined;
const href = (_daemon: string, plugin: string, screen: string): string | undefined =>
  scene === 'bare' ? undefined : `/d/studio-mac/${plugin}/${screen}`;

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <ScreenHrefProvider href={href}>
      <div className="fy-sf-root" data-scene-ready="">
        <LivingBackground />
        <EndPage daemon="studio-mac" onBack={noop} summary={STEPS[scene] ?? STEPS['later'] ?? []} />
      </div>
    </ScreenHrefProvider>,
  );
