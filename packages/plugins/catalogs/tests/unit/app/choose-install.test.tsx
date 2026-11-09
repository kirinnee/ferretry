/** S10 — Install on /shared asks the shell which machine, and everything rides the machine the person picked. */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { ChosenDaemon } from '@ferretry/app';
import { ensureDom, mount } from '@ferretry/app/testing';
import { Suspense } from 'react';
import { createSharedScreen } from '../../../app/views/catalogs-views.tsx';
import { SharedController } from '../../../app/features/shared/shared-controller.ts';
import { INSTALL_ON_WHICH, installChooser } from '../../../app/lib/choose-install.ts';

ensureDom();

const calls: string[] = [];
const picked: ChosenDaemon = {
  daemon: 'fy_daemon_beta',
  machine: 'Desk',
  client: {
    call: async (route: string) => {
      calls.push(route);
      return [
        {
          id: '6f8d5c1e-0b0a-4c55-9d6e-2f1a3b4c5d6e',
          name: 'ferretry',
          path: '/work/ferretry',
          source: 'existing-folder',
          createdAt: '2026-10-16T10:00:00.000Z',
        },
      ];
    },
  } as never,
};

describe('S10 installChooser', () => {
  it('asks the shell the one question and answers the picked machine with a host over ITS client', async () => {
    const asked: string[] = [];
    const choose = installChooser(async purpose => {
      asked.push(purpose);
      return picked;
    });
    const answer = await choose();
    expect(asked).toEqual([INSTALL_ON_WHICH]);
    expect(INSTALL_ON_WHICH).toBe('Install on which machine?');
    expect(answer?.machine.name).toBe('Desk');
    expect(String(answer?.machine.connection.daemonId)).toBe('fy_daemon_beta');
    expect(await answer?.host.readProjects?.(answer.machine.connection)).toEqual([
      { name: 'ferretry', path: '/work/ferretry' },
    ]);
    expect(calls).toEqual(['GET /v1/projects']);
    // The sheet's own client is Catalogs' wrapper over the picked client, never another machine's.
    const client = await answer?.host.createClient?.(answer.machine.connection);
    expect(typeof client?.request).toBe('function');
  });

  it('a cancel answers undefined and builds no host', async () => {
    expect(await installChooser(async () => undefined)()).toBeUndefined();
  });
});

describe('S10 /shared', () => {
  const spies: { mockRestore: () => void }[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  it('draws with the door to a machine and no machine of its own', async () => {
    spies.push(spyOn(SharedController.prototype, 'list').mockResolvedValue([]));
    const Shared = createSharedScreen();
    let asked = 0;
    const view = await mount(
      <Suspense fallback={null}>
        <Shared
          params={{}}
          location={() => ''}
          navigate={() => undefined}
          chooseDaemon={async () => {
            asked += 1;
            return undefined;
          }}
        />
      </Suspense>,
    );
    // Drawing asks nothing: only a press on Install does.
    expect(asked).toBe(0);
    expect(document.body.querySelector('[data-shared-empty]')).not.toBeNull();
    await view.unmount();
  });
});
