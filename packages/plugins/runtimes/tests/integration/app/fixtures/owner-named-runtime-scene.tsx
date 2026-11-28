/**
 * The browser entry for "a runtime the owner named keeps its name" (E-296): the REAL Settings › Runtimes list over a scripted
 * machine (fake data only, no network). Three runtimes: one named by an import (`claude-default`, read in words), one the
 * owner typed (`claude-work`, shown as typed) and a Codex one.
 *
 *   ?style=<id>&palette=<id>&mode=light|dark      the look (default: studio / studio / light), written on <html> as the app does
 */
import { LivingBackground } from '@ferretry/app/ui';
import { createRoot } from 'react-dom/client';
import { RuntimesTab } from '../../../../app/features/fleet/runtimes/runtimes-tab.tsx';
import type { RuntimesClient } from '../../../../app/lib/client.ts';
import { RuntimeCatalogSchema } from '../../../../contract/index.ts';
import { DATA, machine, runtime } from '../../../unit/app/features/fleet/account-support.ts';

const params = new URLSearchParams(window.location.search);
const style = params.get('style') ?? 'studio';
const palette = params.get('palette') ?? 'studio';
const mode = params.get('mode') === 'dark' ? 'dark' : 'light';
const root = document.documentElement;
root.dataset.style = style;
root.dataset.palette = palette;
root.dataset.mode = mode;
root.dataset.theme = `${palette}-${mode}`;

const runtimes = RuntimeCatalogSchema.parse({
  format: 'present',
  runtimes: [
    runtime({ name: 'claude-default' }),
    runtime({ name: 'claude-work', namedByOwner: true, profile: 'Work' }),
    ...DATA.runtimes.runtimes.filter(entry => entry.name === 'codex-default'),
  ],
});

const answers: Record<string, unknown> = {
  'GET /v1/logins': DATA.credentials,
  'GET /v1/runtimes': runtimes,
  'GET /v1/runtimes/profiles': DATA.profiles,
  'GET /v1/runtimes/components': DATA.components,
  'GET /v1/runtimes/machine': machine(),
};

const client: RuntimesClient = {
  call: async <Answer,>(route: string): Promise<Answer> => {
    if (route in answers) return answers[route] as Answer;
    throw new Error(`the scene has no answer for ${route}`);
  },
};

const mount = document.getElementById('root');
if (mount === null) throw new Error('missing #root');
createRoot(mount).render(
  <div className="fy-sf-root" data-scene-ready="">
    <LivingBackground />
    <main style={{ margin: '0 auto', maxWidth: 720, padding: '12px 16px', position: 'relative' }}>
      <RuntimesTab
        client={client}
        machineName="studio-mac"
        machine={machine()}
        online
        checking={false}
        onRetry={() => undefined}
      />
    </main>
  </div>,
);
