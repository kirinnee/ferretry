/**
 * The browser entry for Settings › Pack mode over FAKE routes (no daemon, no secret): the real tab (`createSettings`), the
 * real adapter and the real stylesheet. `GET /v1/pack` and the kernel's configuration-file routes are answered here; a save
 * that raises Jev decides or a limit is HELD, as the daemon holds a loosening edit.
 *
 *   ?theme=<family>-<mode>
 */
import type { SettingsProps } from '@ferretry/kernel/manifest';
import type { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { createSettings } from '../../../../app/views/pack-settings.tsx';
import type { PacksClient } from '../../../../app/lib/client.ts';
import { OWNER_VIEW } from '../../../unit/support/pack.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

let text = '# yaml-language-server: $schema=schemas/packs.json\n# Pack mode on this machine\nenabled: true\n';
let etag = 'e1';

const client = {
  call: async (route: string, init?: { query?: Record<string, string>; body?: { text: string } }) => {
    if (route === 'GET /v1/pack') return OWNER_VIEW;
    if (route === 'GET /v1/config/file') return { path: 'packs.yaml', exists: true, text, etag };
    if (route === 'PUT /v1/config/file') {
      text = init?.body?.text ?? text;
      etag = `${etag}x`;
      return text.includes('decision: jev')
        ? {
            path: 'packs.yaml',
            etag,
            outcome: 'pending',
            pending: { path: 'packs.yaml', etag, changes: ['Jev decides which model each helper runs on'] },
          }
        : { path: 'packs.yaml', etag, outcome: 'applied' };
    }
    throw new Error(`no route ${route}`);
  },
} as unknown as PacksClient;

const Tab = createSettings(client) as unknown as ComponentType<SettingsProps>;
const root = document.getElementById('root');
if (root === null) throw new Error('no #root');
createRoot(root).render(
  <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4" data-scene-ready="">
    <Tab />
  </div>,
);
