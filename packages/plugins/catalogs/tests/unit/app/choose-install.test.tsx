/** S10 — Install on /shared asks the shell which machine, and everything rides the machine the person picked. */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { ChosenDaemon, DaemonlessPorts } from '@ferretry/app';
import { ensureDom, mount } from '@ferretry/app/testing';
import { act, Suspense } from 'react';
import { NOT_PAIRED_NOTE } from '../../../app/features/shared/shared-screens-model.ts';
import { click, settle } from './support/dom-form.ts';
import { testSubscription } from './support/member-keys.ts';
import { okAttempt, sharedItemFixture } from './support/shared-screens.ts';
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

/** A paired list the test moves by hand: the one member `/shared` reads is the snapshot (and its subscription). */
function pairedPorts(count: number) {
  let current = { daemons: Array.from({ length: count }, (_, at) => ({ daemon: `d${at}` })), selected: null };
  const listeners = new Set<() => void>();
  const ports = {
    daemons: {
      snapshot: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as DaemonlessPorts;
  return {
    ports,
    pair: () => {
      current = { daemons: [{ daemon: 'd0' }], selected: null };
      for (const listener of [...listeners]) listener();
    },
  };
}

describe('S10 /shared', () => {
  const spies: { mockRestore: () => void }[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    document.body.replaceChildren();
  });

  /** `/shared` with one publisher sharing one item, opened to its sheet. */
  async function openedItem(ports: DaemonlessPorts) {
    const shared = await sharedItemFixture();
    const entry = shared.entries.find(candidate => candidate.itemId === shared.skill.itemId);
    if (entry === undefined) throw new Error('no entry');
    spies.push(
      spyOn(SharedController.prototype, 'list').mockResolvedValue([
        await testSubscription(`fy_daemon_${'q'.repeat(43)}`, { ownLabel: 'Studio' }),
      ]),
      spyOn(SharedController.prototype, 'browse').mockResolvedValue(okAttempt(shared.browse)),
      spyOn(SharedController.prototype, 'openItem').mockResolvedValue(
        okAttempt({ item: shared.skill, opened: shared.opened, entry }),
      ),
    );
    const Shared = createSharedScreen(ports);
    const view = await mount(
      <Suspense fallback={null}>
        <Shared params={{}} location={() => ''} navigate={() => undefined} chooseDaemon={async () => undefined} />
      </Suspense>,
    );
    await settle();
    return view;
  }
  const q = (selector: string) => document.body.querySelector<HTMLElement>(selector);

  it('m1 with no paired machine it says to pair one first, instead of offering Install', async () => {
    const view = await openedItem(pairedPorts(0).ports);
    expect(q('[data-shared-item-install]')).toBeNull();
    await click(q('[data-shared-item]'));
    expect(q('[data-shared-not-paired]')?.textContent).toBe(NOT_PAIRED_NOTE);
    expect(q('[data-shared-install-button]')).toBeNull();
    await view.unmount();
  });

  it('m1 with a paired machine it offers Install, and the note is gone', async () => {
    const view = await openedItem(pairedPorts(1).ports);
    expect(q('[data-shared-item-install]')).not.toBeNull();
    await click(q('[data-shared-item]'));
    expect(q('[data-shared-not-paired]')).toBeNull();
    expect(q('[data-shared-install-button]')).not.toBeNull();
    await view.unmount();
  });

  it('m1 a machine paired while the screen is open turns the note into Install', async () => {
    const paired = pairedPorts(0);
    const view = await openedItem(paired.ports);
    await click(q('[data-shared-item]'));
    expect(q('[data-shared-not-paired]')).not.toBeNull();
    await act(async () => paired.pair());
    expect(q('[data-shared-not-paired]')).toBeNull();
    expect(q('[data-shared-install-button]')).not.toBeNull();
    await view.unmount();
  });

  it('draws with the door to a machine and no machine of its own', async () => {
    spies.push(spyOn(SharedController.prototype, 'list').mockResolvedValue([]));
    const Shared = createSharedScreen(pairedPorts(1).ports);
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
