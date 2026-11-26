/**
 * Browser entry for E-266 on the FERRETS side: the REAL `NewFerretPage` over a daemon that answers a start with the
 * "Started without Fast" notice. Every call lands on `window.__calls`, every navigation on `window.__navigated`. No
 * network.
 *
 *   ?theme=<palette>-<mode>
 */
import { createRoot } from 'react-dom/client';
import type { FerretsClient } from '../../../../app/lib/client.ts';
import { NewFerretPage } from '../../../../app/features/new-ferret/new-ferret-page.tsx';
import { useFerretActions } from '../../../../app/features/header/use-ferret-actions.tsx';
import { ActionToast } from '../../../../app/features/header/action-toast.tsx';
import { FerretLifecycle } from '../../../../app/features/header/status-panel.tsx';
import { FerretSummarySchema } from '../../../../contract/index.ts';
import restartResponse from '../../../fixtures/restart-downgrade-response.json';
import type { LiveFerretsClient } from '../../../../app/lib/client.ts';
import '../../../../app/features/header/ferret-actions.css';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NOTICE = 'Started without Fast: Codex’s model list is still loading; try again in a few seconds';
const ferret = FerretSummarySchema.parse({
  id: 'wren',
  name: 'wren',
  role: 'lead',
  harness: 'codex',
  runner: 'tmux',
  runtime: 'codex-auto',
  folder: '/work/a',
  state: 'stopped',
  createdAt: '2026-11-26T00:00:00.000Z',
  stateAt: '2026-11-26T00:00:00.000Z',
});
const win = window as unknown as { __calls: string[]; __navigated: string[] };
win.__calls = [];
win.__navigated = [];

const client: FerretsClient = {
  call: async <Answer,>(route: string): Promise<Answer> => {
    win.__calls.push(route);
    if (route === 'GET /v1/ferrets') return [] as Answer;
    if (route === 'POST /v1/ferrets') return { id: 'new-ferret', notice: NOTICE } as Answer;
    if (route === 'POST /v1/ferrets/:ferretId/resume') return { id: ferret.id, notice: NOTICE } as Answer;
    // The daemon's own Restart answer, pinned by tests/unit/daemon/ferrets/fast-fallback-relaunch.test.ts.
    if (route === 'POST /v1/ferrets/:ferretId/move') return restartResponse as Answer;
    throw new Error(`no route ${route}`);
  },
} as FerretsClient;

function RelaunchScene() {
  const actions = useFerretActions(client as LiveFerretsClient, ferret, async () => undefined);
  const restart = params.get('scene') === 'restart';
  if (params.get('scene') === 'toolbar')
    return (
      <main className="p-4">
        <h1 className="text-title font-semibold">Wren</h1>
        <FerretLifecycle
          client={client}
          ferret={ferret}
          reload={async () => undefined}
          compact={window.innerWidth < 600}
        />
      </main>
    );
  return (
    <main className="p-4">
      <h1 className="text-title font-semibold">Wren</h1>
      <p className="my-4">{restart ? 'Restart Wren on the current login.' : 'Resume Wren’s conversation.'}</p>
      <button
        className="kt-button"
        type="button"
        onClick={() => void (restart ? actions.context.restart() : actions.context.resume())}
      >
        {restart ? 'Restart' : 'Resume'}
      </button>
      <ActionToast notice={actions.notice} onDismiss={() => actions.setNotice(null)} dismissMs={60_000} />
    </main>
  );
}

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div data-scene-ready="">
      {params.has('scene') ? (
        <RelaunchScene />
      ) : (
        <NewFerretPage
          AccountSlot={({ fallback }) => fallback}
          client={client}
          daemon="fake"
          onNavigate={path => win.__navigated.push(path)}
        />
      )}
    </div>,
  );
