/**
 * The browser entry for the Processes panel in a ferret's side column: the REAL `ProcessesSurface` inside the real
 * column markup (`.fy-slot[data-slot="ferret.side"] > .fy-panel`, as `PanelSlot` draws it) with plain stand-ins for the
 * panels around it. Every process, command and path is made up (`tests/support/app/session-processes.ts`).
 *
 * Parameters:
 *
 *   ?theme=<family>-<mode>
 *   ?phone=1     the phone's one-panel-at-a-time host: only Processes is shown
 */
import { createRoot } from 'react-dom/client';
import { daemonConnection, daemonSessionScope } from '../../../../app/shell.ts';
import { ProcessesSurface } from '../../../../app/features/workspace/processes-surface.tsx';
import { ALL_PROCESSES } from '../../../support/app/session-processes.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const phone = params.get('phone') === '1';

const connection = daemonConnection('scene-daemon');
const scope = daemonSessionScope(connection, 'agent-session');
const client = {
  call: async (): Promise<never> => {
    throw new Error('the scene reads no network');
  },
};

/** A panel the real column holds above or below Processes: only its height matters here. */
const stand = (id: string, height: number) => (
  <div
    key={id}
    className="fy-panel"
    data-panel={`stub.${id}`}
    data-phone-shown={undefined}
    style={{ border: '1px solid var(--border)', borderRadius: 6 }}
  >
    <section style={{ boxSizing: 'border-box', height, padding: 8 }}>
      <h3 style={{ margin: 0, fontSize: 13 }}>{id}</h3>
    </section>
  </div>
);

const processes = (
  <div
    key="processes"
    className="fy-panel"
    data-panel="terminals.processes"
    data-phone-shown={phone ? '' : undefined}
    role={phone ? 'tabpanel' : undefined}
  >
    <ProcessesSurface
      client={client}
      connection={connection}
      now={() => Date.parse('2026-10-29T12:00:00.000Z')}
      onOpenChange={() => undefined}
      openId={null}
      scope={scope}
      state={{ status: 'ready', list: ALL_PROCESSES }}
    />
  </div>
);

createRoot(document.getElementById('root') as HTMLElement).render(
  <div style={{ display: 'flex', height: '100vh' }}>
    {phone ? null : <div style={{ flex: '1 1 0', minWidth: 0 }} />}
    <div
      className="fy-slot"
      data-phone-active={phone ? 'terminals.processes' : undefined}
      data-slot="ferret.side"
      style={{ background: 'var(--bg)' }}
    >
      {phone
        ? [processes]
        : [
            stand('agenda', 130),
            stand('queue', 90),
            stand('tasks', 120),
            stand('terminals', 160),
            stand('console', 240),
            processes,
            stand('browser', 140),
            stand('files', 200),
          ]}
    </div>
  </div>,
);
