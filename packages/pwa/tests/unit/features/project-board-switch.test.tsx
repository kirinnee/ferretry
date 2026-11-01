import { afterEach, describe, expect, it } from 'bun:test';
import type { BoardSwitch } from '@ferretry/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  BoardSwitchView,
  ProjectBoardSwitch,
  switchProvenance,
} from '../../../src/features/projects/project-board-switch.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const AT = '2026-11-01T12:00:00.000Z';

const daemon = daemonConnection({
  daemonId: 'workstation',
  baseUrl: 'https://workstation.example.test',
  deviceId: 'device-token',
});

const state = (on: boolean, setBy: BoardSwitch['setBy'] = 'owner'): BoardSwitch => ({
  projectId: PROJECT_ID,
  on,
  setBy,
  setAt: setBy === 'default' ? null : AT,
});

interface Call {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
}

/** A client that answers the switch route from `answer`, recording each call. */
const clientFor = (answer: (call: Call) => BoardSwitch | Error) => {
  const calls: Call[] = [];
  const createClient = async () => ({
    request: (async (path: string, schema: { parse(value: unknown): unknown }, init?: RequestInit) => {
      const call: Call = {
        path,
        method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      calls.push(call);
      const value = answer(call);
      if (value instanceof Error) throw value;
      return schema.parse(value);
    }) as never,
  });
  return { calls, createClient };
};

const statusError = (status: number, message: string): Error => Object.assign(new Error(message), { status });

const settle = async (): Promise<void> => {
  await interact(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

let open: Mounted | null = null;
afterEach(async () => {
  await open?.unmount();
  open = null;
});

describe('BoardSwitchView', () => {
  it('should draw every state, and say what off means for a ferret', () => {
    const view = (loaded: Parameters<typeof BoardSwitchView>[0]['loaded'], refusal: string | null = null) =>
      renderToStaticMarkup(<BoardSwitchView loaded={loaded} busy={false} refusal={refusal} onChange={() => {}} />);

    expect(view({ kind: 'loading' })).toContain('data-project-board-switch="loading"');
    expect(view({ kind: 'missing' })).toContain('fy daemon update');
    expect(view({ kind: 'failed', reason: 'offline' })).toContain(
      'Could not read whether this project uses the board: offline.',
    );
    const off = view({ kind: 'read', state: state(false, 'default') });
    expect(off).toContain('aria-checked="false"');
    expect(off).toContain('Ferrets here make no card unless you ask for one, or their lead hands them one.');
    expect(off).toContain('Off by default.');
    const on = view({ kind: 'read', state: state(true) }, 'Only the owner switches a board on or off.');
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain('Use the board');
    expect(on).toContain('The switch did not change: Only the owner switches a board on or off.');
  });

  it('should say who decided', () => {
    expect(switchProvenance(state(true, 'owner'))).toBe('You set this.');
    expect(switchProvenance(state(true, 'migration'))).toContain(
      'because you sent a card back (Not good) in the last 14 days',
    );
    expect(switchProvenance(state(false, 'migration'))).toContain('you had sent no card back in the last 14 days');
    expect(switchProvenance(state(false, 'default'))).toBe('Off by default.');
  });
});

describe('ProjectBoardSwitch', () => {
  it("should read the project's switch and put the owner's change", async () => {
    let current = state(false, 'migration');
    const { calls, createClient } = clientFor(call => {
      if (call.method === 'PUT') current = state((call.body as { on: boolean }).on);
      return current;
    });

    open = await mount(<ProjectBoardSwitch connection={daemon} projectId={PROJECT_ID} createClient={createClient} />);
    await settle();
    const toggle = must(open.container.querySelector<HTMLButtonElement>('[role="switch"]'), 'the switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    await interact(() => toggle.click());
    await settle();

    expect(calls).toEqual([
      { path: `/v1/board/projects/${PROJECT_ID}/switch`, method: 'GET', body: undefined },
      { path: `/v1/board/projects/${PROJECT_ID}/switch`, method: 'PUT', body: { on: true } },
    ]);
    expect(must(open.container.querySelector('[role="switch"]'), 'the switch').getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(open.container.textContent).toContain('You set this.');
  });

  it('should keep the state and say why when the change is refused', async () => {
    const { createClient } = clientFor(call =>
      call.method === 'PUT' ? statusError(403, 'Only the owner switches a board on or off.') : state(true),
    );

    open = await mount(<ProjectBoardSwitch connection={daemon} projectId={PROJECT_ID} createClient={createClient} />);
    await settle();
    await interact(() => must(open?.container.querySelector<HTMLButtonElement>('[role="switch"]'), 'switch').click());
    await settle();

    expect(must(open.container.querySelector('[role="switch"]'), 'the switch').getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(open.container.textContent).toContain(
      'The switch did not change: Only the owner switches a board on or off.',
    );
  });

  it('should tell an old machine from a failed read', async () => {
    const old = clientFor(() => statusError(404, 'not found'));
    open = await mount(
      <ProjectBoardSwitch connection={daemon} projectId={PROJECT_ID} createClient={old.createClient} />,
    );
    await settle();
    expect(open.container.querySelector('[data-project-board-switch="missing"]')).not.toBeNull();
    await open.unmount();

    const broken = clientFor(() => statusError(503, 'the board switch is damaged and cannot be served'));
    open = await mount(
      <ProjectBoardSwitch connection={daemon} projectId={PROJECT_ID} createClient={broken.createClient} />,
    );
    await settle();
    expect(open.container.textContent).toContain('the board switch is damaged and cannot be served');
  });
});
