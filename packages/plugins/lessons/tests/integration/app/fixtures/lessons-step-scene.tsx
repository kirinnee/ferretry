/**
 * The browser entry for the first-run Lessons page, over a fake daemon: every answer is a fixed fake. No network.
 *
 *   ?view=page    the page as the setup flow draws it (neither card chosen)
 *   ?view=before  today's step body, the Settings › Lessons view
 *   ?theme=<family>-<mode>
 */

import { createRoot } from 'react-dom/client';
import { LessonsStep } from '../../../../app/features/onboarding/lessons-step.tsx';
import { LessonsSettingsSurface } from '../../../../app/src/lessons-settings.tsx';
import type { LessonsConnection } from '../../../../app/src/api.ts';
import { GLOBAL_LESSONS_DOCUMENT } from '../../../../contract/index.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const view = params.get('view') ?? 'page';

let passiveDefault = true;
const connection: LessonsConnection = {
  key: 'fake',
  client: {
    call: async <Value,>(route: string, init: { readonly body?: unknown } = {}): Promise<Value> => {
      if (route === 'PATCH /v1/lessons/config')
        passiveDefault = (init.body as { passiveDefault: boolean }).passiveDefault;
      const answers: Record<string, unknown> = {
        'GET /v1/lessons/ferrets': [
          { ferretId: 'ferret-hadi', passive: true, since: '2026-10-16T09:40:00.000Z', setBy: 'default' },
        ],
        'GET /v1/lessons/global': { name: GLOBAL_LESSONS_DOCUMENT, text: '', etag: 'absent', notes: [] },
      };
      return (answers[route] ?? {
        enabled: true,
        agent: 'claude-default',
        intervalMinutes: 60,
        batchSize: 10,
        maxMinersPerRun: 2,
        maxFerretsPerRun: 20,
        minSpawnGapMinutes: 5,
        passiveDefault,
      }) as Value;
    },
  },
};

const root = createRoot(document.getElementById('root') as HTMLElement);
root.render(
  view === 'before' ? (
    <div style={{ maxWidth: 880, margin: '0 auto', padding: 16 }}>
      <LessonsSettingsSurface connection={connection} />
    </div>
  ) : (
    <div style={{ maxWidth: 880, margin: '0 auto', padding: 16 }}>
      <LessonsStep connection={connection} />
    </div>
  ),
);
requestAnimationFrame(() => {
  document.body.dataset.scene = 'ready';
});
