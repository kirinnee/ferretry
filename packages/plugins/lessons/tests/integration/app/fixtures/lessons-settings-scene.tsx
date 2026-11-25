/**
 * The browser entry for Settings › Lessons over a fake daemon: every answer is a fixed fake. No network.
 *
 *   ?theme=<family>-<mode>
 */

import { createRoot } from 'react-dom/client';
import { LessonsSettingsSurface } from '../../../../app/src/lessons-settings.tsx';
import type { LessonsConnection } from '../../../../app/src/api.ts';
import { GLOBAL_LESSONS_DOCUMENT } from '../../../../contract/index.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const AT = '2026-10-16T09:40:00.000Z';
const connection: LessonsConnection = {
  key: 'fake',
  client: {
    call: async <Value,>(route: string): Promise<Value> => {
      const answers: Record<string, unknown> = {
        'GET /v1/lessons/ferrets': [
          { ferretId: 'ferret-hadi', passive: true, since: AT, setBy: 'default' },
          { ferretId: 'ferret-mira', passive: false, since: AT, setBy: 'owner' },
          { ferretId: 'ferret-oden', passive: true, since: AT, setBy: 'default' },
          { ferretId: 'ferret-gone-4f2a9c1e77', name: 'zed', passive: false, since: AT, setBy: 'default' },
          { ferretId: 'ferret-gone-91b3d0aa42', passive: false, since: AT, setBy: 'default' },
        ],
        'GET /v1/lessons/global': {
          name: GLOBAL_LESSONS_DOCUMENT,
          text: '- Run every command through the project’s nix shell.\n- Keep replies short.\n- Never skip hooks.\n- Prefer bun scripts.\n- Cite cards by id.\n',
          etag: 'etag-1',
          notes: [],
        },
      };
      return (answers[route] ?? {
        enabled: true,
        agent: 'claude-default',
        intervalMinutes: 60,
        batchSize: 10,
        maxMinersPerRun: 2,
        maxFerretsPerRun: 20,
        minSpawnGapMinutes: 5,
        passiveDefault: true,
      }) as Value;
    },
  },
};

const ferrets = [
  { ferretId: 'ferret-hadi', name: 'hadi', folder: '/work/lathe' },
  { ferretId: 'ferret-mira', name: 'mira', folder: '/work/lathe' },
  { ferretId: 'ferret-oden', name: 'oden', folder: '/work/kiln' },
];

createRoot(document.getElementById('root') as HTMLElement).render(
  <div style={{ padding: 16 }}>
    <LessonsSettingsSurface connection={connection} ferrets={ferrets} />
  </div>,
);
// Ready once the ferret rows and the document have loaded.
const ready = (): void => {
  if (
    document.querySelector('[data-lessons-ferret]') !== null &&
    (document.querySelector('textarea')?.value ?? '') !== ''
  )
    document.body.dataset.scene = 'ready';
  else requestAnimationFrame(ready);
};
ready();
