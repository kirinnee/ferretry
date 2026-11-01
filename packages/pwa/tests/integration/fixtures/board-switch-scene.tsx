/**
 * The browser entry for "Use the board" (docs/board.md § The board is opt-in): the REAL
 * `ProjectBoardSwitch` on the project page's Board panel, over a client that answers in memory — one board
 * the opt-in migration switched off, one the owner switched on, a machine from before the switch, and a
 * change the machine refuses. Nothing here reads a network.
 *
 * Parameters (all optional):
 *
 *   ?theme=<family>-<mode>
 */

import type { BoardSwitch } from '@ferretry/protocol';
import { KanbanSquare } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import { ProjectBoardSwitch } from '../../../src/features/projects/project-board-switch.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const daemon = daemonConnection({ daemonId: 'daemon-board', baseUrl: 'https://board.invalid', deviceId: 'd' });
const AT = '2026-11-01T12:00:00.000Z';

/** A client over one board's switch: `refuse` answers every change with the owner-only refusal. */
const clientFor = (projectId: string, first: BoardSwitch | 'missing', refuse = false) => {
  let current = first;
  return async () => ({
    request: (async (_path: string, schema: { parse(value: unknown): unknown }, init?: RequestInit) => {
      if (current === 'missing') throw Object.assign(new Error('not found'), { status: 404 });
      if (init?.method === 'PUT') {
        if (refuse)
          throw Object.assign(
            new Error('Only the owner switches a board on or off. Ask them first, as one agenda yes/no.'),
            { status: 403 },
          );
        const { on } = JSON.parse(String(init.body)) as { on: boolean };
        current = { projectId, on, setBy: 'owner', setAt: AT };
      }
      return schema.parse(current);
    }) as never,
  });
};

const PANELS = [
  {
    name: 'ratchet',
    client: clientFor('11111111-1111-4111-8111-111111111111', {
      projectId: '11111111-1111-4111-8111-111111111111',
      on: false,
      setBy: 'migration',
      setAt: AT,
    }),
  },
  {
    name: 'ferretry',
    client: clientFor('22222222-2222-4222-8222-222222222222', {
      projectId: '22222222-2222-4222-8222-222222222222',
      on: true,
      setBy: 'owner',
      setAt: AT,
    }),
  },
  { name: 'old-machine', client: clientFor('33333333-3333-4333-8333-333333333333', 'missing') },
  {
    name: 'refused',
    client: clientFor(
      '44444444-4444-4444-8444-444444444444',
      { projectId: '44444444-4444-4444-8444-444444444444', on: false, setBy: 'default', setAt: null },
      true,
    ),
  },
] as const;

function Scene() {
  return (
    <main className="grid content-start gap-panel p-panel" style={{ maxWidth: 520 }}>
      {PANELS.map(panel => (
        <section key={panel.name} className="kt-panel grid gap-sm p-panel" aria-label="Board" data-scene={panel.name}>
          <h2 className="m-0 flex items-center gap-xs text-title font-semibold text-fg">
            <KanbanSquare className="text-muted" size={16} aria-hidden="true" />
            Board — {panel.name}
          </h2>
          <ProjectBoardSwitch connection={daemon} projectId={panel.name} createClient={panel.client} />
        </section>
      ))}
    </main>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Scene />);
