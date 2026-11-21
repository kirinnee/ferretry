/**
 * The browser entry for "the runtime lists are the app's own SelectBox" (r11 S3e), over fake data and the REAL components:
 *
 *   ?scene=start     New ferret's runtime field: the real `new-ferret-account` panel (nine runtimes, five Claude and four
 *                    Codex, so the list is long enough for a search field) inside a start form that POSTs to the page's own
 *                    origin (`/v1/ferrets`), where the test's fake route records the exact request
 *   ?scene=default   Settings › Runtimes › "Default for new agents": the real Runtimes tab over a scripted machine; the
 *                    calls the tab makes are on `window.__calls`
 *   &theme=<family>-<mode>
 */
import { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ChosenFerretAccount } from '@ferretry/core-ferrets/contract';
import type { PanelProps } from '@ferretry/kernel/manifest';
import { RuntimesTab } from '../../../../app/features/fleet/runtimes/runtimes-tab.tsx';
import type { LiveRuntimesClient } from '../../../../app/lib/client.ts';
import { createNewFerretAccountPanel } from '../../../../app/views/account-picker-panels.tsx';
import {
  CHANGE_ID,
  COMMITTED,
  machine,
  READS,
  runtime,
  scripted,
  stagedFrom,
} from '../../../unit/app/features/fleet/account-support.ts';
import type { Call } from '../../../unit/app/support/client.ts';
import { loginList, loginView, runtimeCatalog, runtimeView } from '../../../unit/app/support/picker.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const scene = params.get('scene') ?? 'start';

const calls: Call[] = [];
(window as unknown as { __calls: Call[] }).__calls = calls;

const CLAUDE = ['claude-personal', 'claude-work', 'claude-review', 'claude-atomi', 'claude-sandbox'] as const;
const CODEX = ['codex-kirin', 'codex-team', 'codex-spare', 'codex-night'] as const;
const WRAPPERS = [...CLAUDE, ...CODEX];

function Start() {
  const client = {
    ...scripted(
      {
        'GET /v1/runtimes': runtimeCatalog(...WRAPPERS.map(wrapper => runtimeView({ wrapper }))),
        'GET /v1/logins': loginList(...WRAPPERS.map(wrapper => loginView(`login-${wrapper}`))),
      },
      calls,
    ),
    subscribe: () => () => undefined,
  } as unknown as LiveRuntimesClient;
  const [Panel] = useState(() => createNewFerretAccountPanel(client));
  const [value, setValue] = useState('');
  const [chosen, setChosen] = useState<ChosenFerretAccount | null>(null);
  const onChosen = useCallback((next: ChosenFerretAccount | null) => setChosen(next), []);
  const [started, setStarted] = useState('');
  const Slot = Panel as unknown as (props: PanelProps & Record<string, unknown>) => React.ReactNode;
  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        void fetch('/v1/ferrets', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ runtime: value, folder: '/work/project' }),
        }).then(() => setStarted(value));
      }}
      style={{ display: 'grid', gap: 12, margin: '0 auto', maxWidth: 560, padding: '16px' }}
    >
      <h1 style={{ fontSize: 20, margin: 0 }}>New ferret</h1>
      <label htmlFor="runtime-field" id="runtime-label" style={{ fontWeight: 600 }}>
        Runtime
      </label>
      <Slot
        fallbackId="runtime-field"
        fallbackPlaceholder="runtime"
        labelId="runtime-label"
        noAccounts={<p>No runtimes</p>}
        onChosen={onChosen}
        onValueChange={setValue}
        subject="new"
        value={value}
      />
      <p data-chosen="">{chosen === null ? 'none chosen' : `model: ${chosen.defaultModel ?? 'default'}`}</p>
      <button className="kt-btn" data-start="" type="submit">
        Start ferret
      </button>
      <p data-started="">{started === '' ? '' : `started on ${started}`}</p>
    </form>
  );
}

const defaults = WRAPPERS.map(name =>
  runtime({ name, agent: true, harness: name.startsWith('codex') ? 'codex' : 'claude-code' }),
);

function Default() {
  const shown = machine({ defaultRuntime: 'claude-personal' });
  const client = scripted(
    {
      ...READS(),
      'GET /v1/runtimes': { format: 'present', runtimes: defaults },
      'GET /v1/runtimes/machine': shown,
      'POST /v1/runtimes/proposals': stagedFrom,
      [`POST /v1/runtimes/proposals/${CHANGE_ID}/apply`]: COMMITTED,
    },
    calls,
  );
  return (
    <main style={{ margin: '0 auto', maxWidth: 720, padding: '12px 16px' }}>
      <RuntimesTab
        checking={false}
        client={client}
        machine={shown}
        machineName="studio-mac"
        onRefresh={() => undefined}
        onRetry={() => undefined}
        online
        pollMs={0}
      />
    </main>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(scene === 'default' ? <Default /> : <Start />);
