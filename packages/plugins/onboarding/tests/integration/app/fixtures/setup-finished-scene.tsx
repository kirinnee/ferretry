/**
 * The browser entry for the steps screen's closing summary, over fixed fake steps. No daemon, no network. Every name
 * below is made up.
 *
 *   ?view=finished   Every step answered: what was set up, and a Settings link for each step left for later or skipped
 *   ?view=waiting    One step still waits: no summary yet
 *   ?theme=<family>-<mode>
 */

import { createRoot } from 'react-dom/client';
import { SetupSummary } from '../../../../app/views/steps-screen.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const view = params.get('view') ?? 'finished';

const steps =
  view === 'finished'
    ? [
        { plugin: 'runtimes', id: 'start', title: 'Start from…', state: 'done' as const },
        { plugin: 'logins', id: 'login', title: 'Sign in', state: 'found' as const },
        { plugin: 'runtimes', id: 'runtimes', title: 'Name your runtimes', state: 'done' as const },
        { plugin: 'voice', id: 'voice', title: 'Voice', state: 'later' as const },
        { plugin: 'warden', id: 'warden', title: 'Warden', state: 'skipped' as const },
        { plugin: 'lessons', id: 'lessons', title: 'Lessons', state: 'later' as const },
      ]
    : [
        { plugin: 'runtimes', id: 'start', title: 'Start from…', state: 'done' as const },
        { plugin: 'logins', id: 'login', title: 'Sign in', state: 'pending' as const },
      ];

const root = document.getElementById('root') as HTMLElement;
root.className = 'mx-auto max-w-[560px] p-4';
root.dataset['scene'] = 'ready';
createRoot(root).render(<SetupSummary daemon="studio-mac" steps={steps} />);
