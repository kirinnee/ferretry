/**
 * The browser entry for the LAST PAGE ("You're set up") over FAKE data: the real `EndPage` in the real `StepPageFrame`,
 * no daemon, no network. Every name below is made up. The two screens the start buttons go to are given by a fake
 * address table, so the "Start with" section is drawn as it is in the shell.
 *
 *   ?theme=<family>-<mode>
 *   ?case=later|clean|device|bare
 *            later = some of everything set up, one segment set up in part (Claude Code: one page left), three skipped
 *            on the machine and one on this device; clean = all set up, nothing skipped;
 *            device = only this device's own pages; bare = no start button (both screens' plugins paused)
 *   &opens=1   project setup registered a project (C59 O8-13): the way on is "Open Atlas" (a project), not the machine
 *   &picture=none   Access places no panel in `onboarding.end` (it is off): the page has no picture column
 *
 * The picture is a STAND-IN with the real ferret's box (240 x 190, `.fy-ferret`): Onboarding imports nothing of Access, so
 * the REAL ferret on this page is proved by Access's own test (`end-mascot-panel.test.tsx`, `mascot-offer.visual.test.ts`).
 */
import { ScreenHrefProvider } from '@ferretry/app';
import { LivingBackground } from '@ferretry/app/ui';
import { createRoot } from 'react-dom/client';
import '../../../../app/features/setup-flow/flow.css';
import { EndPage } from '../../../../app/features/setup-flow/end-page.tsx';
import type { SummaryStep } from '../../../../app/views/steps-screen.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const scene = params.get('case') ?? 'later';

const machine = (plugin: string, group: string, state: SummaryStep['state'], id = plugin): SummaryStep => ({
  plugin,
  group,
  id,
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
    machine('claude-code', 'Claude Code', 'later', 'permission'),
    machine('voice', 'Voice', 'later'),
    machine('warden', 'Warden', 'skipped'),
    machine('lessons', 'Lessons', 'later'),
    device('passkey', 'Passkey', 'done'),
    device('layout', 'Layout', 'later'),
  ],
  // The owner's QA walk (S-54): a long checklist with two harnesses partly set up, so the page is taller than 900px.
  long: [
    machine('onboarding', 'Machine', 'done'),
    machine('runtimes', 'Runtimes', 'done'),
    machine('claude-code', 'Claude Code', 'done'),
    machine('claude-code', 'Claude Code', 'later', 'permission'),
    machine('codex', 'Codex', 'done'),
    machine('codex', 'Codex', 'later', 'permission'),
    machine('warden', 'Warden', 'done'),
    machine('lessons', 'Lessons', 'done'),
    device('appearance', 'Appearance', 'done'),
    device('layout', 'Layout', 'done'),
    device('voice', 'Voice', 'done'),
    device('speedups', 'Speed-ups', 'done'),
    device('projects', 'Add your projects', 'done'),
    device('github', 'Connect GitHub', 'later'),
  ],
  clean: [
    machine('onboarding', 'Machine', 'done'),
    machine('runtimes', 'Runtimes', 'done'),
    machine('logins', 'Logins', 'found'),
  ],
  // A Codex whose sign-in was left for later: the machine has no runtime, so Runtimes is left for later too (it is not ticked).
  norun: [
    machine('onboarding', 'Machine', 'done'),
    machine('runtimes', 'Runtimes', 'later'),
    machine('codex', 'Codex', 'done'),
    machine('lessons', 'Lessons', 'done'),
    device('appearance', 'Appearance', 'done'),
    device('layout', 'Layout', 'done'),
  ],
  device: [device('passkey', 'Passkey', 'done')],
  bare: [machine('runtimes', 'Runtimes', 'done'), machine('voice', 'Voice', 'later')],
};

const noop = (): void => undefined;
const StandIn = () => (
  <svg
    role="img"
    viewBox="0 0 240 190"
    className="fy-ferret"
    data-stand-in=""
    aria-hidden="true"
    style={{ display: 'block', width: '100%' }}
  >
    <title>stand-in</title>
    <circle cx="120" cy="95" r="80" fill="currentColor" opacity="0.4" />
  </svg>
);
const PICTURE =
  params.get('picture') === 'none' ? null : (
    <div data-panel="access.end-mascot">
      <StandIn />
    </div>
  );
const href = (_daemon: string, plugin: string, screen: string): string | undefined =>
  scene === 'bare' ? undefined : `/d/studio-mac/${plugin}/${screen}`;

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <ScreenHrefProvider href={href}>
      {/* The real shell draws a chrome-less screen inside a fixed box whose main area scrolls (the sticky footer rests on it). */}
      <div style={{ bottom: 0, display: 'flex', left: 0, position: 'fixed', right: 0, top: 0 }} data-scene-frame="">
        <main
          style={{ flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto', position: 'relative' }}
          data-scene-main=""
        >
          <div className="fy-sf-root" data-scene-ready="">
            <LivingBackground />
            <EndPage
              daemon="studio-mac"
              {...(params.get('opens') === '1'
                ? { opens: { label: 'Open Atlas', href: '/d/studio-mac/projects/atlas' } }
                : {})}
              onBack={noop}
              summary={STEPS[scene] ?? STEPS.later ?? []}
              picture={PICTURE}
            />
          </div>
        </main>
      </div>
    </ScreenHrefProvider>,
  );
