/**
 * The browser entry for the routing prompt card's "Your idea" text area: the REAL card with the first-run
 * nudge (`?view=nudge`, the default) or a saved prompt (`?view=owner`), every client a fake that answers from
 * memory. `?theme=<family>-<mode>` picks the theme; `window.__routingIdea.asked` records each Write it for me.
 */

import type { PackCleanUpRequest } from '@ferretry/protocol';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RoutingPromptCard } from '../../../src/features/pack/routing-prompt-card.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { IDLE_ROUTING_API, NUDGE_VIEW, OWNER_VIEW, WRITING_JOB } from '../../support/pack.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const STUDIO = daemonConnection({
  daemonId: `fy_daemon_${'st'.repeat(21)}A`,
  baseUrl: 'https://studio.example.test',
  deviceId: 'device-on-studio',
});

const control = { asked: [] as PackCleanUpRequest[] };
(window as unknown as { __routingIdea: typeof control }).__routingIdea = control;

const state = {
  ...IDLE_ROUTING_API,
  cleanUp: async (request: PackCleanUpRequest) => {
    control.asked.push(request);
    return { kind: 'started', job: WRITING_JOB } as const;
  },
  readJob: () => new Promise<never>(() => undefined),
};

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <main className="mx-auto flex max-w-[760px] flex-col gap-6 bg-bg p-4 text-fg">
      <RoutingPromptCard
        connection={STUDIO}
        view={params.get('view') === 'owner' ? OWNER_VIEW : NUDGE_VIEW}
        state={state}
      />
    </main>
  </StrictMode>,
);
