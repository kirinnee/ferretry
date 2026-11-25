/**
 * The browser entry for Settings › Updates over fixed fake data. No network.
 *
 *   ?theme=<family>-<mode>&app=<version>   (no `app`: the page cannot say which build it runs)
 */

import { createRoot } from 'react-dom/client';
import { DaemonUpdateViewSchema, planUpdate } from '../../../../contract/index.ts';
import { UpdatesView } from '../../../../app/views/updates-settings.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const standalone = { kind: 'standalone', directory: '/opt/ferretry' } as const;
const view = DaemonUpdateViewSchema.parse({
  current: '4.28.0',
  method: standalone,
  plan: planUpdate(standalone, { product: 'ferretry', clientName: 'fy' }),
  check: {
    state: 'ok',
    checkedAt: '2026-10-18T09:00:00.000Z',
    latest: { version: '4.29.0', url: 'https://github.com/kirinnee/ferretry/releases/tag/v4.29.0' },
  },
  available: true,
  midTurn: 0,
  autoInstall: false,
  job: null,
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <div style={{ padding: 16 }}>
    <UpdatesView
      view={view}
      appVersion={params.get('app') ?? undefined}
      note={null}
      readError={null}
      onStart={() => {}}
      onAutoInstall={() => {}}
    />
  </div>,
);
document.body.dataset.scene = 'ready';
