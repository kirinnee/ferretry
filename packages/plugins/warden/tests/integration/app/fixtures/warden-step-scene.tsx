/**
 * The Warden's first-run page over fake data: the page itself, under a stand-in for the setup flow's title and progress
 * line (the shell draws those; this scene only gives the page something to sit under). `?theme=`, `?key=` (set | missing |
 * not_named | off) pick the state; the test clicks a card.
 */
import { createRoot } from 'react-dom/client';
import { WardenStepPage, type WardenStepDeps } from '../../../../app/features/onboarding/warden-step-page.tsx';
import type { WardenConfig } from '../../../../app/wire.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const key = params.get('key') ?? 'missing';

const config = {
  enabled: true,
  layers: { jev: false, llm: false },
  accounts: [],
} as unknown as WardenConfig;

const deps: WardenStepDeps = {
  client: {
    config: async () => ({ config, accounts: [], warnings: [], jevKey: key === 'not_named' ? 'not_named' : 'named' }),
    updateConfig: async () => ({
      config,
      accounts: [],
      warnings: [],
      jevKey: key === 'not_named' ? 'not_named' : 'named',
    }),
    nameJevKey: async () => ({ config, accounts: [], warnings: [], jevKey: 'named' }),
  } as unknown as WardenStepDeps['client'],
  readFile: async () => ({ exists: false }),
  readKey: async () =>
    key === 'off'
      ? 'off'
      : {
          vault: 'ok',
          providers: [
            {
              provider: 'jev',
              label: 'Jev',
              purpose: 'Triage.',
              costNote: 'Cheap.',
              privacyNote: 'A summary.',
              keyUrl: 'https://keys.example.test/',
              testNote: 'One decision.',
              secretName: 'JEV_API_KEY',
              set: key === 'set' || key === 'not_named',
              testStale: false,
            },
          ],
        },
};

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <main style={{ padding: 16, maxWidth: 880, margin: '0 auto' }}>
      <p style={{ margin: 0, opacity: 0.7 }}>Warden · 1 of 1</p>
      <h1 style={{ margin: '4px 0 16px' }}>Let the Warden watch your ferrets?</h1>
      <WardenStepPage deps={deps} speedupsHref="/d/fake/settings/voice/speedups" />
    </main>,
  );
